from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List

from app.database import get_db
from app.models import PlaygroundImage, User
from app.schemas import PlaygroundImageCreate, PlaygroundImageOut
from app.routers.auth import get_current_user

router = APIRouter(prefix="/playground", tags=["playground"])


@router.post("/images", response_model=PlaygroundImageOut)
def add_image(
    req: PlaygroundImageCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Records a kept Playground image. The proxy writes the bytes to disk under
    the returned id, so this only ever handles the metadata."""
    img = PlaygroundImage(user_id=current_user.id, label=req.label or "", prompt=req.prompt or "")
    db.add(img)
    db.commit()
    db.refresh(img)
    return img


@router.get("/images", response_model=List[PlaygroundImageOut])
def list_images(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Newest first — the library is a growing pile, and the last thing saved is
    almost always the one being looked for."""
    return (
        db.query(PlaygroundImage)
        .filter(PlaygroundImage.user_id == current_user.id)
        .order_by(PlaygroundImage.created_at.desc(), PlaygroundImage.id.desc())
        .all()
    )


@router.delete("/images/{image_id}")
def delete_image(image_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    img = (
        db.query(PlaygroundImage)
        .filter(PlaygroundImage.id == image_id, PlaygroundImage.user_id == current_user.id)
        .first()
    )
    if not img:
        raise HTTPException(status_code=404, detail="Playground image not found")
    db.delete(img)
    db.commit()
    return {"detail": "Playground image deleted"}
