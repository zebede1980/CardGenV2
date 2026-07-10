from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from typing import List
from app.database import get_db
from app.models import SavedUserPersona, User
from app.schemas import SavedUserPersonaCreate, SavedUserPersonaOut
from app.routers.auth import get_current_user

router = APIRouter(tags=["personas"])

@router.get("/personas", response_model=List[SavedUserPersonaOut])
def get_personas(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return db.query(SavedUserPersona).filter(SavedUserPersona.user_id == current_user.id).all()

@router.post("/personas", response_model=SavedUserPersonaOut)
def create_persona(persona_in: SavedUserPersonaCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    # Check for exact duplicate
    existing = db.query(SavedUserPersona).filter(
        SavedUserPersona.user_id == current_user.id,
        SavedUserPersona.name == persona_in.name,
        SavedUserPersona.age == persona_in.age,
        SavedUserPersona.gender == persona_in.gender,
        SavedUserPersona.detail == persona_in.detail
    ).first()
    
    if existing:
        return existing
        
    new_persona = SavedUserPersona(
        user_id=current_user.id,
        name=persona_in.name,
        age=persona_in.age,
        gender=persona_in.gender,
        detail=persona_in.detail
    )
    db.add(new_persona)
    db.commit()
    db.refresh(new_persona)
    return new_persona

@router.delete("/personas/{persona_id}")
def delete_persona(persona_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    persona = db.query(SavedUserPersona).filter(SavedUserPersona.id == persona_id, SavedUserPersona.user_id == current_user.id).first()
    if not persona:
        raise HTTPException(status_code=404, detail="Persona not found")
    db.delete(persona)
    db.commit()
    return {"message": "Persona deleted"}
