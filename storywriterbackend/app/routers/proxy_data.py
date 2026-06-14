from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from typing import List
from datetime import datetime

from app.database import get_db
from app.auth import get_current_user
from app.models import User, GlobalConfig, SavedPrompt, HistoryItem, Lorebook, AlternateGreeting
from app.schemas import GlobalConfigCreate, GlobalConfigOut, ProxyDataCreate, ProxyDataOut

router = APIRouter()

# --- Global Config ---
@router.get("/config", response_model=GlobalConfigOut)
def get_global_config(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    config = db.query(GlobalConfig).filter(GlobalConfig.user_id == current_user.id).first()
    if not config:
        config = GlobalConfig(user_id=current_user.id, config_data={})
        db.add(config)
        db.commit()
        db.refresh(config)
    return config

@router.post("/config", response_model=GlobalConfigOut)
def update_global_config(update: GlobalConfigCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    config = db.query(GlobalConfig).filter(GlobalConfig.user_id == current_user.id).first()
    if not config:
        config = GlobalConfig(user_id=current_user.id, config_data=update.config_data)
        db.add(config)
    else:
        config.config_data = update.config_data
        config.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(config)
    return config

# --- Generic helper for proxy data ---
def get_all_items(model_class, db: Session, user_id: int):
    return db.query(model_class).filter(model_class.user_id == user_id).all()

def get_item(model_class, db: Session, user_id: int, item_id: str):
    item = db.query(model_class).filter(model_class.user_id == user_id, model_class.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    return item

def upsert_item(model_class, db: Session, user_id: int, item_data: ProxyDataCreate):
    item = db.query(model_class).filter(model_class.user_id == user_id, model_class.id == item_data.id).first()
    if not item:
        item = model_class(id=item_data.id, user_id=user_id, data=item_data.data)
        db.add(item)
    else:
        item.data = item_data.data
        item.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(item)
    return item

def delete_item(model_class, db: Session, user_id: int, item_id: str):
    item = get_item(model_class, db, user_id, item_id)
    db.delete(item)
    db.commit()
    return {"success": True}

# --- Prompts ---
@router.get("/prompts", response_model=List[ProxyDataOut])
def list_prompts(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return get_all_items(SavedPrompt, db, current_user.id)

@router.get("/prompts/{item_id}", response_model=ProxyDataOut)
def get_prompt(item_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return get_item(SavedPrompt, db, current_user.id, item_id)

@router.post("/prompts", response_model=ProxyDataOut)
def save_prompt(item: ProxyDataCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return upsert_item(SavedPrompt, db, current_user.id, item)

@router.delete("/prompts/{item_id}")
def delete_prompt(item_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return delete_item(SavedPrompt, db, current_user.id, item_id)

# --- History ---
@router.get("/history", response_model=List[ProxyDataOut])
def list_history(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return get_all_items(HistoryItem, db, current_user.id)

@router.get("/history/{item_id}", response_model=ProxyDataOut)
def get_history(item_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return get_item(HistoryItem, db, current_user.id, item_id)

@router.post("/history", response_model=ProxyDataOut)
def save_history(item: ProxyDataCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return upsert_item(HistoryItem, db, current_user.id, item)

@router.delete("/history/{item_id}")
def delete_history(item_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return delete_item(HistoryItem, db, current_user.id, item_id)

# --- Lorebooks ---
@router.get("/lorebooks", response_model=List[ProxyDataOut])
def list_lorebooks(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return get_all_items(Lorebook, db, current_user.id)

@router.get("/lorebooks/{item_id}", response_model=ProxyDataOut)
def get_lorebook(item_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return get_item(Lorebook, db, current_user.id, item_id)

@router.post("/lorebooks", response_model=ProxyDataOut)
def save_lorebook(item: ProxyDataCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return upsert_item(Lorebook, db, current_user.id, item)

@router.delete("/lorebooks/{item_id}")
def delete_lorebook(item_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return delete_item(Lorebook, db, current_user.id, item_id)

# --- Alternate Greetings ---
@router.get("/alt-greetings", response_model=List[ProxyDataOut])
def list_alt_greetings(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return get_all_items(AlternateGreeting, db, current_user.id)

@router.get("/alt-greetings/{item_id}", response_model=ProxyDataOut)
def get_alt_greeting(item_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return get_item(AlternateGreeting, db, current_user.id, item_id)

@router.post("/alt-greetings", response_model=ProxyDataOut)
def save_alt_greeting(item: ProxyDataCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return upsert_item(AlternateGreeting, db, current_user.id, item)

@router.delete("/alt-greetings/{item_id}")
def delete_alt_greeting(item_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return delete_item(AlternateGreeting, db, current_user.id, item_id)

