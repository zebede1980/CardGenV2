"""💌 Messenger routes. Chats live in Roleplay Chat's tables (mode='messenger'),
so GET /chats/{id}, message edit/delete and Stop (POST /chats/{id}/messages/
{mid}/cancel) are shared; the send path, prompt and memory prompt are here.
See plans/chat-bot-messenger.md and services/messenger_prompt.py."""
import asyncio
import json
import logging
import re
import uuid
from datetime import datetime
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session, selectinload

from app import models, schemas
from app.database import SessionLocal, get_db
from app.routers.auth import get_current_user
from app.routers.chat import _ACTIVE_GENERATIONS, CHAT_MIN_MAX_TOKENS, summarize_chat_task
from app.routers.settings import get_or_create_settings
from app.services.gen_stream import close_open_think, sse_from_queue
from app.services.llm_service import (LLMService, UTILITY_TEMPERATURE, needs_prose, prose_after_reasoning,
                                      strip_think, supports_reasoning_flag, with_think_tags)
from app.services import messenger_prompt as mp

router = APIRouter(prefix="/messenger", tags=["messenger"])
logger = logging.getLogger(__name__)

MEMORY_EVERY = 8  # messages between memory updates
CONTINUE_INSTRUCTION = "Now write your reply itself: only the texts, no reasoning."


def _get_chat(db: Session, chat_id: str, user) -> models.RoleplayChat:
    chat = db.query(models.RoleplayChat).filter(
        models.RoleplayChat.id == chat_id, models.RoleplayChat.user_id == str(user.id),
        models.RoleplayChat.mode == "messenger").first()
    if not chat:
        raise HTTPException(status_code=404, detail="Chat not found")
    return chat


def _drop_orphans(db: Session, chat: models.RoleplayChat) -> None:
    """An empty reply with no task behind it was left by a restart mid-reply."""
    dead = [m for m in chat.messages if m.role == "assistant" and not m.content and m.id not in _ACTIVE_GENERATIONS]
    for m in dead:
        db.delete(m)
    if dead:
        db.commit()
        db.refresh(chat)


def _preview(m) -> str:
    text = re.sub(r"\s+", " ", strip_think(m.content or "")).strip()
    return text[:120] + ("…" if len(text) > 120 else "")


