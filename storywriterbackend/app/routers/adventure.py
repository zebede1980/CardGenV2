from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from typing import List, Optional
import asyncio
import json
import uuid

from app.database import get_db, SessionLocal
from app import models, schemas
from app.services.llm_service import LLMService
from app.routers.settings import get_or_create_settings
from app.routers.auth import get_current_user

router = APIRouter(prefix="/adventures", tags=["adventures"])

def build_adventure_prompt(session_data: models.AdventureSession, db: Session, max_input_tokens: int = None):
    messages = []
    history_messages = []
    
    # 1. System Prompt & Character Cards
    system_parts = [
        "You are an interactive fiction narrator running a 'Pick Your Own Adventure' story.",
        "You write in the 3rd person like a novel. You act as the game master and narrator.",
        "Always adhere strictly to the character definitions provided."
    ]
    
    for card in session_data.characters:
        card_text = f"Name: {card.name}\nDescription: {card.description}\nPersonality: {card.personality}\nScenario: {card.scenario}"
        system_parts.append(f"Character: {card.name}\n{card_text}")
        
    if session_data.summary:
        system_parts.append(f"Story Summary:\n{session_data.summary}")
        
    if getattr(session_data, "system_prompt", None):
        system_parts.append(session_data.system_prompt)
        
    prompt_base = [
        "CRITICAL INSTRUCTION FOR EVERY RESPONSE:\n",
        "First, write the next segment of the story naturally in structured paragraphs, using markdown for bolding and italics. You control all characters and the world itself.\n"
    ]
    
    if session_data.characters:
        char_names = ", ".join([c.name for c in session_data.characters])
        prompt_base.append(f"You MUST include and actively involve ALL {len(session_data.characters)} characters ({char_names}) in the story and scene. Do not leave anyone out.\n")
        
    prompt_base.extend([
        "Then, you MUST end your response by providing exactly 4 distinct choices for the NARRATIVE DIRECTION of the story.\n",
        "The choices should dictate what happens next in the scene, rather than just being a single character's dialogue or action. For example, an option could be 'Lightning strikes the tree', or 'A stranger interrupts', or 'The characters find a hidden trapdoor'.\n",
        "Format the choices EXACTLY like this at the very end of your response:\n",
        "[OPTION 1] First choice here\n",
        "[OPTION 2] Second choice here\n",
        "[OPTION 3] Third choice here\n",
        "[OPTION 4] Fourth choice here"
    ])
    
    system_parts.append("".join(prompt_base))
        
    messages.append({"role": "system", "content": "\n\n".join(system_parts)})
    
    # 2. Starting scenario if no actions exist
    if not session_data.actions and session_data.starting_scenario:
        messages.append({"role": "user", "content": f"Begin the adventure with this starting scenario: {session_data.starting_scenario}"})
    
    # 3. Action History
    for action in sorted(session_data.actions, key=lambda a: a.order_index):
        if action.is_summarized:
            continue
        
        # If user made a choice
        if action.role == "user":
            history_messages.append({"role": "user", "content": f"The user directs the story to: {action.content}"})
        # If assistant generated story
        elif action.role == "assistant":
            # We must include the options it generated so it knows the context of the user's next choice
            content = action.content
            if action.options:
                try:
                    options_list = json.loads(action.options)
                    options_str = "\n".join([f"[OPTION {i+1}] {opt}" for i, opt in enumerate(options_list)])
                    content += f"\n\n{options_str}"
                except:
                    pass
            history_messages.append({"role": "assistant", "content": content})
            
    # Truncate history to fit within max_input_tokens if provided
    if max_input_tokens:
        def estimate_tokens(msg_list):
            return sum(len(m.get("content", "")) // 4 for m in msg_list)
            
        system_tokens = estimate_tokens(messages)
        # Always keep at least the very last message
        while history_messages and (estimate_tokens(history_messages) + system_tokens > max_input_tokens) and len(history_messages) > 1:
            history_messages.pop(0)
            
    messages.extend(history_messages)
    return messages

async def summarize_adventure_task(session_id: str, user_id: int):
    # Duplicates the logic from chat summarization
    with SessionLocal() as bg_db:
        session_data = bg_db.query(models.AdventureSession).filter(
            models.AdventureSession.id == session_id,
            models.AdventureSession.user_id == str(user_id)
        ).first()
        if not session_data: return
        
        settings = get_or_create_settings(bg_db, user_id)
        
        unsummarized = bg_db.query(models.AdventureAction).filter(
            models.AdventureAction.session_id == session_id,
            models.AdventureAction.is_summarized == False
        ).order_by(models.AdventureAction.order_index.asc()).all()
        
        trigger_limit = settings.summary_threshold * 3
        keep_recent = settings.summary_threshold * 2
        
        if len(unsummarized) <= trigger_limit:
            return
            
        to_summarize = unsummarized[:-keep_recent]
        
        text_parts = []
        for a in to_summarize:
            if a.role == "user":
                text_parts.append(f"User direction: {a.content}")
            else:
                text_parts.append(f"Narrator: {a.content}")
        combined_text = "\n".join(text_parts)
        
        prompt = (
            "Summarize the following adventure story concisely. "
            "Focus on key events, decisions made, and character developments. "
            "Keep the final summary well-organized and strictly under 500 words."
        )
        if session_data.summary:
            prompt += f"\n\nIncorporate the new events into the existing summary seamlessly.\n\nExisting Summary:\n{session_data.summary}\n\nNew Events:\n{combined_text}"
        else:
            prompt += f"\n\nEvents:\n{combined_text}"
            
        llm = LLMService(settings)
        try:
            messages = [
                {"role": "system", "content": "You are a helpful assistant that summarizes narrative adventures."},
                {"role": "user", "content": prompt}
            ]
            
            content_parts = []
            async for chunk in llm.generate(messages, stream=True):
                content_parts.append(chunk)
            
            session_data.summary = "".join(content_parts)
            for a in to_summarize:
                a.is_summarized = True
            bg_db.commit()
        except Exception as e:
            print(f"Adventure Summarization error: {e}")
        finally:
            await llm.close()

@router.get("/", response_model=List[schemas.AdventureSessionOut])
def list_sessions(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return db.query(models.AdventureSession)\
        .filter(models.AdventureSession.user_id == str(current_user.id))\
        .order_by(models.AdventureSession.updated_at.desc())\
        .all()

@router.post("/", response_model=schemas.AdventureSessionDetailOut)
def create_session(session_in: schemas.AdventureSessionCreate, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    new_session = models.AdventureSession(
        user_id=str(current_user.id),
        title=session_in.title,
        starting_scenario=session_in.starting_scenario,
        system_prompt=session_in.system_prompt
    )
    db.add(new_session)
    db.flush()

    for card_id in session_in.card_ids:
        link = models.AdventureCharacterLink(adventure_id=new_session.id, card_id=card_id)
        db.add(link)
        
    db.commit()
    db.refresh(new_session)
    return new_session

@router.get("/{session_id}", response_model=schemas.AdventureSessionDetailOut)
def get_session(session_id: str, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    session_data = db.query(models.AdventureSession).filter(models.AdventureSession.id == session_id, models.AdventureSession.user_id == str(current_user.id)).first()
    if not session_data:
        raise HTTPException(status_code=404, detail="Adventure not found")
    return session_data

@router.delete("/{session_id}")
def delete_session(session_id: str, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    session_data = db.query(models.AdventureSession).filter(models.AdventureSession.id == session_id, models.AdventureSession.user_id == str(current_user.id)).first()
    if not session_data:
        raise HTTPException(status_code=404, detail="Adventure not found")
    db.delete(session_data)
    db.commit()
    return {"success": True}

@router.post("/{session_id}/action")
async def send_action(
    session_id: str,
    req: schemas.AdventureSendActionRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    session_data = db.query(models.AdventureSession).filter(
        models.AdventureSession.id == session_id, 
        models.AdventureSession.user_id == str(current_user.id)
    ).first()
    if not session_data:
        raise HTTPException(status_code=404, detail="Adventure not found")
        
    settings = get_or_create_settings(db, current_user.id)
    if not settings.api_key:
        raise HTTPException(status_code=400, detail="API key not configured.")
        
    queue = asyncio.Queue()
    
    current_actions = db.query(models.AdventureAction).filter(models.AdventureAction.session_id == session_id).all()
    next_order_index = len(current_actions)
    
    user_action = None
    if req.content and req.role == "user":
        user_action = models.AdventureAction(
            session_id=session_id,
            order_index=next_order_index,
            role="user",
            content=req.content
        )
        db.add(user_action)
        next_order_index += 1
        db.commit()
    
    prompt_messages = build_adventure_prompt(session_data, db, getattr(req, 'max_input_tokens', None))
    
    assistant_action = models.AdventureAction(
        session_id=session_id,
        order_index=next_order_index,
        role="assistant",
        content=""
    )
    db.add(assistant_action)
    db.commit()
    assistant_action_id = assistant_action.id
    
    log_id = str(uuid.uuid4())
    
    queue.put_nowait({
        "type": "api_log",
        "log": {
            "id": log_id,
            "endpoint": "Adventure Action Generation",
            "request": {"model": getattr(settings, 'model', 'unknown'), "messages": prompt_messages}
        }
    })
    
    queue.put_nowait({
        "type": "metadata", 
        "user_action_id": user_action.id if user_action else None,
        "assistant_action_id": assistant_action_id
    })
    
    gen_max_tokens = req.max_output_tokens
    gen_temperature = req.temperature
    gen_repetition_penalty = req.repetition_penalty

    async def generate_task():
        llm = LLMService(settings)
        try:
            content_parts = []
            async for chunk in llm.generate(prompt_messages, stream=True, max_tokens=gen_max_tokens, temperature=gen_temperature, repetition_penalty=gen_repetition_penalty):
                content_parts.append(chunk)
                await queue.put(chunk)
                
            full_content = "".join(content_parts)
            
            # Post-processing: extract the options from the text
            # Options format: [OPTION 1] Text ...
            import re
            options = []
            cleaned_story = full_content
            for i in range(1, 5):
                pattern = f"\[OPTION {i}\](.*?)(?=\[OPTION|$)"
                match = re.search(pattern, full_content, re.IGNORECASE | re.DOTALL)
                if match:
                    options.append(match.group(1).strip())
                    # remove from cleaned story
                    cleaned_story = re.sub(f"\[OPTION {i}\].*?(?=\[OPTION|$)", "", cleaned_story, flags=re.IGNORECASE | re.DOTALL)
            
            cleaned_story = cleaned_story.strip()
            
            await queue.put({
                "type": "api_log",
                "log": {
                    "id": log_id,
                    "endpoint": "Adventure Action Generation",
                    "response": full_content,
                    "usage": llm.last_usage
                }
            })
            
            # Persist to DB
            with SessionLocal() as bg_db:
                msg = bg_db.query(models.AdventureAction).filter(models.AdventureAction.id == assistant_action_id).first()
                if msg:
                    msg.content = cleaned_story
                    if options:
                        msg.options = json.dumps(options)
                    bg_db.commit()
                    
            await queue.put({"type": "parsed_options", "options": options, "cleaned_story": cleaned_story})
            await queue.put(None)
        except Exception as e:
            await queue.put(e)
        finally:
            await llm.close()
            
    asyncio.create_task(generate_task())
    asyncio.create_task(summarize_adventure_task(session_id, current_user.id))
    
    async def sse_generator():
        try:
            while True:
                item = await queue.get()
                if item is None:
                    break
                if isinstance(item, Exception):
                    yield f"data: {json.dumps({'type': 'error', 'message': str(item)})}\n\n"
                    break
                if isinstance(item, dict):
                    yield f"data: {json.dumps(item)}\n\n"
                    continue
                yield f"data: {json.dumps({'type': 'chunk', 'content': item})}\n\n"
            yield f"data: {json.dumps({'type': 'done'})}\n\n"
        except asyncio.CancelledError:
            pass
            
    return StreamingResponse(sse_generator(), media_type="text/event-stream")

@router.put('/{session_id}/actions/{action_id}', response_model=schemas.AdventureActionOut)
def update_action(session_id: str, action_id: str, payload: schemas.AdventureActionUpdate, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    session = db.query(models.AdventureSession).filter(models.AdventureSession.id == session_id, models.AdventureSession.user_id == current_user.id).first()
    if not session: raise HTTPException(status_code=404, detail='Session not found')
    action = db.query(models.AdventureAction).filter(models.AdventureAction.id == action_id, models.AdventureAction.session_id == session_id).first()
    if not action: raise HTTPException(status_code=404, detail='Action not found')
    action.content = payload.content
    db.commit()
    db.refresh(action)
    return action

@router.delete('/{session_id}/actions/{action_id}')
def delete_action(session_id: str, action_id: str, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    session = db.query(models.AdventureSession).filter(models.AdventureSession.id == session_id, models.AdventureSession.user_id == current_user.id).first()
    if not session: raise HTTPException(status_code=404, detail='Session not found')
    action = db.query(models.AdventureAction).filter(models.AdventureAction.id == action_id, models.AdventureAction.session_id == session_id).first()
    if not action: raise HTTPException(status_code=404, detail='Action not found')
    db.delete(action)
    db.commit()
    return {'status': 'ok'}

