from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List

from app.database import get_db
from app.models import Story, StorySegment, StoryCard, CharacterCard, User
from app.schemas import StoryCreate, StoryOut, StoryDetailOut, StorySegmentOut, StoryCardOut, EditSegmentRequest
from app.routers.auth import get_current_user

router = APIRouter(prefix="/stories", tags=["stories"])

@router.post("/", response_model=StoryOut)
def create_story(story: StoryCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    db_story = Story(user_id=current_user.id, title=story.title, synopsis=story.synopsis)
    db.add(db_story)
    db.commit()from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List

from app.database import get_db
from app.models import Story, StorySegment, StoryCard, CharacterCard, User
from app.schemas import StoryCreate, StoryOut, StoryDetailOut, StorySegmentOut, StoryCardOut, EditSegmentRequest
from app.routers.auth import get_current_user

router = APIRouter(prefix="/stories", tags=["stories"])

@router.post("/", response_model=StoryOut)
def create_story(story: StoryCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    db_story = Story(user_id=current_user.id, title=story.title, synopsis=story.synopsis)
    db.add(db_story)
    db.commit()

@router.get("/", response_model=List[StoryOut])
def list_stories(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return db.query(Story).filter(Story.user_id == current_user.id).order_by(Story.updated_at.desc()).all()

@router.get("/{story_id}", response_model=StoryDetailOut)
def get_story(story_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    story = db.query(Story).filter(Story.id == story_id, Story.user_id == current_user.id).first()
    if not story:
        raise HTTPException(status_code=404, detail="Story not found")

@router.put("/{story_id}", response_model=StoryOut)
def update_story(story_id: int, story_update: StoryCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    story = db.query(Story).filter(Story.id == story_id, Story.user_id == current_user.id).first()
    if not story:
        raise HTTPException(status_code=404, detail="Story not found")

@router.delete("/{story_id}")
def delete_story(story_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    story = db.query(Story).filter(Story.id == story_id, Story.user_id == current_user.id).first()
    if not story:
        raise HTTPException(status_code=404, detail="Story not found")

@router.post("/{story_id}/cards/{card_id}", response_model=StoryCardOut)
def attach_card(story_id: int, card_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    story = db.query(Story).filter(Story.id == story_id, Story.user_id == current_user.id).first()
    if not story:
        raise HTTPException(status_code=404, detail="Story not found")

@router.delete("/{story_id}/cards/{card_id}")
def detach_card(story_id: int, card_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    story = db.query(Story).filter(Story.id == story_id, Story.user_id == current_user.id).first()
    if not story:
        raise HTTPException(status_code=404, detail="Story not found")

@router.post("/{story_id}/segments", response_model=StorySegmentOut)
def add_segment(story_id: int, content: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    story = db.query(Story).filter(Story.id == story_id, Story.user_id == current_user.id).first()
    if not story:
        raise HTTPException(status_code=404, detail="Story not found")

@router.put("/{story_id}/segments/{segment_id}", response_model=StorySegmentOut)
def edit_segment(story_id: int, segment_id: int, req: EditSegmentRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    story = db.query(Story).filter(Story.id == story_id, Story.user_id == current_user.id).first()
    if not story:
        raise HTTPException(status_code=404, detail="Story not found")

@router.delete("/{story_id}/segments/{segment_id}")
def delete_segment(story_id: int, segment_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    story = db.query(Story).filter(Story.id == story_id, Story.user_id == current_user.id).first()
    if not story:
        raise HTTPException(status_code=404, detail="Story not found")
