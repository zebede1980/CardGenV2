from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from typing import List, Optional
from pydantic import BaseModel
import asyncio
import json
import httpx
import base64
import urllib.parse
import uuid

from app.database import get_db, SessionLocal
from app import models, schemas
from app.services.llm_service import LLMService
from app.services.card_parser import extract_relevant_lorebook_entries
from app.routers.settings import get_or_create_settings
from app.routers.auth import get_current_user

router = APIRouter(prefix="/chats", tags=["chats"])

def get_default_system_prompt() -> str:
    """Builds the default system prompt modularly."""
    modules = [
        # Core Roleplay Rules
        "You are an expert roleplay AI. Your job is to portray the character(s) described in the provided cards, maintaining their distinct personalities, speech patterns, and backgrounds.",
        "Follow the user's lead and build upon their actions. You must NEVER speak, think, or dictate actions for the user.",
        # Rich UI Elements
        "RICH UI ELEMENTS:\nYou have the ability to embed rich graphical elements into the chat using specific XML tags. Use them when appropriate to enhance the immersion:",
        "- When a character sends a text message or phone chat, use: <text-message sender=\"Name\">message content</text-message>",
        "- When showing health, stamina, or numerical progress, use: <stat-bar name=\"Health\" value=\"80\" max=\"100\" />",
        "- When showing a text status, state, or location, use: <stat-bar name=\"Extraction\" value=\"In Progress\" />",
        "- When a new objective or quest is received, use: <task title=\"Objective Name\">Description of the task</task>",
        # 5-Phase Logic CoT
        "CHAIN OF THOUGHT (5-Phase Logic):\nBefore you write any roleplay dialogue or actions, you MUST process your reasoning within <think> and </think> tags. Inside these tags, you must strictly follow this 5-Phase Logic:\n1. Build Ground Truth: Establish the physical setting, time, and current reality.\n2. Map NPC Knowledge: Determine exactly what your character(s) know and don't know right now.\n3. Identify Intent: Decide the goal or motivation for this specific turn.\n4. Draft the Action/Dialogue: Plan what the character will do or say.\n5. Self-Correct: Review against character persona and constraints, adjusting if necessary to avoid repetition or breaking character.\n\nOnly after closing the </think> tag should you write the actual prose for the user."
    ]
    return "\n\n".join(modules)

