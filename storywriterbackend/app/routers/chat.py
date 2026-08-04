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
import logging

from app.database import get_db, SessionLocal
from app import models, schemas
from app.services.llm_service import LLMService, UTILITY_TEMPERATURE
from app.services.card_parser import extract_relevant_lorebook_entries
from app.routers.settings import get_or_create_settings
from app.routers.auth import get_current_user

router = APIRouter(prefix="/chats", tags=["chats"])

import re as _cot_re

# ── Shared Chain-of-Thought prompt text ─────────────────────────────────────
# Single source of truth used by both get_default_system_prompt() and
# build_chat_prompt().  Numbered steps are intentional — they create a clear
# sequential obligation that models honour more reliably than bullet points.
_COT_PROMPT_TEXT = (
    "CHAIN OF THOUGHT — MANDATORY REASONING FORMAT:\n"
    "Before writing ANY story prose you MUST complete all five numbered steps "
    "inside a <think>...</think> block. Skipping this block or any step is not allowed.\n\n"
    "<think>\n"
    "1. Ground Truth — What is the exact physical setting, time, and immediate situation right now?\n"
    "2. NPC Knowledge — What does my character know, believe, and NOT know at this precise moment?\n"
    "3. Intent — What is my character's concrete goal or motivation for THIS turn specifically?\n"
    "4. Draft — What will they say or do? (Write a rough version here first.)\n"
    "5. Self-Correct — Does this draft fit the established persona? Is it avoiding repetition? "
    "Adjust if necessary before writing the final prose.\n"
    "</think>\n"
    "[Your final story prose goes here — the user ONLY sees this section]\n\n"
    "CRITICAL RULES:\n"
    "1. Your response MUST open with <think> — no preamble, no greeting, no text before it.\n"
    "2. Use EXACTLY <think> and </think>. No other tag names, no ---, no variations.\n"
    "3. Do NOT write story prose inside <think>. Do NOT write reasoning outside <think>.\n"
    "4. The </think> tag MUST be closed before the story prose begins."
)

# Regex to detect the CoT block that models output WITHOUT wrapping in <think> tags.
# Matches one or more lines starting with a bullet (• or -) OR a numbered step (1., 2.)
# at the very start of the response, followed by blank line(s) then the story prose.
_COT_BARE_PATTERN = _cot_re.compile(
    r'^((?:\s*(?:•|-|\d+\.)\s+\S[^\n]*\n)+)\s*\n(.*)',
    _cot_re.DOTALL | _cot_re.IGNORECASE
)

def _inject_think_tags(content: str) -> tuple[str, bool]:
    """If `content` has no <think> tags but starts with bare CoT lines (bullets or
    numbered steps), wrap the block in <think>...</think> and return (fixed_content, True).
    Returns (content, False) if no transformation was needed."""
    stripped = content.strip()
    # Already has tags — nothing to do
    if _cot_re.search(r'<think>', stripped, _cot_re.IGNORECASE):
        return content, False
    m = _COT_BARE_PATTERN.match(stripped)
    if not m:
        return content, False
    cot_block = m.group(1).strip()
    prose = m.group(2).strip()
    if not prose:
        # Entire response was CoT lines — still wrap so frontend hides it
        return f"<think>\n{cot_block}\n</think>", True
    fixed = f"<think>\n{cot_block}\n</think>\n{prose}"
    return fixed, True

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
        # CoT — shared constant, placed last so it is the freshest part of the default system prompt
        _COT_PROMPT_TEXT,
    ]
    return "\n\n".join(modules)

