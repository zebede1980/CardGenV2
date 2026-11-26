from fastapi import APIRouter, UploadFile, File, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List
from datetime import datetime
import json
import os
import shutil
import uuid

from app.database import get_db
from app.models import CharacterCard, CharacterCardGalleryImage, User
from app.schemas import CharacterCardOut, CharacterCardCreate
from app.services.card_parser import parse_card
from app.routers.auth import get_current_user
from app.services import persona as persona_svc

router = APIRouter(prefix="/cards", tags=["cards"])

UPLOAD_DIR = "uploads/cards"
os.makedirs(UPLOAD_DIR, exist_ok=True)

@router.post("/upload", response_model=CharacterCardOut)
async def upload_card(file: UploadFile = File(...), db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="File must be an image")
    
    contents = await file.read()
    parsed = parse_card(contents)
    if not parsed:
        raise HTTPException(status_code=400, detail="Could not parse character card from image")
    
    # Save image
    ext = os.path.splitext(file.filename or "")[1] or ".png"
    filename = f"{uuid.uuid4()}{ext}"
    filepath = os.path.join(UPLOAD_DIR, filename)
    with open(filepath, "wb") as f:
        f.write(contents)
    
    card = CharacterCard(
        user_id=current_user.id,
        name=parsed["name"],
        description=parsed["description"],
        personality=parsed["personality"],
        scenario=parsed["scenario"],
        first_mes=parsed["first_mes"],
        mes_example=parsed["mes_example"],
        creatorcomment=parsed["creatorcomment"],
        tags=parsed["tags"],
        creator=parsed["creator"],
        character_version=parsed["character_version"],
        alternate_greetings=parsed["alternate_greetings"],
        system_prompt=parsed["system_prompt"],
        post_history_instructions=parsed["post_history_instructions"],
        character_book=parsed["character_book"],
        image_path=filepath,
    )
    db.add(card)
    db.commit()
    db.refresh(card)
    return card

