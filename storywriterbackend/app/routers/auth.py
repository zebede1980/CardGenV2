from fastapi import APIRouter, Depends, HTTPException, Header
from sqlalchemy.orm import Session
from pydantic import BaseModel

from app.database import get_db
from app.models import User

router = APIRouter(prefix="/auth", tags=["auth"])

def get_current_user(x_user_id: str = Header(None), x_user_name: str = Header(None), db: Session = Depends(get_db)) -> User:
    if not x_user_id:
        raise HTTPException(status_code=401, detail="Missing X-User-Id header from proxy")
        
    username = f"cardgen_{x_user_id}"
    user = db.query(User).filter(User.username == username).first()
    if not user:
        user = User(username=username, password="xxx")
        db.add(user)
        db.commit()
        db.refresh(user)
    return user

@router.get("/me")
def me(current_user: User = Depends(get_current_user)):
    return {"user_id": current_user.id, "username": current_user.username}
