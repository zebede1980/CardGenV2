from fastapi import APIRouter, Depends, HTTPException, Header
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from typing import List
import asyncio
import json

from app.database import get_db, SessionLocal
from app import models, schemas
from app.services.llm_service import LLMService
from app.routers.settings import get_or_create_settings

router = APIRouter(prefix="/chats", tags=["chats"])

# Extract the X-User-Id header forwarded by our proxy server
def get_current_user(x_user_id: int = Header(None)):
    if x_user_id is None:
        raise HTTPException(status_code=401, detail="User ID header missing")
    return x_user_id

def build_chat_prompt(chat: models.RoleplayChat, db: Session):
    messages = []
    
    system_parts = []
    # 1. System Prompt
    if chat.system_prompt:
        system_parts.append(chat.system_prompt)
        
    # 2. Character Cards
    for card in chat.characters:
        card_text = f"Name: {card.name}\nDescription: {card.description}\nPersonality: {card.personality}\nScenario: {card.scenario}"
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
    for msg in sorted(chat.messages, key=lambda m: m.created_at):
        if msg.is_summarized:
            continue
        if not msg.content and msg.role == "assistant":
            continue
        content = msg.content
        if msg.ooc_note:
            content += f"\n\n[OOC Note to AI: {msg.ooc_note}]"
        messages.append({"role": msg.role, "content": content})
        
    return messages

async def summarize_chat_task(chat_id: str, user_id: int):
    with SessionLocal() as bg_db:
        chat = bg_db.query(models.RoleplayChat).filter(
            models.RoleplayChat.id == chat_id,
            models.RoleplayChat.user_id == user_id
        ).first()
        if not chat: return
        
        settings = get_or_create_settings(bg_db, user_id)
        
        unsummarized = bg_db.query(models.ChatMessage).filter(
            models.ChatMessage.chat_id == chat_id,
            models.ChatMessage.is_summarized == False
        ).order_by(models.ChatMessage.created_at.asc()).all()
        
        trigger_limit = settings.summary_threshold * 3  # default 30
        keep_recent = settings.summary_threshold * 2    # default 20
        
        if len(unsummarized) <= trigger_limit:
            return
            
        to_summarize = unsummarized[:-keep_recent]
        
        text_parts = []
        for m in to_summarize:
            name = m.character_name or ("User" if m.role == "user" else "Assistant")
            text_parts.append(f"{name}: {m.content}")
        combined_text = "\n".join(text_parts)
        
        prompt = (
            "Summarize the following chat history concisely. "
            "Focus on key events, decisions, and character developments. "
        )
        if chat.summary:
            prompt += f"Incorporate this into the existing summary seamlessly.\n\nExisting Summary:\n{chat.summary}\n\nNew History to add:\n{combined_text}"
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
            models.RoleplayChat.user_id == user_id
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
        
        prompt = (
            "Extract new, permanent facts from the following chat history. "
            "Focus on physical items acquired/lost, permanent physical changes, "
            "major relationship shifts, or new locations discovered. "
            "Ignore minor conversation details, feelings, or temporary states. "
            "Output each fact on a new line starting with a dash (-). "
            "If there are no new permanent facts, output nothing."
            f"\n\nChat History:\n{combined_text}"
        )
            
        llm = LLMService(settings)
        try:
            messages = [
                {"role": "system", "content": "You are an AI data extractor. Extract concise permanent facts."},
                {"role": "user", "content": prompt}
            ]
            
            content_parts = []
            async for chunk in llm.generate(messages, stream=True):
                content_parts.append(chunk)
            
            full_response = "".join(content_parts).strip()
            if full_response:
                # Parse facts that start with a dash
                facts = [line.strip().lstrip('-').strip() for line in full_response.split('\n') if line.strip().startswith('-')]
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
def list_chats(db: Session = Depends(get_db), user_id: int = Depends(get_current_user)):
    return db.query(models.RoleplayChat)\
        .filter(models.RoleplayChat.user_id == user_id)\
        .order_by(models.RoleplayChat.updated_at.desc())\
        .all()