WRITING_STYLE_PRESETS = {
    "descriptive": {
        "name": "Rich & Descriptive",
        "guidelines": (
            "WRITING STYLE & TONE GUIDELINES — Rich & Descriptive:\n"
            "- Emphasize vivid sensory details (sights, textures, ambient sounds, lighting, smells).\n"
            "- Paint atmospheric environmental settings that bring every scene to life before and during character actions.\n"
            "- Pacing should feel immersive and deliberate, savoring subtle physical interactions."
        ),
        "post_reminder": "Maintain a rich, highly descriptive writing style with vivid sensory details and atmospheric prose."
    },
    "action": {
        "name": "Fast-Paced & Action-Oriented",
        "guidelines": (
            "WRITING STYLE & TONE GUIDELINES — Fast-Paced & Action-Oriented:\n"
            "- Write with high momentum, sharp sentence structure, and dynamic kinetic energy.\n"
            "- Keep dialogue direct and punchy, emphasizing immediate physical movement and tactical reactions.\n"
            "- Maintain high stakes and continuous forward momentum without lingering on lengthy expositions."
        ),
        "post_reminder": "Maintain a fast-paced, action-oriented tone with punchy sentences and dynamic momentum."
    },
    "literary": {
        "name": "Literary & Eloquent",
        "guidelines": (
            "WRITING STYLE & TONE GUIDELINES — Literary & Eloquent:\n"
            "- Write in elegant, highly polished prose with sophisticated vocabulary and lyrical sentence cadence.\n"
            "- Weave character introspections, subtle emotional subtext, and rich thematic observations throughout.\n"
            "- Produce narrative prose that feels artistic, eloquent, and deeply atmospheric."
        ),
        "post_reminder": "Maintain an eloquent, literary style with polished prose, rich vocabulary, and subtle subtext."
    },
    "dark_gritty": {
        "name": "Dark & Gritty",
        "guidelines": (
            "WRITING STYLE & TONE GUIDELINES — Dark & Gritty:\n"
            "- Use a raw, visceral, and unvarnished writing tone with palpable tension.\n"
            "- Highlight stark environmental realism, moral ambiguity, physical weariness, and emotional weight.\n"
            "- Do not sanitize or sugarcoat descriptions; capture the harsh, intense reality of the situation."
        ),
        "post_reminder": "Maintain a dark, gritty tone with raw visceral realism and unvarnished tension."
    },
    "witty_banter": {
        "name": "Witty & Sarcastic",
        "guidelines": (
            "WRITING STYLE & TONE GUIDELINES — Witty & Sarcastic:\n"
            "- Focus heavily on sharp verbal exchanges, clever banter, and playful or sarcastic undertones.\n"
            "- Keep character dialogue quick, inventive, and humorously observant.\n"
            "- Balance clever comedy and dry wit seamlessly with ongoing character dynamics."
        ),
        "post_reminder": "Maintain a witty, sarcastic tone with sharp dialogue, clever banter, and humorous timing."
    },
    "romantic_intimate": {
        "name": "Emotional & Intimate",
        "guidelines": (
            "WRITING STYLE & TONE GUIDELINES — Emotional & Intimate:\n"
            "- Focus deeply on internal emotional states, heartbeats, subtle body language, and physical closeness.\n"
            "- Capture delicate emotional nuances, unspoken feelings, eye contact, and deep personal connection.\n"
            "- Prioritize emotional intimacy and relationship dynamics throughout."
        ),
        "post_reminder": "Maintain an intimate, emotionally resonant style focusing on subtle dynamics and personal closeness."
    },
    "gothic_horror": {
        "name": "Gothic & Foreboding",
        "guidelines": (
            "WRITING STYLE & TONE GUIDELINES — Gothic & Foreboding:\n"
            "- Establish an ominous, eerie, and claustrophobic atmosphere laden with psychological tension.\n"
            "- Use unsettling sensory cues, shadowed environments, creepy quietude, and a lingering sense of dread.\n"
            "- Frame character observations with foreboding imagery."
        ),
        "post_reminder": "Maintain a gothic, foreboding tone with unsettling sensory details and psychological tension."
    },
    "classic_novelist": {
        "name": "Classic 19th-Century Novelist",
        "guidelines": (
            "WRITING STYLE & TONE GUIDELINES — Classic 19th-Century Novelist:\n"
            "- Write in the style of classic 19th-century literature (Charles Dickens, Alexandre Dumas, Victor Hugo).\n"
            "- Employ expansive, ornate prose, formal dialogue, and deliberate, thorough character observations."
        ),
        "post_reminder": "Maintain a classic 19th-century novelist style with ornate prose and formal dialogue."
    },
    "hardboiled_noir": {
        "name": "Hardboiled Noir",
        "guidelines": (
            "WRITING STYLE & TONE GUIDELINES — Hardboiled Noir:\n"
            "- Write in a hardboiled noir style (Raymond Chandler, Dashiell Hammett).\n"
            "- Feature cynical internal commentary, crisp snappy dialogue, rain-slicked/shadowed ambiance, and noir grit."
        ),
        "post_reminder": "Maintain a hardboiled noir style with cynical observations, crisp dialogue, and atmospheric grit."
    },
    "epic_fantasy": {
        "name": "High Epic Fantasy",
        "guidelines": (
            "WRITING STYLE & TONE GUIDELINES — High Epic Fantasy:\n"
            "- Write in high epic fantasy prose (J.R.R. Tolkien style).\n"
            "- Employ a mythic cadence, noble and formal dialogue, grand world descriptions, and a sense of ancient history."
        ),
        "post_reminder": "Maintain a high epic fantasy style with mythic cadence, noble phrasing, and grand scope."
    },
    "cyberpunk_neon": {
        "name": "Cyberpunk & Tech-Grime",
        "guidelines": (
            "WRITING STYLE & TONE GUIDELINES — Cyberpunk & Tech-Grime:\n"
            "- Write in a high-tech, low-life cyberpunk style (William Gibson style).\n"
            "- Blend rapid sensory cuts, technological slang/neologisms, neon-drenched grime, and sharp urban edge."
        ),
        "post_reminder": "Maintain a cyberpunk tech-grime style with fast sensory cuts, neon atmosphere, and edgy tone."
    },
    "sensual_erotic": {
        "name": "Sensual & Erotic",
        "guidelines": (
            "WRITING STYLE & TONE GUIDELINES — Sensual & Erotic:\n"
            "- Focus deeply on physical awareness, sensual tactile descriptions, skin-to-skin touch, warmth, and anatomical intimacy.\n"
            "- Emphasize visceral bodily reactions (quickened breath, racing pulse, shivers, heat, intense sensation, and arousal).\n"
            "- Deliver uninhibited, highly detailed, and passionate descriptions of physical intimacy, romance, and desire."
        ),
        "post_reminder": "Maintain a sensual, erotic style focusing on intense physical awareness, tactile intimacy, and passionate detail."
    }
}