@router.get("/")
def list_chats(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    chats = (db.query(models.RoleplayChat)
             .options(selectinload(models.RoleplayChat.characters), selectinload(models.RoleplayChat.messages))
             .filter(models.RoleplayChat.user_id == str(current_user.id), models.RoleplayChat.mode == "messenger")
             .order_by(models.RoleplayChat.updated_at.desc()).all())
    out = []
    for c in chats:
        msgs = sorted([m for m in c.messages if (m.content or "").strip()], key=lambda m: m.created_at)
        last = msgs[-1] if msgs else None
        cfg = c.messenger_config
        read_at = cfg.get("read_at") or ""
        out.append({
            "id": c.id,
            "title": c.title,
            "characters": [{"id": x.id, "name": x.name or ""} for x in c.characters],
            "style": mp.config(c)["style"],
            "last": _preview(last) if last else "",
            "last_role": last.role if last else "",
            "last_at": (last.created_at.isoformat() + "Z") if last else (c.created_at.isoformat() + "Z"),
            "unread": bool(last and last.role == "assistant" and last.created_at.isoformat() > read_at),
            "message_count": len(msgs),
        })
    return out


@router.post("/", response_model=schemas.RoleplayChatDetailOut)
def create_chat(body: schemas.MessengerChatCreate, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    cards = db.query(models.CharacterCard).filter(models.CharacterCard.id.in_(body.card_ids or [-1])).all()
    if not cards:
        raise HTTPException(status_code=400, detail="Pick at least one character.")
    order = {cid: i for i, cid in enumerate(body.card_ids)}
    cards.sort(key=lambda c: order.get(c.id, 0))
    settings = {k: v for k, v in (body.settings or {}).items() if k != "read_at"}
    chat = models.RoleplayChat(
        user_id=str(current_user.id), mode="messenger",
        title=", ".join(c.name for c in cards if c.name)[:200] or "Messenger",
        messenger=json.dumps(settings),
        user_persona_name=(body.user_persona_name or "User").strip()[:80] or "User",
        user_persona_age=body.user_persona_age or "", user_persona_gender=body.user_persona_gender or "",
        user_persona_detail=body.user_persona_detail or "",
    )
    db.add(chat)
    db.flush()
    for c in cards:
        db.add(models.ChatCharacterLink(chat_id=chat.id, card_id=c.id))
    db.commit()
    db.refresh(chat)
    return chat


@router.patch("/{chat_id}", response_model=schemas.RoleplayChatOut)
def update_chat(chat_id: str, body: schemas.MessengerChatUpdate, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    chat = _get_chat(db, chat_id, current_user)
    if body.settings is not None:
        chat.messenger = json.dumps({**chat.messenger_config, **body.settings})
    for field in ("title", "user_persona_name", "user_persona_age", "user_persona_gender", "user_persona_detail"):
        value = getattr(body, field)
        if value is not None:
            setattr(chat, field, value.strip()[:2000] if field != "title" else (value.strip()[:200] or chat.title))
    db.commit()
    db.refresh(chat)
    return chat


@router.post("/{chat_id}/read")
def mark_read(chat_id: str, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    chat = _get_chat(db, chat_id, current_user)
    cfg = chat.messenger_config
    cfg["read_at"] = datetime.utcnow().isoformat()
    chat.messenger = json.dumps(cfg)
    db.commit()
    return {"ok": True}


@router.get("/{chat_id}/checkin-due")
def checkin_due(chat_id: str, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """True when the chat checks in on you and you've been away longer than its gap."""
    chat = _get_chat(db, chat_id, current_user)
    return {"due": _checkin_due(chat)}


def _checkin_due(chat) -> bool:
    cfg = mp.config(chat)
    msgs = [m for m in chat.messages if (m.content or "").strip()]
    if not cfg["checkin"] or not msgs:
        return False
    last = max(msgs, key=lambda m: m.created_at)
    return (datetime.utcnow() - last.created_at).total_seconds() >= cfg["checkin_hours"] * 3600


@router.post("/{chat_id}/messages/{message_id}/react")
def react(chat_id: str, message_id: str, body: schemas.MessengerReactIn, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Your tapback on one of their messages ("" clears it)."""
    _get_chat(db, chat_id, current_user)
    msg = db.query(models.ChatMessage).filter(models.ChatMessage.id == message_id, models.ChatMessage.chat_id == chat_id).first()
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found")
    emoji = (body.emoji or "").strip()
    if emoji and emoji not in mp.REACTIONS:
        raise HTTPException(status_code=400, detail="Not a tapback")
    msg.reaction = emoji
    db.commit()
    return {"ok": True, "reaction": emoji}


@router.post("/{chat_id}/message")
async def send_message(chat_id: str, req: schemas.MessengerSendRequest, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    chat = _get_chat(db, chat_id, current_user)
    settings = get_or_create_settings(db, current_user.id)
    if not settings.api_key:
        raise HTTPException(status_code=400, detail="API key not configured.")
    _drop_orphans(db, chat)
    if any(m.role == "assistant" and not m.content for m in chat.messages):
        raise HTTPException(status_code=409, detail="A reply is already on its way.")

    kind = req.kind if req.kind in ("send", "opener", "checkin", "regen") else "send"
    content = (req.content or "").strip()
    if kind == "send" and not content and not (req.ooc_note or "").strip():
        raise HTTPException(status_code=400, detail="Nothing to send.")
    if kind == "checkin" and not _checkin_due(chat):
        raise HTTPException(status_code=409, detail="No check-in due.")
    if kind == "opener" and any((m.content or "").strip() for m in chat.messages):
        raise HTTPException(status_code=409, detail="This chat has already started.")

    previous = None
    if kind == "regen":
        msgs = sorted(chat.messages, key=lambda m: m.created_at)
        if not msgs or msgs[-1].role != "assistant":
            raise HTTPException(status_code=409, detail="Only the latest reply can be redone.")
        previous = (req.previous_reply or strip_think(msgs[-1].content or ""))[:1500]
        db.delete(msgs[-1])
        db.commit()
        db.refresh(chat)

    user_msg = None
    if kind == "send":
        user_msg = models.ChatMessage(chat_id=chat_id, role="user", content=content[:8000], ooc_note=req.ooc_note or "")
        db.add(user_msg)
    chat.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(chat)

    cards = list(chat.characters)
    names = [c.name or "Character" for c in cards]
    group = len(cards) > 1
    cfg = mp.config(chat)
    native = supports_reasoning_flag(settings.api_base_url)
    enable_cot = req.enable_cot is not False
    memories = [m.fact for m in chat.memories if m.is_active]
    max_input = req.max_input_tokens or 16384
    prompt = mp.build_messenger_prompt(chat, memories, max_input, kind=kind, client_time=req.client_time,
                                       native_reasoning=native, enable_cot=enable_cot, previous_reply=previous,
                                       ooc_note=req.ooc_note or "")

    placeholder = models.ChatMessage(chat_id=chat_id, role="assistant", content="",
                                     character_name=names[0] if not group else "")
    db.add(placeholder)
    db.flush()
    reply_id = placeholder.id
    db.commit()
    user_msg_id = user_msg.id if user_msg else None
    queue = asyncio.Queue()
    log_id = str(uuid.uuid4())
    queue.put_nowait({"type": "api_log", "log": {"id": log_id, "endpoint": "Messenger Reply",
                                                 "request": {"model": getattr(settings, "model", "unknown"), "messages": prompt}}})
    queue.put_nowait({"type": "metadata", "user_message_id": user_msg_id, "assistant_message_id": reply_id})
    gen_kwargs = dict(max_tokens=CHAT_MIN_MAX_TOKENS, temperature=req.temperature, top_p=req.top_p,
                      presence_penalty=req.presence_penalty,
                      reasoning_effort=req.reasoning_effort or cfg["reasoning_effort"])
    user_id = current_user.id

    async def generate_task():
        llm = LLMService(settings)
        full = ""
        error = None
        try:
            try:
                stream = llm.generate(prompt, stream=True, **gen_kwargs, request_reasoning=enable_cot and native,
                                      yield_reasoning=True)
                async for chunk in with_think_tags(stream):
                    full += chunk
                    await queue.put(chunk)
                if needs_prose(full):
                    async for chunk in prose_after_reasoning(llm, prompt, full, CONTINUE_INSTRUCTION, **gen_kwargs):
                        full += chunk
                        await queue.put(chunk)
                await queue.put({"type": "api_log", "log": {"id": log_id, "endpoint": "Messenger Reply",
                                                            "response": {"choices": [{"message": {"content": full}}]},
                                                            "usage": llm.last_usage}})
            except asyncio.CancelledError:
                logger.info(f"Messenger reply {reply_id} stopped after {len(full)} chars")
            except Exception as e:
                error = e
                logger.error(f"Messenger reply failed: {e}")
            text, reaction = mp.clean_reply(close_open_think(full), names, group)
            saved = bool(text)
            try:
                with SessionLocal() as bg:
                    msg = bg.query(models.ChatMessage).filter(models.ChatMessage.id == reply_id).first()
                    if msg:
                        if saved:
                            msg.content = text
                        else:
                            bg.delete(msg)
                    if reaction and user_msg_id:
                        um = bg.query(models.ChatMessage).filter(models.ChatMessage.id == user_msg_id).first()
                        if um:
                            um.reaction = reaction
                    bg.commit()
            except Exception as db_err:
                saved = False
                logger.error(f"Messenger save failed: {db_err}")
            await queue.put({"type": "final", "message_id": reply_id, "deleted": not saved, "content": text if saved else "",
                             "reaction": reaction if user_msg_id else "", "user_message_id": user_msg_id})
            if error is not None:
                await queue.put(error)
        finally:
            await llm.close()
            await queue.put(None)

    task = asyncio.create_task(generate_task())
    _ACTIVE_GENERATIONS[reply_id] = task
    task.add_done_callback(lambda t: _ACTIVE_GENERATIONS.pop(reply_id, None))

    async def after():
        await asyncio.wait({task})
        await summarize_chat_task(chat_id, user_id, max_input)
        await extract_messenger_memory(chat_id, user_id)

    asyncio.create_task(after())
    return StreamingResponse(sse_from_queue(queue), media_type="text/event-stream")


@router.post("/{chat_id}/impersonate")
async def impersonate(chat_id: str, body: schemas.MessengerImpersonateIn, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Write your next text for you (streams; nothing is saved)."""
    chat = _get_chat(db, chat_id, current_user)
    settings = get_or_create_settings(db, current_user.id)
    if not settings.api_key:
        raise HTTPException(status_code=400, detail="API key not configured.")
    memories = [m.fact for m in chat.memories if m.is_active]
    prompt = mp.build_messenger_prompt(chat, memories, body.max_input_tokens or 16384, enable_cot=False, nudge=False)
    user = chat.user_persona_name or "User"
    ask = (f"Now write {user}'s next message instead: what {user} would type next, in their own voice, "
           "short, with no name prefix and no narration.")
    if body.draft.strip():
        ask += f" Work from this draft: “{body.draft.strip()[:1000]}”"
    prompt.append({"role": "user", "content": ask})
    queue = asyncio.Queue()

    async def run():
        llm = LLMService(settings)
        try:
            out = ""
            async for chunk in llm.generate(prompt, stream=True, request_reasoning=True):
                out += chunk
            text = strip_think(close_open_think(out)).strip().strip('"“”')
            text = re.sub(rf"^\s*{re.escape(user)}\s*:\s*", "", text)
            await queue.put({"type": "draft", "content": text})
        except Exception as e:
            await queue.put(e)
        finally:
            await llm.close()
            await queue.put(None)

    asyncio.create_task(run())
    return StreamingResponse(sse_from_queue(queue), media_type="text/event-stream")


async def extract_messenger_memory(chat_id: str, user_id: int):
    """Like Roleplay Chat's memory book, but about the person and the
    relationship (their job, the dog's name, Tuesday's argument), not the scene."""
    with SessionLocal() as bg:
        chat = bg.query(models.RoleplayChat).filter(models.RoleplayChat.id == chat_id).first()
        if not chat:
            return
        fresh = bg.query(models.ChatMessage).filter(
            models.ChatMessage.chat_id == chat_id, models.ChatMessage.is_extracted == False,  # noqa: E712
            models.ChatMessage.content != "").order_by(models.ChatMessage.created_at.asc()).all()
        if len(fresh) < MEMORY_EVERY:
            return
        user = chat.user_persona_name or "User"
        names = ", ".join(c.name for c in chat.characters if c.name) or "the character"
        lines = [f"{user if m.role == 'user' else (m.character_name or names)}: {strip_think(m.content)}" for m in fresh]
        active = [m for m in chat.memories if m.is_active]
        current = "\n".join(f"- {m.fact}" for m in active) or "None."
        settings = get_or_create_settings(bg, user_id)
    prompt = (
        f"You keep the memory for a text conversation between {names} and {user}. Update the list of facts worth "
        "remembering from the new messages:\n"
        f"- about {user}: their life, work, family, pets, plans, likes and dislikes, things they shared;\n"
        "- about the relationship: how things stand, promises, plans made together, arguments and how they ended;\n"
        f"- things {names} said about their own life, so they stay consistent.\n"
        "Keep facts that are still true, update ones that changed, drop ones that no longer matter. Skip small talk. "
        "Output the COMPLETE updated list, one fact per line, each starting with a dash (-).\n\n"
        f"Current facts:\n{current}\n\nNew messages:\n" + "\n".join(lines)
    )
    llm = LLMService(settings)
    try:
        out = ""
        async for chunk in llm.generate([{"role": "system", "content": "You maintain a concise list of facts."},
                                         {"role": "user", "content": prompt}], stream=True, temperature=UTILITY_TEMPERATURE):
            out += chunk
        facts = [ln.strip().lstrip("-").strip() for ln in strip_think(out).split("\n") if ln.strip().startswith("-")]
    except Exception as e:
        logger.warning(f"Messenger memory update failed: {e}")
        return
    finally:
        await llm.close()
    with SessionLocal() as bg:
        if facts:
            for m in bg.query(models.ChatMemory).filter(models.ChatMemory.chat_id == chat_id, models.ChatMemory.is_active == True).all():  # noqa: E712
                m.is_active = False
            for f in facts[:40]:
                if f:
                    bg.add(models.ChatMemory(chat_id=chat_id, fact=f[:300], is_active=True))
        for m in bg.query(models.ChatMessage).filter(models.ChatMessage.id.in_([x.id for x in fresh])).all():
            m.is_extracted = True
        bg.commit()
