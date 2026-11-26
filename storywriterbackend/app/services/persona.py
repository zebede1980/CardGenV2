"""Personas: the player's own character, kept as a card (kind="persona").

A chat follows its persona card by id: each time it is opened or generates, the
copied fields on the chat (name, age, gender, detail) are refreshed from the
card, so an edit to the persona reaches every chat that uses it. The copies are
what every prompt reads, and they stay as they were if the card is deleted.

Persona text names the persona outright (no {{user}} / {{char}}), so the same
card reads correctly as "you" and as a character the AI plays. A character card
picked as a persona still carries {{char}} for itself; that becomes its name.
"""
import json
import re
from datetime import datetime

from sqlalchemy.orm import Session

from app import models

KINDS = ("character", "persona")
DETAIL_MAX = 2000
MIGRATION_MARKER = "personas_migrated_v1"


def clean_kind(value) -> str:
    return "persona" if value == "persona" else "character"


def meta(source) -> dict:
    """A persona card's extras: age, gender, voice, isDefault. Takes the card,
    its stored JSON string, or a dict."""
    if isinstance(source, dict):
        data = source
    else:
        raw = source if isinstance(source, str) or source is None else getattr(source, "persona", "")
        try:
            data = json.loads(raw or "{}")
        except (TypeError, ValueError):
            data = {}
    if not isinstance(data, dict):
        data = {}
    return {
        "age": str(data.get("age") or "").strip()[:40],
        "gender": str(data.get("gender") or "").strip()[:40],
        "voice": str(data.get("voice") or "").strip()[:600],
        "isDefault": bool(data.get("isDefault")),
    }


def clean_meta(raw) -> str:
    """Store only the known keys, trimmed. Accepts a JSON string or a dict."""
    return json.dumps(meta(raw))


def _own_name(text: str, name: str) -> str:
    return re.sub(r"\{\{\s*(?:char|user)\s*\}\}|<USER>", lambda _m: name, text or "", flags=re.IGNORECASE)


_TITLE = re.compile(r"^\s*#\s+[^\n]*\n+")


def detail_text(card) -> str:
    """The persona's description, personality and voice as one block for a prompt."""
    name = card.name or "User"
    parts = []
    description = _TITLE.sub("", (card.description or "").strip(), count=1).strip()
    if description:
        parts.append(_own_name(description, name))
    personality = (card.personality or "").strip()
    if personality:
        parts.append(_own_name(personality, name))
    voice = meta(card)["voice"] if card.kind == "persona" else ""
    if voice:
        parts.append(f"How {name} talks: {_own_name(voice, name)}")
    return "\n\n".join(parts)[:DETAIL_MAX]


def snapshot(card) -> dict:
    m = meta(card) if card.kind == "persona" else {"age": "", "gender": ""}
    return {
        "user_persona_name": (card.name or "User").strip()[:80] or "User",
        "user_persona_age": m["age"],
        "user_persona_gender": m["gender"],
        "user_persona_detail": detail_text(card),
    }


def _card(db: Session, card_id, user_id):
    if not card_id:
        return None
    try:
        card_id = int(card_id)
    except (TypeError, ValueError):
        return None
    return db.query(models.CharacterCard).filter(
        models.CharacterCard.id == card_id, models.CharacterCard.user_id == int(user_id)).first()


def apply_to_chat(db: Session, chat) -> bool:
    """Copy a Roleplay / Messenger chat's persona card onto the chat, without
    committing. A chat with no card, or whose card is gone, is left alone."""
    card = _card(db, getattr(chat, "user_persona_card_id", None), chat.user_id)
    if card is None:
        return False
    changed = False
    for field, value in snapshot(card).items():
        if getattr(chat, field) != value:
            setattr(chat, field, value)
            changed = True
    return changed


def sync_chat(db: Session, chat) -> bool:
    """apply_to_chat, committed if anything changed."""
    changed = apply_to_chat(db, chat)
    if changed:
        db.commit()
    return changed


def sync_adventure(db: Session, session_data) -> bool:
    """The same for an adventure, whose persona lives in its play settings JSON
    as {"name", "detail", "cardId"}."""
    cfg = session_data.config
    persona = cfg.get("persona") if isinstance(cfg.get("persona"), dict) else None
    if not persona or not persona.get("cardId"):
        return False
    card = _card(db, persona.get("cardId"), session_data.user_id)
    if card is None:
        return False
    snap = snapshot(card)
    fresh = {**persona, "name": snap["user_persona_name"], "detail": snap["user_persona_detail"]}
    if fresh == persona:
        return False
    session_data.play_config = json.dumps({**cfg, "persona": fresh})
    db.commit()
    return True


def set_default(db: Session, user_id: int, card_id) -> bool:
    """Make one persona the account's default (pre-picked everywhere); None clears it."""
    found = False
    for card in db.query(models.CharacterCard).filter(
            models.CharacterCard.user_id == user_id, models.CharacterCard.kind == "persona"):
        m = meta(card)
        want = card_id is not None and card.id == int(card_id)
        found = found or want
        if m["isDefault"] != want:
            m["isDefault"] = want
            card.persona = json.dumps(m)
    db.commit()
    return found or card_id is None


def migrate_saved_personas(db: Session) -> int:
    """Once: every saved_user_personas row becomes a persona card (exact duplicates
    become one), and chats and adventures whose copied persona matches one exactly
    start following it. Returns how many cards were made."""
    if db.get(models.AppSecret, MIGRATION_MARKER):
        return 0
    made = {}
    for row in db.query(models.SavedUserPersona).order_by(models.SavedUserPersona.id):
        key = (row.user_id, (row.name or "").strip(), (row.age or "").strip(), (row.gender or "").strip(),
               (row.detail or "").strip())
        if key in made or not key[1]:
            continue
        card = models.CharacterCard(
            user_id=row.user_id, name=key[1][:80], description=key[4], kind="persona",
            persona=json.dumps({"age": key[2][:40], "gender": key[3][:40], "voice": "", "isDefault": False}),
            tags="persona", created_at=row.created_at or datetime.utcnow(), updated_at=row.created_at or datetime.utcnow(),
        )
        db.add(card)
        db.flush()
        made[key] = card.id

    by_name_detail = {}
    for (user_id, name, age, gender, detail), card_id in made.items():
        by_name_detail.setdefault((user_id, name, detail), card_id)

    for chat in db.query(models.RoleplayChat).filter(models.RoleplayChat.user_persona_card_id.is_(None)):
        key = (chat.user_id, (chat.user_persona_name or "").strip(), (chat.user_persona_age or "").strip(),
               (chat.user_persona_gender or "").strip(), (chat.user_persona_detail or "").strip())
        card_id = made.get(key) or by_name_detail.get((key[0], key[1], key[4]))
        if card_id:
            chat.user_persona_card_id = card_id

    for adv in db.query(models.AdventureSession):
        cfg = adv.config
        persona = cfg.get("persona") if isinstance(cfg.get("persona"), dict) else None
        if not persona or persona.get("cardId"):
            continue
        try:
            uid = int(adv.user_id)
        except (TypeError, ValueError):
            continue
        card_id = by_name_detail.get((uid, str(persona.get("name") or "").strip(),
                                      str(persona.get("detail") or "").strip()))
        if card_id:
            adv.play_config = json.dumps({**cfg, "persona": {**persona, "cardId": card_id}})

    db.add(models.AppSecret(name=MIGRATION_MARKER, value=str(len(made))))
    db.commit()
    return len(made)
