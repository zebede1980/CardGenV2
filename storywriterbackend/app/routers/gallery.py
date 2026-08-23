from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List

from app.database import get_db
from app.models import CharacterCard, CharacterCardGalleryImage, User
from app.schemas import CharacterCardGalleryImageOut, GalleryReorderRequest
from app.routers.auth import get_current_user

router = APIRouter(prefix="/cards", tags=["gallery"])


def _get_owned_card(card_id: int, db: Session, current_user: User) -> CharacterCard:
    card = db.query(CharacterCard).filter(
        CharacterCard.id == card_id, CharacterCard.user_id == current_user.id
    ).first()
    if not card:
        raise HTTPException(status_code=404, detail="Card not found")
    return card


@router.post("/{card_id}/gallery", response_model=CharacterCardGalleryImageOut)
def add_gallery_image(card_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    _get_owned_card(card_id, db, current_user)
    max_order = db.query(CharacterCardGalleryImage).filter(
        CharacterCardGalleryImage.card_id == card_id
    ).count()
    img = CharacterCardGalleryImage(card_id=card_id, order_index=max_order)
    db.add(img)
    db.commit()
    db.refresh(img)
    return img


@router.get("/{card_id}/gallery", response_model=List[CharacterCardGalleryImageOut])
def list_gallery_images(card_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    _get_owned_card(card_id, db, current_user)
    return db.query(CharacterCardGalleryImage).filter(
        CharacterCardGalleryImage.card_id == card_id
    ).order_by(CharacterCardGalleryImage.order_index).all()


@router.delete("/{card_id}/gallery/{gallery_id}")
def delete_gallery_image(card_id: int, gallery_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    _get_owned_card(card_id, db, current_user)
    img = db.query(CharacterCardGalleryImage).filter(
        CharacterCardGalleryImage.id == gallery_id, CharacterCardGalleryImage.card_id == card_id
    ).first()
    if not img:
        raise HTTPException(status_code=404, detail="Gallery image not found")
    db.delete(img)
    db.commit()

    remaining = db.query(CharacterCardGalleryImage).filter(
        CharacterCardGalleryImage.card_id == card_id
    ).order_by(CharacterCardGalleryImage.order_index).all()
    for i, r in enumerate(remaining):
        r.order_index = i
    db.commit()
    return {"detail": "Gallery image deleted"}


@router.put("/{card_id}/gallery/reorder")
def reorder_gallery_images(card_id: int, req: GalleryReorderRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    _get_owned_card(card_id, db, current_user)
    images = {img.id: img for img in db.query(CharacterCardGalleryImage).filter(
        CharacterCardGalleryImage.card_id == card_id
    ).all()}
    if set(req.ordered_ids) != set(images.keys()):
        raise HTTPException(status_code=400, detail="ordered_ids must match the card's existing gallery image ids")
    for i, gallery_id in enumerate(req.ordered_ids):
        images[gallery_id].order_index = i
    db.commit()
    return {"detail": "Gallery reordered"}
