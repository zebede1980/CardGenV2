"""Routes for auto-written stories; the work itself is in
app/services/story_autowriter.py."""
import json
import time
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import CharacterCard, Settings, Story, StoryCard, User
from app.routers.auth import get_current_user
from app.schemas import AutowriteStartRequest, AutowriteSteerRequest, StoryOut
from app.services import story_autowriter as aw

router = APIRouter(prefix="/stories", tags=["autowrite"])

# A run costs a dozen or more paid calls; two at once per user is plenty.
MAX_RUNS_PER_USER = 2


def _own_story(db: Session, story_id: int, user: User) -> Story:
    story = db.query(Story).filter(Story.id == story_id, Story.user_id == user.id).first()
    if not story:
        raise HTTPException(status_code=404, detail="Story not found")
    return story


def _check_can_run(db: Session, user: User):
    settings = db.query(Settings).filter(Settings.user_id == user.id).first()
    if not settings or not settings.api_key:
        raise HTTPException(status_code=400, detail="API key not configured. Please set it in Settings.")
    running = sum(1 for sid in list(aw._RUNS) if aw.active_run(sid) and aw._RUNS[sid].user_id == user.id)
    if running >= MAX_RUNS_PER_USER:
        raise HTTPException(status_code=429, detail=f"{running} stories are already being written. Wait for one to finish.")


@router.post("/autowrite", response_model=StoryOut)
async def create_autowritten_story(req: AutowriteStartRequest, db: Session = Depends(get_db),
                                   current_user: User = Depends(get_current_user)):
    """The setup sheet's "Write it": creates the story and starts writing it."""
    _check_can_run(db, current_user)
    title = req.title.strip()[:200]
    story = Story(user_id=current_user.id, title=title or aw.UNTITLED, synopsis="")
    db.add(story)
    db.commit()
    for card_id in dict.fromkeys(req.card_ids):
        card = db.query(CharacterCard).filter(CharacterCard.id == card_id, CharacterCard.user_id == current_user.id).first()
        if card:
            db.add(StoryCard(story_id=story.id, card_id=card.id))
    config = aw.build_config(req.length, req.ending, req.faithfulness, req.idea, title_given=bool(title))
    story.autowrite = json.dumps(aw.new_state(config))
    db.commit()
    db.refresh(story)
    aw.start_run(story.id, current_user.id)
    return story


@router.get("/{story_id}/autowrite")
def autowrite_status(story_id: int, from_: int = Query(0, alias="from"), db: Session = Depends(get_db),
                     current_user: User = Depends(get_current_user)):
    """Polled by the browser while a story is being written. `partial` is the
    chapter in progress from character `from_` on (the browser already has the
    text before it); `partial_from` says where this piece starts, 0 when the
    browser's copy is stale and should be replaced."""
    story = _own_story(db, story_id, current_user)
    out = aw.status_for(story, db)
    run = aw.active_run(story_id)
    if run:
        run.last_poll = time.monotonic()
    partial = run.partial if run else ""
    start = from_ if 0 <= from_ <= len(partial) else 0
    out.update({"partial": partial[start:], "partial_from": start, "partial_len": len(partial)})
    return out


@router.post("/{story_id}/autowrite/resume")
async def resume_autowrite(story_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Carry on after Stop, a failure or a backend restart, from the next
    unwritten chapter (with the same outline, if there is one)."""
    story = _own_story(db, story_id, current_user)
    state = aw.load_state(story)
    if not state:
        raise HTTPException(status_code=400, detail="This story isn't being written automatically")
    if aw.active_run(story_id):
        return aw.status_for(story, db)
    plan = aw.load_plan(story)
    if plan and aw.chapters_written(db, story_id) >= len(plan["chapters"]):
        raise HTTPException(status_code=400, detail="This story is already finished")
    _check_can_run(db, current_user)
    aw.start_run(story_id, current_user.id)
    return aw.status_for(story, db)


@router.post("/{story_id}/autowrite/stop")
async def stop_autowrite(story_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    _own_story(db, story_id, current_user)
    await aw.stop_run(story_id)
    db.expire_all()
    return aw.status_for(_own_story(db, story_id, current_user), db)


@router.post("/{story_id}/autowrite/steer")
def steer_autowrite(story_id: int, req: AutowriteSteerRequest, db: Session = Depends(get_db),
                    current_user: User = Depends(get_current_user)):
    """A note for the next chapter to be started; the run carries on."""
    story = _own_story(db, story_id, current_user)
    note = req.note.strip()[:aw.MAX_NOTE_CHARS]
    if not note:
        raise HTTPException(status_code=400, detail="The note is empty")
    state = aw.load_state(story)
    if not state:
        raise HTTPException(status_code=400, detail="This story isn't being written automatically")
    state.setdefault("steer", []).append({"note": note, "at": datetime.utcnow().isoformat()})
    story.autowrite = json.dumps(state)
    db.commit()
    return aw.status_for(story, db)


@router.get("/{story_id}/outline")
def get_outline(story_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """The hidden plan. Only fetched when the reader asks to see it."""
    story = _own_story(db, story_id, current_user)
    plan = aw.load_plan(story)
    if not plan:
        raise HTTPException(status_code=404, detail="This story has no outline")
    return plan