@router.post("/", response_model=schemas.RoleplayChatDetailOut)
def create_chat(chat_in: schemas.RoleplayChatCreate, db: Session = Depends(get_db), user_id: int = Depends(get_current_user)):
    new_chat = models.RoleplayChat(
        user_id=user_id,
        title=chat_in.title,
        system_prompt=chat_in.system_prompt,
    )
    db.add(new_chat)
    db.flush() # Flush to get the new chat ID

    # Link selected characters to this new chat session
    for card_id in chat_in.card_ids:
        link = models.ChatCharacterLink(chat_id=new_chat.id, card_id=card_id)
        db.add(link)
        
    db.commit()
    db.refresh(new_chat)
    return new_chat

@router.get("/{chat_id}", response_model=schemas.RoleplayChatDetailOut)
def get_chat(chat_id: str, db: Session = Depends(get_db), user_id: int = Depends(get_current_user)):
    chat = db.query(models.RoleplayChat).filter(models.RoleplayChat.id == chat_id, models.RoleplayChat.user_id == user_id).first()
    if not chat:
        raise HTTPException(status_code=404, detail="Chat not found")
    return chat

@router.patch("/{chat_id}", response_model=schemas.RoleplayChatOut)
def update_chat(chat_id: str, chat_in: schemas.RoleplayChatUpdate, db: Session = Depends(get_db), user_id: int = Depends(get_current_user)):
    chat = db.query(models.RoleplayChat).filter(models.RoleplayChat.id == chat_id, models.RoleplayChat.user_id == user_id).first()
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
def delete_chat(chat_id: str, db: Session = Depends(get_db), user_id: int = Depends(get_current_user)):
    chat = db.query(models.RoleplayChat).filter(models.RoleplayChat.id == chat_id, models.RoleplayChat.user_id == user_id).first()
    if not chat:
        raise HTTPException(status_code=404, detail="Chat not found")
    db.delete(chat)
    db.commit()
    return {"success": True}

@router.post("/{chat_id}/message")
async def send_message(
    chat_id: str,
    req: schemas.SendMessageRequest,
    db: Session = Depends(get_db),
    user_id: int = Depends(get_current_user)
):
    chat = db.query(models.RoleplayChat).filter(
        models.RoleplayChat.id == chat_id, 
        models.RoleplayChat.user_id == user_id
    ).first()
    if not chat:
        raise HTTPException(status_code=404, detail="Chat not found")
        
    settings = get_or_create_settings(db, user_id)
    if not settings.api_key:
        raise HTTPException(status_code=400, detail="API key not configured.")
        
    # 1. Save User Message
    user_msg = models.ChatMessage(
        chat_id=chat_id,
        role="user",
        content=req.content,
        ooc_note=req.ooc_note
    )
    db.add(user_msg)
    db.commit()
    
    # 2. Build Prompt Context (Ensuring strict caching order)
    prompt_messages = build_chat_prompt(chat, db)
    
    # 3. Create Placeholder Assistant Message
    assistant_msg = models.ChatMessage(
        chat_id=chat_id,
        role="assistant",
        character_name=req.character_name,
        content=""
    )
    db.add(assistant_msg)
    db.commit()
    assistant_msg_id = assistant_msg.id
    
    # 4. Setup Background Detached Generation & Queue
    queue = asyncio.Queue()
    
    async def generate_task():
        llm = LLMService(settings)
        try:
            content_parts = []
            async for chunk in llm.generate(prompt_messages, stream=True):
                content_parts.append(chunk)
                await queue.put(chunk)
                
            full_content = "".join(content_parts)
            
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
    asyncio.create_task(summarize_chat_task(chat_id, user_id))
    
    # Launch background auto-fact extraction
    asyncio.create_task(extract_chat_memory_task(chat_id, user_id))
    
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
                yield f"data: {json.dumps({'type': 'chunk', 'content': item})}\n\n"
                
            yield f"data: {json.dumps({'type': 'done'})}\n\n"
        except asyncio.CancelledError:
            # Client disconnected (e.g. phone locked), task keeps running
            pass
            
    return StreamingResponse(sse_generator(), media_type="text/event-stream")