def build_chat_prompt(chat: models.RoleplayChat, db: Session, speaker_name: str = None, max_input_tokens: int = None, enable_cot: bool = True):
    messages = []
    
    system_parts = []

    # 1. System Prompt (user-authored)
    if chat.system_prompt:
        system_parts.append(chat.system_prompt)

    # Writing Style Guidelines
    if getattr(chat, 'writing_style', None) and chat.writing_style in WRITING_STYLE_PRESETS:
        style_info = WRITING_STYLE_PRESETS[chat.writing_style]
        system_parts.append(style_info["guidelines"])

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

        # Per-card system prompt (card-level instructions set by the card author,
        # e.g. language, tone rules, or scenario-specific constraints).
        # This is distinct from the chat-level system_prompt on RoleplayChat.
        if card.system_prompt:
            card_text += f"\nCharacter Instructions:\n{card.system_prompt}"

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

    # 4. Chain-of-Thought instruction — placed LAST in the system block so it is
    #    the freshest, most prominent instruction before the conversation history.
    #    Positioning it early (e.g. position 2) causes it to be buried under
    #    character cards and persona text, reducing adherence.
    if enable_cot and (not chat.system_prompt or "CHAIN OF THOUGHT" not in chat.system_prompt):
        system_parts.append(_COT_PROMPT_TEXT)

    if system_parts:
        messages.append({"role": "system", "content": "\n\n".join(system_parts)})
        
    # 4. Chat History
    import re as _re
    _scene_image_re = _re.compile(r'\s*<scene-image\s+[^>]*/?>\s*|</scene-image>\s*', _re.IGNORECASE)
    # Strip <think>...</think> reasoning blocks from assistant history.
    # The story text (after </think>) is preserved in full; only the transient
    # internal planning text is removed.  Keeping think blocks in context causes
    # the LLM to pattern-match on them and echo reasoning outside the tags.
    _think_re = _re.compile(r'<think>[\s\S]*?</think>\s*', _re.IGNORECASE)
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
        # Strip <think>...</think> reasoning from assistant history — the story
        # text that follows </think> is preserved; only the planning text is removed.
        if msg.role == "assistant":
            content = _think_re.sub('', content).strip()
        if not content and msg.role == "assistant":
            continue  # skip if the message was only a think block (e.g. aborted mid-stream)
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
            
    if getattr(chat, 'writing_style', None) and chat.writing_style in WRITING_STYLE_PRESETS:
        style_info = WRITING_STYLE_PRESETS[chat.writing_style]
        post_history_parts.append(f"[Writing Style Instruction]: {style_info['post_reminder']}")

    if post_history_parts:
        messages.append({"role": "system", "content": "\n\n".join(post_history_parts)})
    
    if enable_cot:
        # ── Per-turn CoT format reminder ─────────────────────────────────────
        # This message is the very last thing the model sees before it generates.
        # It re-anchors the <think> requirement with a concrete numbered template
        # so the model cannot treat the system-prompt instruction as optional.
        # NOTE: We do NOT use an assistant prefill (partial assistant message)
        # because standard instruct models — unlike native reasoning models
        # (DeepSeek-R1, QwQ) — don't know to close the </think> tag when
        # started mid-block, causing the entire response to be hidden.
        # The system prompt + frontend preamble-stripping handles edge cases.
        cot_reminder = (
            "YOUR NEXT RESPONSE MUST follow this exact structure — no exceptions:\n"
            "<think>\n"
            "1. Ground Truth: [setting/situation]\n"
            "2. NPC Knowledge: [what the character knows/doesn't know]\n"
            "3. Intent: [character's goal this turn]\n"
            "4. Draft: [rough version of response]\n"
            "5. Self-Correct: [check persona fit and avoid repetition]\n"
            "</think>\n"
            "[Story prose here — this is the ONLY part the user sees]\n\n"
            "Open with <think>. Close with </think>. No preamble. No other tag names. No --- separators."
        )
        if speaker_name and len(chat.characters) > 1:
            messages.append({"role": "system", "content": (
                f"Write the next reply from the perspective of {speaker_name}. "
                f"Do NOT output '{speaker_name}:' at the start of your message.\n\n"
                + cot_reminder
            )})
        else:
            messages.append({"role": "system", "content": cot_reminder})
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
            # Utility task: must not inherit the user's creative temperature.
            async for chunk in llm.generate(messages, stream=True, temperature=UTILITY_TEMPERATURE):
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
            # Utility task: must not inherit the user's creative temperature.
            async for chunk in llm.generate(messages, stream=True, temperature=UTILITY_TEMPERATURE):
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
    from sqlalchemy import func
    msg_count_sq = (
        db.query(func.count(models.ChatMessage.id))
        .filter(models.ChatMessage.chat_id == models.RoleplayChat.id)
        .correlate(models.RoleplayChat)
        .scalar_subquery()
    )
    rows = (
        db.query(models.RoleplayChat, msg_count_sq.label("message_count"))
        .filter(models.RoleplayChat.user_id == str(current_user.id))
        .order_by(models.RoleplayChat.updated_at.desc())
        .all()
    )
    results = []
    for chat, count in rows:
        out = schemas.RoleplayChatOut.from_orm(chat)
        out.message_count = count or 0
        results.append(out)
    return results

