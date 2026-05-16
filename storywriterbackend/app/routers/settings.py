from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Settings, User
from app.schemas import SettingsOut, SettingsUpdate
from app.routers.auth import get_current_user

router = APIRouter(prefix="/settings", tags=["settings"])

def get_or_create_settings(db: Session, user_id: int) -> Settings:
    settings = db.query(Settings).filter(Settings.user_id == user_id).first()
    if not settings:
        settings = Settings(user_id=user_id)
        db.add(settings)
        db.commit()
        db.refresh(settings)
    return settings

@router.get("/", response_model=SettingsOut)
def get_settings(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    settings = get_or_create_settings(db, current_user.id)
    return settings

@router.put("/", response_model=SettingsOut)
def update_settings(update: SettingsUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    settings = get_or_create_settings(db, current_user.id)
    for field, value in update.model_dump(exclude_unset=True).items():
        setattr(settings, field, value)
    db.commit()
    db.refresh(settings)
    return settings
