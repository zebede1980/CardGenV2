from fastapi import APIRouter, UploadFile, File, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List
import os
import shutil
import uuid

from app.database import get_db
from app.models import CharacterCard, User
from app.schemas import CharacterCardOut, CharacterCardCreate
from app.services.card_parser import parse_card
from app.routers.auth import get_current_user

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
    db_card = CharacterCard(
        user_id=current_user.id,
        **card.model_dump()
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
    
    for key, value in card.model_dump().items():
        setattr(db_card, key, value)
        
    db.commit()
    db.refresh(db_card)
    return db_card

@router.get("/", response_model=List[CharacterCardOut])
def list_cards(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return db.query(CharacterCard).filter(CharacterCard.user_id == current_user.id).order_by(CharacterCard.created_at.desc()).all()

@router.get("/{card_id}", response_model=CharacterCardOut)
def get_card(card_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    card = db.query(CharacterCard).filter(CharacterCard.id == card_id, CharacterCard.user_id == current_user.id).first()
    if not card:
        raise HTTPException(status_code=404, detail="Card not found")
    return card

@router.delete("/{card_id}")
def delete_card(card_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    card = db.query(CharacterCard).filter(CharacterCard.id == card_id, CharacterCard.user_id == current_user.id).first()
    if not card:
        raise HTTPException(status_code=404, detail="Card not found")
    if card.image_path and os.path.exists(card.image_path):
        os.remove(card.image_path)
    db.delete(card)
    db.commit()
    return {"detail": "Card deleted"}
