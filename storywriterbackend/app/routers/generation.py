from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from fastapi.responses import StreamingResponse
import json

from app.database import get_db
from app.models import Story, StorySegment, Settings, SteeringInstruction, User
from app.schemas import GenerateRequest, StorySegmentOut
from app.services.llm_service import LLMService
from app.services.context_manager import ContextManager
from app.routers.auth import get_current_user

router = APIRouter(prefix="/generate", tags=["generation"])

def get_or_create_settings(db: Session, user_id: int) -> Settings:
    settings = db.query(Settings).filter(Settings.user_id == user_id).first()
    if not settings:
        settings = Settings(user_id=user_id)
        db.add(settings)
        db.commit()
        db.refresh(settings)
    return settings

@router.post("/")
async def generate_story_chunk(req: GenerateRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    story = db.query(Story).filter(Story.id == req.story_id, Story.user_id == current_user.id).first()
    if not story:
        raise HTTPException(status_code=404, detail="Story not found")
    
    settings = get_or_create_settings(db, current_user.id)
    if not settings.api_key:
        raise HTTPException(status_code=400, detail="API key not configured. Please set it in Settings.")
    
    # Save steering instruction if provided
    if req.steering:
        steering = SteeringInstruction(story_id=req.story_id, instruction=req.steering)
        db.add(steering)
        db.commit()
    
    # Build context
    ctx_mgr = ContextManager(db, settings)
    messages = ctx_mgr.build_prompt(story, steering=req.steering)
    
    # Summarize old segments if needed
    segments = db.query(StorySegment).filter(
        StorySegment.story_id == story.id
    ).order_by(StorySegment.order_index).all()
    
    if ctx_mgr.should_summarize(segments):
        to_summarize = ctx_mgr.get_segments_to_summarize(segments)
        llm = LLMService(settings)
        try:
            combined_text = "\n\n".join([s.content for s in to_summarize])
            summary_text = await llm.summarize(combined_text)
            
            # Create summary segment
            min_order = min(s.order_index for s in to_summarize)
            summary_seg = StorySegment(
                story_id=story.id,
                order_index=min_order,
                content=summary_text,
                is_summary=True
            )
            db.add(summary_seg)
            
            # Remove old segments
            for s in to_summarize:
                db.delete(s)
            db.commit()
            
            # Reorder
            remaining = db.query(StorySegment).filter(
                StorySegment.story_id == story.id
            ).order_by(StorySegment.order_index).all()
            for i, s in enumerate(remaining):
                s.order_index = i
            db.commit()
            
            # Rebuild context after summarization
            segments = db.query(StorySegment).filter(
                StorySegment.story_id == story.id
            ).order_by(StorySegment.order_index).all()
            messages = ctx_mgr.build_prompt(story, steering=req.steering)
        finally:
            await llm.close()
    
    # Generate new segment
    llm = LLMService(settings)
    
    async def stream_generator():
        content_parts = []
        try:
            async for chunk in llm.generate(messages, stream=True):
                content_parts.append(chunk)
                yield f"data: {json.dumps({'type': 'chunk', 'content': chunk})}\n\n"
            
            full_content = "".join(content_parts)
            # Save segment
            max_order = db.query(StorySegment).filter(
                StorySegment.story_id == story.id
            ).count()
            seg = StorySegment(
                story_id=story.id,
                order_index=max_order,
                content=full_content
            )
            db.add(seg)
            db.commit()
            db.refresh(seg)
            
            done_payload = {
                'type': 'done',
                'segment': {
                    'id': seg.id,
                    'story_id': seg.story_id,
                    'order_index': seg.order_index,
                    'content': seg.content,
                    'summary': seg.summary,
                    'is_summary': seg.is_summary,
                    'created_at': seg.created_at.isoformat()
                }
            }
            yield f"data: {json.dumps(done_payload)}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"
        finally:
            await llm.close()
    
    return StreamingResponse(stream_generator(), media_type="text/event-stream")

@router.post("/summarize")
async def summarize_story(story_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    story = db.query(Story).filter(Story.id == story_id, Story.user_id == current_user.id).first()
    if not story:
        raise HTTPException(status_code=404, detail="Story not found")
    
    settings = get_or_create_settings(db, current_user.id)
    segments = db.query(StorySegment).filter(
        StorySegment.story_id == story.id
    ).order_by(StorySegment.order_index).all()
    
    ctx_mgr = ContextManager(db, settings)
    if not ctx_mgr.should_summarize(segments):
        return {"detail": "Not enough segments to summarize yet"}
    
    to_summarize = ctx_mgr.get_segments_to_summarize(segments)
    llm = LLMService(settings)
    try:
        combined_text = "\n\n".join([s.content for s in to_summarize])
        summary_text = await llm.summarize(combined_text)
        
        min_order = min(s.order_index for s in to_summarize)
        summary_seg = StorySegment(
            story_id=story.id,
            order_index=min_order,
            content=summary_text,
            is_summary=True
        )
        db.add(summary_seg)
        
        for s in to_summarize:
            db.delete(s)
        db.commit()
        
        remaining = db.query(StorySegment).filter(
            StorySegment.story_id == story.id
        ).order_by(StorySegment.order_index).all()
        for i, s in enumerate(remaining):
            s.order_index = i
        db.commit()
        
        return {"detail": "Summarized successfully", "summary": summary_text}
    finally:
        await llm.close()