def build_chat_prompt(chat: models.RoleplayChat, db: Session, speaker_name: str = None, max_input_tokens: int = None, enable_cot: bool = True):
    messages = []
    
    system_parts = []
    # 1. System Prompt
    if chat.system_prompt:
        system_parts.append(chat.system_prompt)
        
    cot_prompt = "CHAIN OF THOUGHT (5-Phase Logic):\nBefore you write any roleplay dialogue or actions, you MUST process your reasoning. You must wrap your entire reasoning process within <think> and </think> tags. Inside the <think> block, strictly follow this 5-Phase Logic:\n- Phase 1: Build Ground Truth (Establish the physical setting, time, and current reality)\n- Phase 2: Map NPC Knowledge (Determine exactly what your character(s) know and don't know right now)\n- Phase 3: Identify Intent (Decide the goal or motivation for this specific turn)\n- Phase 4: Draft the Action/Dialogue (Plan what the character will do or say)\n- Phase 5: Self-Correct (Review against character persona and constraints, adjusting if necessary to avoid repetition or breaking character)\n\nOnly after closing the </think> tag should you write the actual prose for the user."
    
    if chat.system_prompt and "CHAIN OF THOUGHT" not in chat.system_prompt:
        system_parts.append(cot_prompt)
    elif not chat.system_prompt:
        system_parts.append(cot_prompt)
        
    # User Persona
    if chat.user_persona_name:
        persona_str = f"User Persona:\nName: {chat.user_persona_name}"
        if chat.user_persona_age:
            persona_str += f"\nAge: {chat.user_persona_age}"
        if chat.user_persona_gender:
            persona_str += f"\nGender: {chat.user_persona_gender}"
        if chat.user_persona_detail:
            persona_str += f"\nDetails: {chat.user_persona_detail}"
        system_parts.append(persona_str)
        
    # Pre-calculate recent history text for lorebook extraction
    recent_history_text = " ".join([m.content for m in sorted(chat.messages, key=lambda m: m.created_at)[-5:]])

    # 2. Character Cards
    for card in chat.characters:
        card_text = f"Name: {card.name}\nDescription: {card.description}\nPersonality: {card.personality}\nScenario: {card.scenario}"
        
        if card.mes_example:
            card_text += f"\nExample Messages:\n{card.mes_example}"
            
        if card.character_book:
            relevant_lore = extract_relevant_lorebook_entries(card.character_book, recent_history_text)
            if relevant_lore:
                card_text += "\nLorebook:\n" + "\n".join(relevant_lore)
                
        system_parts.append(f"Character: {card.name}\n{card_text}")
        
    # 3. Dynamic Memory & Summary
    if chat.summary:
        system_parts.append(f"Story Summary:\n{chat.summary}")
        
    active_memories = db.query(models.ChatMemory).filter(
        models.ChatMemory.chat_id == chat.id,
        models.ChatMemory.is_active == True
    ).order_by(models.ChatMemory.created_at.asc()).all()
    if active_memories:
        facts = "\n".join([f"- {m.fact}" for m in active_memories])
        system_parts.append(f"Important Facts:\n{facts}")
        
    if system_parts:
        messages.append({"role": "system", "content": "\n\n".join(system_parts)})
        
    # 4. Chat History
    import re as _re
    _scene_image_re = _re.compile(r'\s*<scene-image\s+[^>]*/?>\s*|</scene-image>\s*', _re.IGNORECASE)
    history_messages = []
    for msg in sorted(chat.messages, key=lambda m: m.created_at):
        if msg.is_summarized:
            continue
        if not msg.content and msg.role == "assistant":
            continue
        content = msg.content
        # Strip <scene-image> tags (contain base64 data URIs) — they bloat the context
        # and confuse LLM providers. The visual content is for the user, not the AI.
        content = _scene_image_re.sub('', content).strip()
        if not content and msg.role == "assistant":
            continue  # skip messages that were only a scene image
        if msg.ooc_note:
            if content:
                content += f"\n\n[OOC Note to AI: {msg.ooc_note}]"
            else:
                content = f"[OOC Note to AI: {msg.ooc_note}]"
            
        # If it's a group chat, prefix assistant messages with their name
        if msg.role == "assistant" and msg.character_name and len(chat.characters) > 1:
            content = f"{msg.character_name}: {content}"
            
        history_messages.append({"role": msg.role, "content": content})
        
    # 5. Truncate history to fit within max_input_tokens if provided
    if max_input_tokens:
        def estimate_tokens(msg_list):
            return sum(len(m.get("content", "")) // 4 for m in msg_list)
            
        system_tokens = estimate_tokens(messages)
        # Always keep at least the very last message
        while history_messages and (estimate_tokens(history_messages) + system_tokens > max_input_tokens) and len(history_messages) > 1:
            history_messages.pop(0)
            
    messages.extend(history_messages)
    
    post_history_parts = []
    for card in chat.characters:
        if card.post_history_instructions:
            post_history_parts.append(f"[{card.name} Note]: {card.post_history_instructions}")
            
    if post_history_parts:
        messages.append({"role": "system", "content": "\n\n".join(post_history_parts)})
    
    if enable_cot:
        if speaker_name and len(chat.characters) > 1:
            messages.append({"role": "system", "content": f"Write the next reply from the perspective of {speaker_name}. Do NOT output '{speaker_name}:' at the start of your message. You MUST start your response with <think> to process your 5-Phase Logic, and only write the dialogue/actions after closing the </think> tag."})
        elif "CHAIN OF THOUGHT" in "".join(system_parts):
            # Even for 1-on-1 chats, append a final reminder to ensure the LLM doesn't skip the CoT.
            messages.append({"role": "system", "content": "Reminder: You MUST start your response with <think> to process your 5-Phase Logic, and only write the dialogue/actions after closing the </think> tag."})
    else:
        if speaker_name and len(chat.characters) > 1:
            messages.append({"role": "system", "content": f"Write the next reply from the perspective of {speaker_name}. Do NOT output '{speaker_name}:' at the start of your message."})
        
    return messages

async def summarize_chat_task(chat_id: str, user_id: int):
    with SessionLocal() as bg_db:
        chat = bg_db.query(models.RoleplayChat).filter(
            models.RoleplayChat.id == chat_id,
            models.RoleplayChat.user_id == str(user_id)
        ).first()
        if not chat: return
        
        settings = get_or_create_settings(bg_db, user_id)
        
        unsummarized = bg_db.query(models.ChatMessage).filter(
            models.ChatMessage.chat_id == chat_id,
            models.ChatMessage.is_summarized == False
        ).order_by(models.ChatMessage.created_at.asc()).all()
        
        trigger_limit = settings.summary_threshold * 10  # default 100
        keep_recent = settings.summary_threshold * 5    # default 50
        
        if len(unsummarized) <= trigger_limit:
            return
            
        to_summarize = unsummarized[:-keep_recent]
        
        text_parts = []
        for m in to_summarize:
            name = m.character_name or ("User" if m.role == "user" else "Assistant")
            text_parts.append(f"{name}: {m.content}")
        combined_text = "\n".join(text_parts)
        
        prompt = (
            "Write a detailed and comprehensive summary of the following chat history. "
            "It is crucial to retain important context, key dialogue moments, decisions, and character developments and personality. "
            "Do NOT summarize too aggressively—preserving the rich context of the story is more important than brevity. "
            "Keep the final summary well-organized, using paragraphs or bullet points to track the narrative flow."
        )
        if chat.summary:
            prompt += f"\n\nIncorporate the new history into the existing summary seamlessly.\n\nExisting Summary:\n{chat.summary}\n\nNew History to add:\n{combined_text}"
        else:
            prompt += f"\n\nChat History:\n{combined_text}"
            
        llm = LLMService(settings)
        try:
            messages = [
                {"role": "system", "content": "You are a helpful assistant that summarizes roleplay narratives."},
                {"role": "user", "content": prompt}
            ]
            
            content_parts = []
            async for chunk in llm.generate(messages, stream=True):
                content_parts.append(chunk)
            
            chat.summary = "".join(content_parts)
            for m in to_summarize:
                m.is_summarized = True
            bg_db.commit()
        except Exception as e:
            print(f"Summarization error: {e}")
        finally:
            await llm.close()

async def extract_chat_memory_task(chat_id: str, user_id: int):
    with SessionLocal() as bg_db:
        chat = bg_db.query(models.RoleplayChat).filter(
            models.RoleplayChat.id == chat_id,
            models.RoleplayChat.user_id == str(user_id)
        ).first()
        if not chat: return
        
        settings = get_or_create_settings(bg_db, user_id)
        
        unextracted = bg_db.query(models.ChatMessage).filter(
            models.ChatMessage.chat_id == chat_id,
            models.ChatMessage.is_extracted == False,
            models.ChatMessage.content != "" 
        ).order_by(models.ChatMessage.created_at.asc()).all()
        
        trigger_limit = 10  # Extract every 10 messages
        
        if len(unextracted) < trigger_limit:
            return
            
        text_parts = []
        for m in unextracted:
            name = m.character_name or ("User" if m.role == "user" else "Assistant")
            text_parts.append(f"{name}: {m.content}")
        combined_text = "\n".join(text_parts)
        
        active_memories = bg_db.query(models.ChatMemory).filter(
            models.ChatMemory.chat_id == chat_id,
            models.ChatMemory.is_active == True
        ).all()
        
        existing_facts_text = "\n".join([f"- {m.fact}" for m in active_memories]) if active_memories else "None."
        
        prompt = (
            "You are managing a dynamic 'Memory Book' (encyclopedia) of permanent facts for a roleplay.\n"
            "Review the 'New Chat History' and update the 'Current Facts' accordingly.\n\n"
            "RULES:\n"
            "1. Add new permanent facts (e.g., items acquired/lost, physical changes, major relationship shifts, key locations).\n"
            "2. Update or remove any existing facts that are now obsolete or contradicted.\n"
            "3. Ignore minor conversation details, feelings, or temporary states.\n"
            "4. You MUST output the COMPLETE, fully updated list of facts, each on a new line starting with a dash (-). "
            "If no changes are needed, simply output the Current Facts exactly as they are.\n"
            f"\nCurrent Facts:\n{existing_facts_text}\n"
            f"\nNew Chat History:\n{combined_text}"
        )
            
        llm = LLMService(settings)
        try:
            messages = [
                {"role": "system", "content": "You are an AI data extractor. Maintain a concise list of permanent facts."},
                {"role": "user", "content": prompt}
            ]
            
            content_parts = []
            async for chunk in llm.generate(messages, stream=True):
                content_parts.append(chunk)
            
            full_response = "".join(content_parts).strip()
            if full_response:
                # Parse facts that start with a dash
                facts = [line.strip().lstrip('-').strip() for line in full_response.split('\n') if line.strip().startswith('-')]
                
                # Only update if we successfully parsed facts (avoids wiping memories if LLM gives a weird conversational response)
                if facts:
                    for m in active_memories:
                        m.is_active = False
                    
                    for fact in facts:
                        if fact:
                            new_memory = models.ChatMemory(
                                chat_id=chat_id,
                                fact=fact,
                                is_active=True
                            )
                            bg_db.add(new_memory)
                        
            for m in unextracted:
                m.is_extracted = True
            bg_db.commit()
        except Exception as e:
            print(f"Memory extraction error: {e}")
        finally:
            await llm.close()

@router.get("/", response_model=List[schemas.RoleplayChatOut])
def list_chats(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return db.query(models.RoleplayChat)\
        .filter(models.RoleplayChat.user_id == str(current_user.id))\
        .order_by(models.RoleplayChat.updated_at.desc())\
        .all()

@router.post("/", response_model=schemas.RoleplayChatDetailOut)
def create_chat(chat_in: schemas.RoleplayChatCreate, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    new_chat = models.RoleplayChat(
        user_id=str(current_user.id),
        title=chat_in.title,
        system_prompt=chat_in.system_prompt.strip() if chat_in.system_prompt else get_default_system_prompt(),
        user_persona_name=chat_in.user_persona_name,
        user_persona_age=chat_in.user_persona_age,
        user_persona_gender=chat_in.user_persona_gender,
        user_persona_detail=chat_in.user_persona_detail,
        user_persona_card_id=chat_in.user_persona_card_id
    )
    db.add(new_chat)
    db.flush() # Flush to get the new chat ID

    # Link selected characters to this new chat session
    for card_id in chat_in.card_ids:
        link = models.ChatCharacterLink(chat_id=new_chat.id, card_id=card_id)
        db.add(link)
        
    # If it's a single-character chat, auto-start with their first message
    if len(chat_in.card_ids) == 1:
        card = db.query(models.CharacterCard).filter(models.CharacterCard.id == chat_in.card_ids[0]).first()
        if card:
            # Parse alternate greetings if it's a JSON string
            alt_greetings = []
            if card.alternate_greetings:
                try:
                    alt_greetings = json.loads(card.alternate_greetings)
                except Exception:
                    alt_greetings = []
            
            msg_content = card.first_mes
            if chat_in.first_message_index is not None and chat_in.first_message_index >= 0:
                if alt_greetings and len(alt_greetings) > chat_in.first_message_index:
                    msg_content = alt_greetings[chat_in.first_message_index]
            
            if msg_content:
                first_msg = models.ChatMessage(
                    chat_id=new_chat.id,
                    role="assistant",
                    character_name=card.name,
                    content=msg_content
                )
                db.add(first_msg)

    db.commit()
    db.refresh(new_chat)
    return new_chat

@router.get("/{chat_id}", response_model=schemas.RoleplayChatDetailOut)
def get_chat(chat_id: str, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    chat = db.query(models.RoleplayChat).filter(models.RoleplayChat.id == chat_id, models.RoleplayChat.user_id == str(current_user.id)).first()
    if not chat:
        raise HTTPException(status_code=404, detail="Chat not found")
    return chat

@router.patch("/{chat_id}", response_model=schemas.RoleplayChatOut)
def update_chat(chat_id: str, chat_in: schemas.RoleplayChatUpdate, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    chat = db.query(models.RoleplayChat).filter(models.RoleplayChat.id == chat_id, models.RoleplayChat.user_id == str(current_user.id)).first()
    if not chat:
        raise HTTPException(status_code=404, detail="Chat not found")
    
    if chat_in.title is not None:
        chat.title = chat_in.title
    if chat_in.system_prompt is not None:
        chat.system_prompt = chat_in.system_prompt
        
    db.commit()
    db.refresh(chat)
    return chat

@router.delete("/{chat_id}")
def delete_chat(chat_id: str, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    chat = db.query(models.RoleplayChat).filter(models.RoleplayChat.id == chat_id, models.RoleplayChat.user_id == str(current_user.id)).first()
    if not chat:
        raise HTTPException(status_code=404, detail="Chat not found")
    db.delete(chat)
    db.commit()
    return {"success": True}

@router.patch("/{chat_id}/messages/{message_id}", response_model=schemas.ChatMessageOut)
def update_chat_message(chat_id: str, message_id: str, msg_in: schemas.ChatMessageUpdate, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    chat = db.query(models.RoleplayChat).filter(models.RoleplayChat.id == chat_id, models.RoleplayChat.user_id == str(current_user.id)).first()
    if not chat:
        raise HTTPException(status_code=404, detail="Chat not found")
    msg = db.query(models.ChatMessage).filter(models.ChatMessage.id == message_id, models.ChatMessage.chat_id == chat_id).first()
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found")
    
    msg.content = msg_in.content
    db.commit()
    db.refresh(msg)
    return msg

@router.delete("/{chat_id}/messages/{message_id}")
def delete_chat_message(chat_id: str, message_id: str, truncate: bool = False, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    chat = db.query(models.RoleplayChat).filter(models.RoleplayChat.id == chat_id, models.RoleplayChat.user_id == str(current_user.id)).first()
    if not chat:
        raise HTTPException(status_code=404, detail="Chat not found")
    msg = db.query(models.ChatMessage).filter(models.ChatMessage.id == message_id, models.ChatMessage.chat_id == chat_id).first()
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found")
    
    if truncate:
        msgs_to_delete = db.query(models.ChatMessage).filter(
            models.ChatMessage.chat_id == chat_id,
            models.ChatMessage.created_at >= msg.created_at
        ).all()
        for m in msgs_to_delete:
            db.delete(m)
    else:
        db.delete(msg)
        
    db.commit()
    return {"success": True}

class ImageGenParams(BaseModel):
    base_url: Optional[str] = None
    api_key: Optional[str] = None
    model: Optional[str] = None
    size: Optional[str] = "1024x1024"

@router.post("/{chat_id}/messages/{message_id}/generate-image")
async def generate_scene_image(
    chat_id: str,
    message_id: str,
    params: ImageGenParams,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    chat = db.query(models.RoleplayChat).filter(models.RoleplayChat.id == chat_id, models.RoleplayChat.user_id == str(current_user.id)).first()
    if not chat:
        raise HTTPException(status_code=404, detail="Chat not found")
        
    target_message = db.query(models.ChatMessage).filter(models.ChatMessage.id == message_id, models.ChatMessage.chat_id == chat_id).first()
    if not target_message:
        raise HTTPException(status_code=404, detail="Message not found")
        
    # Get the target message and the 3 preceding messages for context window
    recent_messages = db.query(models.ChatMessage).filter(
        models.ChatMessage.chat_id == chat_id,
        models.ChatMessage.created_at <= target_message.created_at
    ).order_by(models.ChatMessage.created_at.desc()).limit(4).all()
    recent_messages.reverse()
    
    char_context = ""
    for c in chat.characters:
        char_context += f"Name: {c.name}\nAppearance & Style: {c.description}\n\n"
        
    system_prompt = (
        "You are an expert image prompt generator for Stable Diffusion/Midjourney. "
        "Write a highly descriptive, comma-separated image prompt that captures the current scene. "
        "Focus strictly on visual elements: character appearance, clothing, lighting, camera angle, action, and environment. "
        "If the User's appearance is unknown, use a First-Person Point of View (POV) looking at the other characters. "
        "Respond ONLY with the final prompt, no conversational filler."
    )
    
    user_prompt = f"CHARACTER DESCRIPTIONS:\n{char_context}"
    if chat.summary:
        user_prompt += f"SCENE SUMMARY:\n{chat.summary}\n\n"
        
    user_prompt += "RECENT CHAT HISTORY:\n"
    for msg in recent_messages:
        role = "AI" if msg.role == "assistant" else "User"
        name = msg.character_name if msg.character_name else role
        user_prompt += f"{name}: {msg.content}\n"
        
    user_prompt += "\nCreate a visually striking image prompt for the very last message in the history."
    
    settings = get_or_create_settings(db, current_user.id)
    if not settings.api_key:
        raise HTTPException(status_code=400, detail="API key not configured.")
        
    llm = LLMService(settings)
    try:
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ]
        content_parts = []
        async for chunk in llm.generate(messages, stream=False):
            content_parts.append(chunk)
        image_prompt = "".join(content_parts).strip()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"LLM Prompt Generation failed: {str(e)}")
    finally:
        await llm.close()
        
    async with httpx.AsyncClient(timeout=120.0) as client:
        if params.base_url and params.api_key:
            # Configured OpenAI-compatible API
            endpoint = params.base_url
            if not endpoint.endswith("/images/generations"):
                endpoint = f"{endpoint.rstrip('/')}/images/generations"
                
            headers = {
                "Authorization": f"Bearer {params.api_key}",
                "Content-Type": "application/json"
            }
            payload = {
                "prompt": image_prompt,
                "response_format": "b64_json",
                "size": params.size or "1024x1024"
            }
            if params.model:
                payload["model"] = params.model
                
            try:
                img_res = await client.post(endpoint, headers=headers, json=payload)
                img_res.raise_for_status()
                res_data = img_res.json()
                
                if "data" in res_data and len(res_data["data"]) > 0:
                    first_res = res_data["data"][0]
                    if "b64_json" in first_res and first_res["b64_json"]:
                        img_b64 = first_res["b64_json"]
                        image_url = f"data:image/png;base64,{img_b64}"
                    elif "url" in first_res and first_res["url"]:
                        # Fallback for APIs that ignore response_format
                        dl_res = await client.get(first_res["url"])
                        dl_res.raise_for_status()
                        img_b64 = base64.b64encode(dl_res.content).decode("utf-8")
                        mime_type = dl_res.headers.get("content-type", "image/png")
                        image_url = f"data:{mime_type};base64,{img_b64}"
                    else:
                        raise Exception("No image data found in response")
                else:
                    raise Exception("Invalid API response format")
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"Image API generation failed: {str(e)}")
        else:
            # Fallback to Pollinations directly
            encoded_prompt = urllib.parse.quote(image_prompt)
            pollinations_url = f"https://image.pollinations.ai/prompt/{encoded_prompt}?width=1024&height=768&nologo=true"
            if params.model:
                pollinations_url += f"&model={urllib.parse.quote(params.model)}"
                
            try:
                img_res = await client.get(pollinations_url)
                img_res.raise_for_status()
                
                img_b64 = base64.b64encode(img_res.content).decode("utf-8")
                mime_type = img_res.headers.get("content-type", "image/jpeg")
                image_url = f"data:{mime_type};base64,{img_b64}"
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"Pollinations generation failed: {str(e)}")
            
    xml_tag = f'\n\n<scene-image src="{image_url}" prompt="{image_prompt}"></scene-image>'
    target_message.content += xml_tag
    db.commit()
            
    return {
        "imageUrl": image_url,
        "prompt": image_prompt,
        "api_log": {
            "endpoint": "Generate Scene Image (Roleplay Chat)",
            "request": {"model": getattr(settings, 'model', 'unknown'), "messages": messages},
            "response": image_prompt
        }
    }

@router.post("/{chat_id}/message")
async def send_message(
    chat_id: str,
    req: schemas.SendMessageRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    chat = db.query(models.RoleplayChat).filter(
        models.RoleplayChat.id == chat_id, 
        models.RoleplayChat.user_id == str(current_user.id)
    ).first()
    if not chat:
        raise HTTPException(status_code=404, detail="Chat not found")
        
    settings = get_or_create_settings(db, current_user.id)
    if not settings.api_key:
        raise HTTPException(status_code=400, detail="API key not configured.")
        
    # Setup queue early to capture routing logs
    queue = asyncio.Queue()
        
    # Determine speaker
    speaker_name = req.character_name
    
    if not speaker_name and chat.characters:
        if len(chat.characters) == 1:
            speaker_name = chat.characters[0].name
        else:
            # Route to the most appropriate character
            history_text = ""
            recent_msgs = sorted(chat.messages, key=lambda m: m.created_at)[-5:]
            for m in recent_msgs:
                name = m.character_name or ("User" if m.role == "user" else "Assistant")
                history_text += f"{name}: {m.content}\n"
            if req.content:
                history_text += f"User: {req.content}"
            
            char_names = [c.name for c in chat.characters]
            route_prompt = (
                f"Based on the following chat history, which of these characters is most likely to speak next? "
                f"Options: {', '.join(char_names)}. "
                "Output ONLY the character's exact name, nothing else.\n\n"
                f"History:\n{history_text}"
            )
            
            llm = LLMService(settings)
            try:
                route_msgs = [
                    {"role": "system", "content": "You are a dialogue router."},
                    {"role": "user", "content": route_prompt}
                ]
                
                route_log_id = str(uuid.uuid4())
                queue.put_nowait({
                    "type": "api_log",
                    "log": {
                        "id": route_log_id,
                        "endpoint": "Chat Speaker Routing",
                        "request": {"model": getattr(settings, 'model', 'unknown'), "messages": route_msgs}
                    }
                })
                
                name_response = []
                async for chunk in llm.generate(route_msgs, stream=False):
                    name_response.append(chunk)
                
                chosen = "".join(name_response).strip()
                queue.put_nowait({
                    "type": "api_log",
                    "log": {
                        "id": route_log_id,
                        "endpoint": "Chat Speaker Routing",
                        "response": {
                            "choices": [{"message": {"content": chosen}}],
                            "usage": llm.last_usage
                        },
                        "usage": llm.last_usage
                    }
                })
                
                for cn in char_names:
                    if cn.lower() in chosen.lower():
                        speaker_name = cn
                        break
                if not speaker_name:
                    speaker_name = char_names[0]
            except Exception as e:
                print(f"Routing error: {e}")
                speaker_name = char_names[0]
            finally:
                await llm.close()

    # ── Impersonate Mode ────────────────────────────────────────────────────
    # In impersonate mode we DON'T save any messages to the DB.  We build a
    # prompt that uses the existing chat history as context but appends a
    # special instruction asking the LLM to write *as the user*, not as the
    # character.  The response is streamed back to the frontend which drops
    # it directly into the user's input field.
    if req.impersonate:
        # Build the normal context from existing history (no new user msg saved)
        prompt_messages = build_chat_prompt(chat, db, None, getattr(req, 'max_input_tokens', None), getattr(req, 'enable_cot', True))

        # Append the user's draft text (if any) as context, then the key instruction
        impersonate_instruction = (
            "IMPORTANT: Your next task is to write the USER's next message, not the AI character's reply. "
            "Write a natural, first-person response or action from the user's point of view. "
            "Do NOT speak or act as any of the characters in the scene. "
            "Keep it concise and in the style of what the user would realistically say or do next."
        )
        if req.content:
            impersonate_instruction = f"The user has provided this draft to work from: \"{req.content}\"\n\n" + impersonate_instruction
        if req.ooc_note:
            impersonate_instruction = f"Additional context: {req.ooc_note}\n\n" + impersonate_instruction

        prompt_messages.append({"role": "user", "content": impersonate_instruction})

        queue.put_nowait({"type": "metadata", "character_name": None, "character_card_id": None, "user_message_id": None, "assistant_message_id": None})

        gen_max_tokens = req.max_output_tokens
        gen_temperature = req.temperature
        gen_repetition_penalty = req.repetition_penalty

        async def impersonate_generate_task():
            llm = LLMService(settings)
            try:
                async for chunk in llm.generate(prompt_messages, stream=True, max_tokens=gen_max_tokens, temperature=gen_temperature, repetition_penalty=gen_repetition_penalty):
                    await queue.put(chunk)
                await queue.put(None)
            except Exception as e:
                await queue.put(e)
            finally:
                await llm.close()

        asyncio.create_task(impersonate_generate_task())

        async def sse_generator_imp():
            try:
                while True:
                    item = await queue.get()
                    if item is None:
                        break
                    if isinstance(item, Exception):
                        yield f"data: {json.dumps({'type': 'error', 'message': str(item)})}\n\n"
                        break
                    if isinstance(item, dict):
                        yield f"data: {json.dumps(item)}\n\n"
                        continue
                    yield f"data: {json.dumps({'type': 'chunk', 'content': item})}\n\n"
                yield f"data: {json.dumps({'type': 'done'})}\n\n"
            except asyncio.CancelledError:
                pass

        return StreamingResponse(sse_generator_imp(), media_type="text/event-stream")
    # ────────────────────────────────────────────────────────────────────────

    # 1. Save User Message
    user_msg = None
    if req.content or req.ooc_note:
        user_msg = models.ChatMessage(
            chat_id=chat_id,
            role="user",
            content=req.content,
            ooc_note=req.ooc_note
        )
        db.add(user_msg)
        db.commit()
    
    # 2. Build Prompt Context (Ensuring strict caching order)
    prompt_messages = build_chat_prompt(chat, db, speaker_name, getattr(req, 'max_input_tokens', None), getattr(req, 'enable_cot', True))
    
    # 3. Create Placeholder Assistant Message
    assistant_msg = models.ChatMessage(
        chat_id=chat_id,
        role="assistant",
        character_name=speaker_name,
        content=""
    )
    db.add(assistant_msg)
    db.commit()
    assistant_msg_id = assistant_msg.id
    
    # Find the matching card ID for the speaker (to help the UI load thumbnails)
    speaker_card_id = None
    if chat.characters:
        for c in chat.characters:
            if c.name == speaker_name:
                speaker_card_id = c.id
                break

    # 4. Setup Background Detached Generation & Queue
    gen_log_id = str(uuid.uuid4())
    queue.put_nowait({
        "type": "api_log",
        "log": {
            "id": gen_log_id,
            "endpoint": "Roleplay Chat Generation",
            "request": {"model": getattr(settings, 'model', 'unknown'), "messages": prompt_messages}
        }
    })
    
    queue.put_nowait({
        "type": "metadata", 
        "character_name": speaker_name,
        "character_card_id": speaker_card_id,
        "user_message_id": user_msg.id if user_msg else None,
        "assistant_message_id": assistant_msg_id
    })
    
    # Capture per-request overrides from the frontend (global chat settings)
    gen_max_tokens = req.max_output_tokens
    gen_temperature = req.temperature
    gen_repetition_penalty = req.repetition_penalty

    async def generate_task():
        llm = LLMService(settings)
        try:
            content_parts = []
            async for chunk in llm.generate(prompt_messages, stream=True, max_tokens=gen_max_tokens, temperature=gen_temperature, repetition_penalty=gen_repetition_penalty):
                content_parts.append(chunk)
                await queue.put(chunk)
                
            full_content = "".join(content_parts)
            
            await queue.put({
                "type": "api_log",
                "log": {
                    "id": gen_log_id,
                    "endpoint": "Roleplay Chat Generation",
                    "response": {
                        "choices": [{"message": {"content": full_content}}],
                        "usage": llm.last_usage
                    },
                    "usage": llm.last_usage
                }
            })
            
            # Persist to DB in detached session
            with SessionLocal() as bg_db:
                msg = bg_db.query(models.ChatMessage).filter(models.ChatMessage.id == assistant_msg_id).first()
                if msg:
                    msg.content = full_content
                    bg_db.commit()
                    
            await queue.put(None)
        except Exception as e:
            await queue.put(e)
        finally:
            await llm.close()
            
    # Launch background task (survives HTTP disconnect)
    asyncio.create_task(generate_task())
    
    # Launch background summarization for future turns
    asyncio.create_task(summarize_chat_task(chat_id, current_user.id))
    
    # Launch background auto-fact extraction
    asyncio.create_task(extract_chat_memory_task(chat_id, current_user.id))
    
    # 5. SSE Generator for frontend
    async def sse_generator():
        try:
            while True:
                item = await queue.get()
                if item is None:
                    break
                if isinstance(item, Exception):
                    yield f"data: {json.dumps({'type': 'error', 'message': str(item)})}\n\n"
                    break
                if isinstance(item, dict):
                    yield f"data: {json.dumps(item)}\n\n"
                    continue
                yield f"data: {json.dumps({'type': 'chunk', 'content': item})}\n\n"
                
            yield f"data: {json.dumps({'type': 'done'})}\n\n"
        except asyncio.CancelledError:
            # Client disconnected (e.g. phone locked), task keeps running
            pass
            
    return StreamingResponse(sse_generator(), media_type="text/event-stream")