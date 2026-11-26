"""The old saved-persona list, now read from persona cards (kind="persona").

Kept for one release so a page that hasn't reloaded since the deploy still
works; the persona picker reads /api/cards/summary instead. The
saved_user_personas table is no longer written (its rows were moved into
persona cards on startup, see services/persona.py)."""
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import CharacterCard, User
from app.routers.auth import get_current_user
from app.schemas import SavedUserPersonaCreate, SavedUserPersonaOut
from app.services import persona as persona_svc

router = APIRouter(tags=["personas"])


def _out(card: CharacterCard) -> dict:
    m = persona_svc.meta(card)
    return {"id": card.id, "name": card.name, "age": m["age"], "gender": m["gender"],
            "detail": persona_svc.detail_text(card), "created_at": card.created_at}


def _personas(db: Session, user_id: int):
    return db.query(CharacterCard).filter(CharacterCard.user_id == user_id, CharacterCard.kind == "persona")


@router.get("/personas", response_model=List[SavedUserPersonaOut])
def get_personas(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return [_out(c) for c in _personas(db, current_user.id).order_by(CharacterCard.created_at)]


@router.post("/personas", response_model=SavedUserPersonaOut)
def create_persona(persona_in: SavedUserPersonaCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    name = (persona_in.name or "").strip()[:80]
    if not name:
        raise HTTPException(status_code=400, detail="A persona needs a name")
    detail = (persona_in.detail or "").strip()
    for card in _personas(db, current_user.id).filter(CharacterCard.name == name):
        m = persona_svc.meta(card)
        if (card.description or "").strip() == detail and m["age"] == persona_in.age.strip() \
                and m["gender"] == persona_in.gender.strip():
            return _out(card)
    card = CharacterCard(
        user_id=current_user.id, name=name, description=detail, kind="persona", tags="persona",
        persona=persona_svc.clean_meta({"age": persona_in.age, "gender": persona_in.gender}),
    )
    db.add(card)
    db.commit()
    db.refresh(card)
    return _out(card)


@router.delete("/personas/{persona_id}")
def delete_persona(persona_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    card = _personas(db, current_user.id).filter(CharacterCard.id == persona_id).first()
    if not card:
        raise HTTPException(status_code=404, detail="Persona not found")
    from app.models import RoleplayChat
    db.query(RoleplayChat).filter(RoleplayChat.user_persona_card_id == persona_id).update(
        {"user_persona_card_id": None}, synchronize_session=False)
    db.delete(card)
    db.commit()
    return {"message": "Persona deleted"}