@router.post("/", response_model=schemas.RoleplayChatDetailOut)
def create_chat(chat_in: schemas.RoleplayChatCreate, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    new_chat = models.RoleplayChat(
        user_id=str(current_user.id),
        title=chat_in.title,
        system_prompt=chat_in.system_prompt.strip() if chat_in.system_prompt else get_default_system_prompt(),
        writing_style=chat_in.writing_style or "",
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
                # Substitute SillyTavern template variables before storing the
                # opening message — the user sees this text directly in the chat
                # bubble, so literal {{char}} or {{user}} would look broken.
                user_display_name = chat_in.user_persona_name or "User"
                msg_content = (msg_content
                               .replace("{{char}}", card.name or "Character")
                               .replace("{{Char}}", card.name or "Character")
                               .replace("{{CHAR}}", card.name or "Character")
                               .replace("{{user}}", user_display_name)
                               .replace("{{User}}", user_display_name)
                               .replace("{{USER}}", user_display_name))
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
    if chat_in.writing_style is not None:
        chat.writing_style = chat_in.writing_style
        
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
    forge_url: Optional[str] = None  # WebUI Forge host, e.g. http://127.0.0.1:7860
    steps: Optional[int] = None
    cfg_scale: Optional[float] = None

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
        # Utility task: must not inherit the user's creative temperature.
        async for chunk in llm.generate(messages, stream=False, temperature=UTILITY_TEMPERATURE):
            content_parts.append(chunk)
        image_prompt = "".join(content_parts).strip()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"LLM Prompt Generation failed: {str(e)}")
    finally:
        await llm.close()
        
    async with httpx.AsyncClient(timeout=180.0) as client:
        if params.forge_url:
            # ── Local WebUI Forge provider ────────────────────────────────────
            forge_host = params.forge_url.rstrip("/")
            txt2img_endpoint = f"{forge_host}/sdapi/v1/txt2img"
            forge_payload = {
                "prompt": image_prompt,
                "steps": params.steps if params.steps is not None else 25,
                "cfg_scale": params.cfg_scale if params.cfg_scale is not None else 7.0,
                "width": 896,
                "height": 1152,
                "sampler_name": "Euler",
            }
            try:
                img_res = await client.post(txt2img_endpoint, json=forge_payload)
                if img_res.status_code == 404:
                    raise HTTPException(
                        status_code=502,
                        detail=(
                            "WebUI Forge returned 404. Make sure Forge is running with the "
                            "--api flag enabled (launch with: python webui.py --api)."
                        ),
                    )
                img_res.raise_for_status()
                res_data = img_res.json()
                images_list = res_data.get("images", [])
                if not images_list:
                    raise Exception("Forge returned no images in response")
                img_b64 = images_list[0]
                # Forge may return the base64 string with embedded newlines
                # (RFC 2045 line-wrapping at 76 chars).  Strip all whitespace
                # before building the data URI — a single stray newline in the
                # attribute value causes browsers to render a solid black rect.
                if isinstance(img_b64, str) and img_b64.startswith("data:"):
                    # Already a full data URI — use as-is (strip surrounding ws)
                    image_url = img_b64.strip()
                else:
                    img_b64 = "".join(img_b64.split())  # remove all whitespace
                    image_url = f"data:image/png;base64,{img_b64}"
            except HTTPException:
                raise
            except httpx.ConnectError:
                raise HTTPException(
                    status_code=503,
                    detail=(
                        f"Cannot connect to WebUI Forge at {forge_host}. "
                        "Make sure Forge is running and the host URL is correct."
                    ),
                )
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"Forge image generation failed: {str(e)}")

        elif params.base_url and params.api_key:
            # ── Configured OpenAI-compatible API (e.g. NanoGPT) ──────────────
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
            # ── Fallback: Pollinations (no API key required) ──────────────────
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
                # Utility task: routing is a classification, never creative.
                async for chunk in llm.generate(route_msgs, stream=False, temperature=UTILITY_TEMPERATURE):
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
        # Impersonate mode writes AS the user, not the character — disable CoT
        # so the assistant prefill is not added (it would corrupt the prompt).
        prompt_messages = build_chat_prompt(chat, db, None, getattr(req, 'max_input_tokens', None), enable_cot=False)

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
        gen_top_p = req.top_p

        async def impersonate_generate_task():
            llm = LLMService(settings)
            try:
                async for chunk in llm.generate(prompt_messages, stream=True, max_tokens=gen_max_tokens, temperature=gen_temperature, repetition_penalty=gen_repetition_penalty, top_p=gen_top_p):
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
    gen_top_p = req.top_p

    async def generate_task():
        llm = LLMService(settings)
        full_content = ""
        request_id = str(uuid.uuid4())
        logger = logging.getLogger(__name__)
        
        # Estimate total tokens being sent for debugging
        total_chars = sum(len(m.get("content", "")) for m in prompt_messages)
        est_tokens = total_chars // 4
        logger.info(
            f"[{request_id}] LLM request started for chat {chat_id}, message {assistant_msg_id}. "
            f"Prompt msgs: {len(prompt_messages)}, Est tokens: ~{est_tokens}, "
            f"max_input: {getattr(req, 'max_input_tokens', 'None')}, rep_penalty: {gen_repetition_penalty}"
        )
        
        try:
            async for chunk in llm.generate(prompt_messages, stream=True, max_tokens=gen_max_tokens, temperature=gen_temperature, repetition_penalty=gen_repetition_penalty, top_p=gen_top_p):
                full_content += chunk
                await queue.put(chunk)
                
            logger.info(f"[{request_id}] LLM request completed successfully")

            # ── CoT tag fallback ─────────────────────────────────────────────
            # If CoT is enabled and the model forgot to wrap its reasoning in
            # <think> tags, inject them now.  We emit a corrected_content event
            # so the frontend can re-render the bubble with the think block.
            if getattr(req, 'enable_cot', True):
                fixed_content, was_fixed = _inject_think_tags(full_content)
                if was_fixed:
                    logger.info(f"[{request_id}] CoT tags injected post-generation (model omitted tags)")
                    full_content = fixed_content
                    await queue.put({"type": "corrected_content", "content": full_content})

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
        except Exception as e:
            logger.error(f"[{request_id}] LLM request failed: {e}")
            error_msg = f"\n\n[Generation error: {str(e)}]"
            full_content += error_msg
            await queue.put(e)
        finally:
            # Persist to DB in detached session
            try:
                with SessionLocal() as bg_db:
                    msg = bg_db.query(models.ChatMessage).filter(models.ChatMessage.id == assistant_msg_id).first()
                    if msg:
                        msg.content = full_content if full_content else "[Generation failed to start]"
                        bg_db.commit()
            except Exception as db_err:
                logger.error(f"[{request_id}] DB save failed: {db_err}")
                
            await llm.close()
            await queue.put(None)
            
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