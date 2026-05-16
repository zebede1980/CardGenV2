from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List

from app.database import get_db
from app.models import Story, StorySegment, StoryCard, CharacterCard, User, SteeringInstruction
from app.schemas import StoryCreate, StoryOut, StoryDetailOut, StorySegmentOut, StoryCardOut, EditSegmentRequest
from app.routers.auth import get_current_user

router = APIRouter(prefix="/stories", tags=["stories"])

@router.post("/", response_model=StoryOut)
def create_story(story: StoryCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    db_story = Story(user_id=current_user.id, title=story.title, synopsis=story.synopsis)
    db.add(db_story)
    db.commit()
    
    if story.card_ids:
        for card_id in story.card_ids:
            card = db.query(CharacterCard).filter(CharacterCard.id == card_id, CharacterCard.user_id == current_user.id).first()
            if card:
                sc = StoryCard(story_id=db_story.id, card_id=card.id)
                db.add(sc)
        db.commit()
        
    db.refresh(db_story)
    return db_story

@router.get("/", response_model=List[StoryOut])
def list_stories(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return db.query(Story).filter(Story.user_id == current_user.id).order_by(Story.updated_at.desc()).all()

@router.get("/{story_id}", response_model=StoryDetailOut)
def get_story(story_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    story = db.query(Story).filter(Story.id == story_id, Story.user_id == current_user.id).first()
    if not story:
        raise HTTPException(status_code=404, detail="Story not found")
    return story

@router.put("/{story_id}", response_model=StoryOut)
def update_story(story_id: int, story_update: StoryCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    story = db.query(Story).filter(Story.id == story_id, Story.user_id == current_user.id).first()
    if not story:
        raise HTTPException(status_code=404, detail="Story not found")
    story.title = story_update.title
    story.synopsis = story_update.synopsis
    
    if story_update.card_ids:
        for card_id in story_update.card_ids:
            existing = db.query(StoryCard).filter(StoryCard.story_id == story.id, StoryCard.card_id == card_id).first()
            if not existing:
                card = db.query(CharacterCard).filter(CharacterCard.id == card_id, CharacterCard.user_id == current_user.id).first()
                if card:
                    sc = StoryCard(story_id=story.id, card_id=card.id)
                    db.add(sc)
                    
    db.commit()
    db.refresh(story)
    return story

@router.delete("/{story_id}")
def delete_story(story_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    story = db.query(Story).filter(Story.id == story_id, Story.user_id == current_user.id).first()
    if not story:
        raise HTTPException(status_code=404, detail="Story not found")
    # Delete steering instructions manually (no cascade relationship defined on Story)
    db.query(SteeringInstruction).filter(SteeringInstruction.story_id == story_id).delete()
    db.delete(story)
    db.commit()
    return {"detail": "Story deleted"}

@router.post("/{story_id}/cards/{card_id}", response_model=StoryCardOut)
def attach_card(story_id: int, card_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    story = db.query(Story).filter(Story.id == story_id, Story.user_id == current_user.id).first()
    if not story:
        raise HTTPException(status_code=404, detail="Story not found")
    card = db.query(CharacterCard).filter(CharacterCard.id == card_id, CharacterCard.user_id == current_user.id).first()
    if not card:
        raise HTTPException(status_code=404, detail="Card not found")
    
    existing = db.query(StoryCard).filter(
        StoryCard.story_id == story_id,
        StoryCard.card_id == card_id
    ).first()
    if existing:
        raise HTTPException(status_code=400, detail="Card already attached to story")
    
    sc = StoryCard(story_id=story_id, card_id=card_id)
    db.add(sc)
    db.commit()
    db.refresh(sc)
    return sc

@router.delete("/{story_id}/cards/{card_id}")
def detach_card(story_id: int, card_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    story = db.query(Story).filter(Story.id == story_id, Story.user_id == current_user.id).first()
    if not story:
        raise HTTPException(status_code=404, detail="Story not found")
    sc = db.query(StoryCard).filter(
        StoryCard.story_id == story_id,
        StoryCard.card_id == card_id
    ).first()
    if not sc:
        raise HTTPException(status_code=404, detail="Card not attached to story")
    db.delete(sc)
    db.commit()
    return {"detail": "Card detached"}

@router.post("/{story_id}/segments", response_model=StorySegmentOut)
def add_segment(story_id: int, content: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    story = db.query(Story).filter(Story.id == story_id, Story.user_id == current_user.id).first()
    if not story:
        raise HTTPException(status_code=404, detail="Story not found")
    
    max_order = db.query(StorySegment).filter(
        StorySegment.story_id == story_id
    ).count()
    
    seg = StorySegment(story_id=story_id, order_index=max_order, content=content)
    db.add(seg)
    db.commit()
    db.refresh(seg)
    return seg

@router.put("/{story_id}/segments/{segment_id}", response_model=StorySegmentOut)
def edit_segment(story_id: int, segment_id: int, req: EditSegmentRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    story = db.query(Story).filter(Story.id == story_id, Story.user_id == current_user.id).first()
    if not story:
        raise HTTPException(status_code=404, detail="Story not found")
    seg = db.query(StorySegment).filter(
        StorySegment.id == segment_id,
        StorySegment.story_id == story_id
    ).first()
    if not seg:
        raise HTTPException(status_code=404, detail="Segment not found")
    seg.content = req.content
    db.commit()
    db.refresh(seg)
    return seg

@router.delete("/{story_id}/segments/{segment_id}")
def delete_segment(story_id: int, segment_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    story = db.query(Story).filter(Story.id == story_id, Story.user_id == current_user.id).first()
    if not story:
        raise HTTPException(status_code=404, detail="Story not found")
    seg = db.query(StorySegment).filter(
        StorySegment.id == segment_id,
        StorySegment.story_id == story_id
    ).first()
    if not seg:
        raise HTTPException(status_code=404, detail="Segment not found")
    db.delete(seg)
    db.commit()
    # Reorder remaining segments
    remaining = db.query(StorySegment).filter(
        StorySegment.story_id == story_id
    ).order_by(StorySegment.order_index).all()
    for i, s in enumerate(remaining):
        s.order_index = i
    db.commit()
    return {"detail": "Segment deleted"}
