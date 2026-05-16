from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from fastapi.responses import StreamingResponse
import json
import re

from app.database import get_db
from app.models import Story, StorySegment, Settings, SteeringInstruction, User
from app.schemas import GenerateRequest, StorySegmentOut, ImagePromptRequest
from app.services.llm_service import LLMService
from app.services.context_manager import ContextManager
from app.routers.auth import get_current_user

router = APIRouter(prefix="/generate", tags=["generation"])


def _trim_to_sentence(text: str) -> str:
    """Trim text to the last complete sentence boundary (.!?).
    Only trims if the boundary is at least halfway through the text,
    to avoid discarding too much content."""
    m = re.search(r'(.*[.!?][\'\")\]]*)', text, re.DOTALL)
    if m and len(m.group(1)) >= len(text) * 0.5:
        return m.group(1).rstrip()
    return text.rstrip()

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

            # If the model hit the token limit, trim to the last complete sentence
            if llm.finish_reason == "length":
                trimmed = _trim_to_sentence(full_content)
                if trimmed != full_content:
                    # Tell the client to replace the displayed text with the trimmed version
                    yield f"data: {json.dumps({'type': 'trim', 'content': trimmed})}\n\n"
                    full_content = trimmed

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


@router.post("/image-prompt")
async def generate_image_prompt(
    req: ImagePromptRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Generate a concise image-generation prompt describing the scene in a story segment."""
    story = db.query(Story).filter(Story.id == req.story_id, Story.user_id == current_user.id).first()
    if not story:
        raise HTTPException(status_code=404, detail="Story not found")

    target_seg = db.query(StorySegment).filter(
        StorySegment.id == req.segment_id,
        StorySegment.story_id == story.id,
    ).first()
    if not target_seg:
        raise HTTPException(status_code=404, detail="Segment not found")

    settings = get_or_create_settings(db, current_user.id)
    if not settings.api_key:
        raise HTTPException(status_code=400, detail="API key not configured. Please set it in Settings.")

    # Gather up to 2 preceding segments for scene context
    preceding = db.query(StorySegment).filter(
        StorySegment.story_id == story.id,
        StorySegment.order_index < target_seg.order_index,
    ).order_by(StorySegment.order_index.desc()).limit(2).all()
    preceding = list(reversed(preceding))

    context_text = "\n\n---\n\n".join(s.content for s in preceding) if preceding else ""
    scene_text = target_seg.content

    # Gather attached character card descriptions
    char_parts = []
    for sc in story.cards:
        card = sc.card
        parts = []
        if card.name:
            parts.append(f"Name: {card.name}")
        if card.description:
            parts.append(f"Description: {card.description}")
        if card.personality:
            parts.append(f"Personality: {card.personality}")
        if parts:
            char_parts.append("\n".join(parts))

    # Build the LLM request
    system_msg = (
        "You are an expert at writing prompts for AI image generators (Stable Diffusion, DALL-E, etc). "
        "Given a story excerpt and character descriptions, write a single concise image generation prompt "
        "that vividly captures the key scene. "
        "Output ONLY the prompt text — no explanation, no preamble, no quotes. "
        "Focus on: setting, lighting, mood, character appearance and pose, visual composition. "
        "Keep it under 200 words. Use descriptive comma-separated tags and phrases."
    )

    user_parts = []
    if char_parts:
        user_parts.append("Characters in the story:\n" + "\n\n".join(char_parts))
    if context_text:
        user_parts.append(f"Story context (preceding scenes):\n{context_text}")
    user_parts.append(f"Scene to illustrate:\n{scene_text}")
    user_parts.append("Write the image generation prompt:")

    messages = [
        {"role": "system", "content": system_msg},
        {"role": "user", "content": "\n\n".join(user_parts)},
    ]

    llm = LLMService(settings)
    try:
        prompt_text = ""
        async for chunk in llm.generate(messages, stream=False):
            prompt_text += chunk
        return {"prompt": prompt_text.strip()}
    finally:
        await llm.close()