@router.post("/", response_model=CharacterCardOut)
def create_card(card: CharacterCardCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    fields = card.model_dump()
    fields["kind"] = persona_svc.clean_kind(fields.get("kind"))
    fields["persona"] = persona_svc.clean_meta(fields.get("persona")) if fields["kind"] == "persona" else ""
    db_card = CharacterCard(
        user_id=current_user.id,
        **fields
    )
    db.add(db_card)
    db.commit()
    db.refresh(db_card)
    return db_card

@router.put("/{card_id}", response_model=CharacterCardOut)
def update_card(card_id: int, card: CharacterCardCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    db_card = db.query(CharacterCard).filter(CharacterCard.id == card_id, CharacterCard.user_id == current_user.id).first()
    if not db_card:
        raise HTTPException(status_code=404, detail="Card not found")
    
    fields = card.model_dump()
    kind, persona = fields.pop("kind", None), fields.pop("persona", None)
    for key, value in fields.items():
        setattr(db_card, key, value)
    # Left out means "keep": an older client's save must not turn a persona back
    # into a character or drop its age, gender and voice.
    if kind is not None:
        db_card.kind = persona_svc.clean_kind(kind)
    if persona is not None:
        old_meta = persona_svc.meta(db_card)
        new_meta = json.loads(persona_svc.clean_meta(persona))
        new_meta["isDefault"] = old_meta["isDefault"]  # only /default changes that
        db_card.persona = json.dumps(new_meta)
    if db_card.kind != "persona":
        db_card.persona = ""
    db_card.updated_at = datetime.utcnow()
        
    db.commit()
    db.refresh(db_card)
    return db_card

@router.get("/", response_model=List[CharacterCardOut])
def list_cards(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    from sqlalchemy import func
    return db.query(CharacterCard).filter(CharacterCard.user_id == current_user.id).order_by(
        func.coalesce(CharacterCard.updated_at, CharacterCard.created_at).desc()
    ).all()

# ── Home's character browser ────────────────────────────────────────────────
# The full list above sends every card's whole text (lorebooks included, ~5 MB
# for a few hundred cards). Home only needs enough to show, sort and filter a
# tile, so it reads this instead and fetches a card's text when one is opened.

BLURB_CHARS = 240


def _blurb(description: str, name: str = "") -> str:
    """The description's opening words, without the markdown headings."""
    lines = [ln.strip() for ln in (description or "").splitlines()]
    text = " ".join(ln for ln in lines if ln and not ln.startswith("#"))
    text = text.replace("**", "").replace("{{char}}", name or "they").replace("{{user}}", "you").strip()
    return text[:BLURB_CHARS]


def _iso(value):
    return value.isoformat() if value else None


@router.get("/summary")
def card_summaries(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """One light row per card: name, tags, dates, a blurb, and how often and how
    lately it has been in a roleplay or Messenger chat, a story or an adventure."""
    from sqlalchemy import func
    from app.models import AdventureCharacterLink, AdventureSession, ChatCharacterLink, RoleplayChat, Story, StoryCard

    uid = current_user.id
    uses = {}

    def note(card_id, at):
        count, last = uses.get(card_id, (0, None))
        uses[card_id] = (count + 1, at if (at and (last is None or at > last)) else last)

    for card_id, at in (db.query(ChatCharacterLink.card_id, RoleplayChat.updated_at)
                        .join(RoleplayChat, RoleplayChat.id == ChatCharacterLink.chat_id)
                        .filter(RoleplayChat.user_id == uid)):
        note(card_id, at)
    for card_id, at in (db.query(StoryCard.card_id, Story.updated_at)
                        .join(Story, Story.id == StoryCard.story_id)
                        .filter(Story.user_id == uid)):
        note(card_id, at)
    for card_id, at in (db.query(AdventureCharacterLink.card_id, AdventureSession.updated_at)
                        .join(AdventureSession, AdventureSession.id == AdventureCharacterLink.adventure_id)
                        .filter(AdventureSession.user_id == uid)):
        note(card_id, at)

    rows = (db.query(CharacterCard.id, CharacterCard.name, CharacterCard.tags, CharacterCard.created_at,
                     CharacterCard.updated_at, func.substr(CharacterCard.description, 1, 1200),
                     func.length(func.coalesce(CharacterCard.character_book, "")),
                     CharacterCard.kind, CharacterCard.persona)
            .filter(CharacterCard.user_id == uid)
            .order_by(func.coalesce(CharacterCard.updated_at, CharacterCard.created_at).desc())
            .all())
    # A card is also used where it was played as you (persona), as well as where it was cast.
    for card_id, at in (db.query(RoleplayChat.user_persona_card_id, RoleplayChat.updated_at)
                        .filter(RoleplayChat.user_id == uid, RoleplayChat.user_persona_card_id.isnot(None))):
        note(card_id, at)
    for session_config, at in (db.query(AdventureSession.play_config, AdventureSession.updated_at)
                               .filter(AdventureSession.user_id == str(uid))):
        try:
            card_id = int((json.loads(session_config or "{}").get("persona") or {}).get("cardId") or 0)
        except (TypeError, ValueError, AttributeError):
            card_id = 0
        if card_id:
            note(card_id, at)

    out = []
    for card_id, name, tags, created_at, updated_at, description, book_len, kind, persona_json in rows:
        count, last = uses.get(card_id, (0, None))
        kind = persona_svc.clean_kind(kind)
        out.append({
            "id": card_id,
            "name": name or "",
            "tags": [t.strip() for t in (tags or "").split(",") if t.strip()],
            "created_at": _iso(created_at),
            "updated_at": _iso(updated_at or created_at),
            "blurb": _blurb(description, name),
            "has_lorebook": (book_len or 0) > 4,  # more than "null" / "{}"
            "uses": count,
            "last_used_at": _iso(last),
            "kind": kind,
        })
        if kind == "persona":
            m = persona_svc.meta(persona_json or "")
            out[-1]["persona"] = {"age": m["age"], "gender": m["gender"], "isDefault": m["isDefault"]}
    return out


@router.post("/{card_id}/default-persona")
def make_default_persona(card_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """This persona is pre-picked whenever a chat or adventure asks who you are.
    One per account; making another the default clears the old one."""
    card = db.query(CharacterCard).filter(CharacterCard.id == card_id, CharacterCard.user_id == current_user.id).first()
    if not card or card.kind != "persona":
        raise HTTPException(status_code=404, detail="Persona not found")
    persona_svc.set_default(db, current_user.id, card_id)
    return {"id": card_id, "isDefault": True}


@router.delete("/default-persona")
def clear_default_persona(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    persona_svc.set_default(db, current_user.id, None)
    return {"isDefault": False}


@router.get("/search")
def search_card_text(q: str = "", db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Ids of the cards whose text holds every word of `q` (name, description,
    personality, scenario, first message or tags). Home's "Descriptions" search."""
    words = [w for w in q.lower().split() if w][:8]
    if not words:
        return []
    from sqlalchemy import func

    text = func.lower(
        func.coalesce(CharacterCard.name, "") + " " + func.coalesce(CharacterCard.description, "") + " "
        + func.coalesce(CharacterCard.personality, "") + " " + func.coalesce(CharacterCard.scenario, "") + " "
        + func.coalesce(CharacterCard.first_mes, "") + " " + func.coalesce(CharacterCard.tags, "")
    )
    query = db.query(CharacterCard.id).filter(CharacterCard.user_id == current_user.id)
    for word in words:
        escaped = word.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        query = query.filter(text.like(f"%{escaped}%", escape="\\"))
    return [row[0] for row in query.all()]


@router.patch("/{card_id}/tags")
def set_card_tags(card_id: int, body: dict, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Replace a card's tags and nothing else. Leaves updated_at alone, so tagging
    doesn't reorder anything sorted by last edit (Character Gen's library)."""
    tags = body.get("tags")
    if isinstance(tags, list):
        tags = ",".join(str(t).strip() for t in tags if str(t).strip())
    if not isinstance(tags, str):
        raise HTTPException(status_code=400, detail="tags must be a list or a comma-separated string")
    # Setting updated_at to itself keeps the column's onupdate from firing.
    changed = (db.query(CharacterCard)
               .filter(CharacterCard.id == card_id, CharacterCard.user_id == current_user.id)
               .update({CharacterCard.tags: tags[:2000], CharacterCard.updated_at: CharacterCard.updated_at},
                       synchronize_session=False))
    if not changed:
        raise HTTPException(status_code=404, detail="Card not found")
    db.commit()
    return {"id": card_id, "tags": [t for t in tags.split(",") if t]}


@router.get("/{card_id}", response_model=CharacterCardOut)
def get_card(card_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    card = db.query(CharacterCard).filter(CharacterCard.id == card_id, CharacterCard.user_id == current_user.id).first()
    if not card:
        raise HTTPException(status_code=404, detail="Card not found")
    return card

@router.delete("/{card_id}")
def delete_card(card_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    from app.models import RoleplayChat, StoryCard
    card = db.query(CharacterCard).filter(CharacterCard.id == card_id, CharacterCard.user_id == current_user.id).first()
    if not card:
        raise HTTPException(status_code=404, detail="Card not found")

    # Null out any chats that use this card as their persona card
    db.query(RoleplayChat).filter(RoleplayChat.user_persona_card_id == card_id).update(
        {"user_persona_card_id": None}, synchronize_session=False
    )

    # Remove any story_cards join rows that reference this card
    db.query(StoryCard).filter(StoryCard.card_id == card_id).delete(synchronize_session=False)

    # Remove any gallery image rows that reference this card (the proxy is
    # responsible for deleting the on-disk files themselves before this runs)
    db.query(CharacterCardGalleryImage).filter(CharacterCardGalleryImage.card_id == card_id).delete(synchronize_session=False)

    db.flush()

    if card.image_path and os.path.exists(card.image_path):
        os.remove(card.image_path)
    db.delete(card)
    db.commit()
    return {"detail": "Card deleted"}
