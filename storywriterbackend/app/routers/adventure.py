from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload, selectinload
from typing import List, Optional
from datetime import datetime
import asyncio
import json
import uuid
import logging
import re

from app.database import get_db, SessionLocal
from app import models, schemas
from app.services.llm_service import LLMService, UTILITY_TEMPERATURE, with_think_tags, strip_think, needs_prose, prose_after_reasoning, supports_reasoning_flag
from app.services.card_parser import extract_relevant_lorebook_entries
from app.services.gen_stream import sse_from_queue, close_open_think, trim_cut_reply
from app.services.story_autowriter import name_story
from app.routers.settings import get_or_create_settings
from app.routers.auth import get_current_user

router = APIRouter(prefix="/adventures", tags=["adventures"])
logger = logging.getLogger(__name__)

# Running beat generations by the assistant placeholder's id. Stop cancels the
# task through this, and it tells a live placeholder from one orphaned by a
# backend restart (which would otherwise read as "still writing" for ever).
# One uvicorn worker, so in-process is enough.
_ACTIVE: dict = {}
_STARTING = object()  # placeholder committed, task not created yet

DEFAULT_TITLE_PREFIX = "Adventure "
DEFAULT_MAX_INPUT_TOKENS = 8192

ADVENTURE_NATIVE_COT_PROMPT = (
    "CHAIN OF THOUGHT (5-Phase Logic):\n"
    "Before writing, think privately through the 5-Phase Logic: "
    "1) Ground Truth (setting, time, current reality), 2) NPC Knowledge (what the characters know and don't), "
    "3) Intent (goal for this turn), 4) Draft (plan the action/dialogue), "
    "5) Self-Correct (persona fit, avoid repetition). "
    "Your visible response is only the story section followed by the four [OPTION] choices."
)


def _sub_macros(text: str, char_name: str, user_name: str = "the user") -> str:
    """Cards are written for chat front-ends; {{char}}/{{user}} reached the model literally."""
    if not text:
        return ""
    text = re.sub(r"\{\{\s*char\s*\}\}", char_name, text, flags=re.IGNORECASE)
    return re.sub(r"\{\{\s*user\s*\}\}", user_name, text, flags=re.IGNORECASE)


def _options_list(raw) -> list:
    """Stored options as [{text, risk}]. Rows from before 2026-11 hold plain strings."""
    try:
        items = json.loads(raw) if raw else []
    except (TypeError, ValueError):
        return []
    out = []
    for item in items if isinstance(items, list) else []:
        if isinstance(item, str) and item.strip():
            out.append({"text": item.strip(), "risk": ""})
        elif isinstance(item, dict) and str(item.get("text", "")).strip():
            out.append({"text": str(item["text"]).strip(), "risk": item.get("risk") or ""})
    return out


def build_adventure_prompt(session_data: models.AdventureSession, db: Session, max_input_tokens: int = None, enable_cot: bool = True, native_reasoning: bool = False):
    messages = []
    history_messages = []
    user_name = "the user"
    actions = sorted(session_data.actions, key=lambda x: x.order_index)

    # 1. System Prompt & Character Cards
    system_parts = [
        "You are an interactive fiction narrator running a 'Pick Your Own Adventure' story.",
        "You write in the 3rd person like a novel. You act as the game master and narrator.",
        "Always adhere strictly to the character definitions provided."
    ]

    # Lorebook keywords are matched against the recent story, not the model's planning.
    recent_history_text = " ".join(strip_think(a.content or "") for a in actions[-5:])

    for card in session_data.characters:
        name = card.name or "Character"
        sub = lambda t: _sub_macros(t, name, user_name)
        card_text = f"Name: {name}\nDescription: {sub(card.description)}\nPersonality: {sub(card.personality)}\nScenario: {sub(card.scenario)}"

        if card.mes_example:
            card_text += f"\nExample Messages:\n{sub(card.mes_example)}"

        # Per-card system prompt (card-level instructions from the card author)
        if card.system_prompt:
            card_text += f"\nCharacter Instructions:\n{sub(card.system_prompt)}"

        if card.character_book:
            relevant_lore = extract_relevant_lorebook_entries(card.character_book, recent_history_text)
            if relevant_lore:
                card_text += "\nLorebook:\n" + "\n".join(sub(entry) for entry in relevant_lore)

        system_parts.append(f"Character: {name}\n{card_text}")

    if session_data.summary:
        system_parts.append(f"Story Summary:\n{session_data.summary}")

    cot_prompt = "CHAIN OF THOUGHT (5-Phase Logic):\nBefore you write any roleplay dialogue or actions, you MUST process your reasoning. You must wrap your entire reasoning process within <think> and </think> tags. Inside the <think> block, strictly follow this 5-Phase Logic:\n- Phase 1: Build Ground Truth (Establish the physical setting, time, and current reality)\n- Phase 2: Map NPC Knowledge (Determine exactly what your character(s) know and don't know right now)\n- Phase 3: Identify Intent (Decide the goal or motivation for this specific turn)\n- Phase 4: Draft the Action/Dialogue (Plan what the character will do or say)\n- Phase 5: Self-Correct (Review against character persona and constraints, adjusting if necessary to avoid repetition or breaking character)\n\nOnly after closing the </think> tag should you write the actual prose for the user. Closing </think> is NOT the end of your response: the story section and the four [OPTION] choices must always follow it."

    # [NATIVE-REASONING 2026-10-01] When the provider returns the model's own
    # reasoning, the phases go there instead. Telling such a model to *start its
    # response* with <think> made it treat the reasoning as the whole turn and
    # stop: measured 6/6 needing a follow-up call (median 31s) vs 0/6 (17s) with
    # this wording. The tag-based wording stays for providers without it.
    if native_reasoning:
        cot_prompt = ADVENTURE_NATIVE_COT_PROMPT

    sys_prompt = getattr(session_data, "system_prompt", "") or ""
    if enable_cot:
        if sys_prompt and "CHAIN OF THOUGHT" not in sys_prompt:
            sys_prompt = sys_prompt + "\n\n" + cot_prompt
        elif not sys_prompt:
            sys_prompt = cot_prompt

    if sys_prompt:
        system_parts.append(sys_prompt)

    prompt_base = [
        "CRITICAL INSTRUCTION FOR EVERY RESPONSE:\n",
        "First, write a substantial, well-developed next section of the story. ",
        "Format your output as flowing prose: use standard paragraph breaks (one blank line between paragraphs). ",
        "Do not use bullet points, numbered lists, headers, bold text, or any other special formatting for the story text. ",
        "Keep paragraphs dense and readable — avoid single-sentence paragraphs or excessive line breaks. ",
        "Do not include meta-commentary, do not acknowledge the user or instructions. ",
        "You control all characters and the world itself.\n"
    ]

    if session_data.characters:
        char_names = ", ".join([c.name for c in session_data.characters])
        prompt_base.append(f"\nYou MUST include and actively involve ALL {len(session_data.characters)} characters ({char_names}) in the story and scene. Do not leave anyone out.\n")

    prompt_base.extend([
        "\nThen, you MUST end your response by providing exactly 4 distinct choices for the NARRATIVE DIRECTION of the story.\n",
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
    if not [a for a in actions if a.role == "assistant" and a.content] and session_data.starting_scenario:
        messages.append({"role": "user", "content": f"Begin the adventure with this starting scenario: {session_data.starting_scenario}"})

    # 3. Action History
    for action in actions:
        if action.is_summarized or not action.content:
            continue
        if action.role == "user":
            history_messages.append({"role": "user", "content": f"The user directs the story to: {action.content}"})
        elif action.role == "assistant":
            # The options go back in so the model knows what the next choice was
            # picked from. Reasoning is dropped: it's transient planning, and
            # keeping it in context makes models echo it outside the tags.
            content = strip_think(action.content)
            options = _options_list(action.options)
            if options:
                content += "\n\n" + "\n".join(f"[OPTION {i+1}] {o['text']}" for i, o in enumerate(options))
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

    post_history_parts = []
    for card in session_data.characters:
        if card.post_history_instructions:
            post_history_parts.append(f"[{card.name} Note]: {_sub_macros(card.post_history_instructions, card.name or 'Character', user_name)}")

    if post_history_parts:
        messages.append({"role": "system", "content": "\n\n".join(post_history_parts)})

    if enable_cot and not native_reasoning and ("CHAIN OF THOUGHT" in sys_prompt or "CHAIN OF THOUGHT" in cot_prompt):
        messages.append({"role": "system", "content": "Reminder: You MUST start your response with <think> to process your 5-Phase Logic, and only write the story prose/actions after closing the </think> tag. "
            "Finishing the 5 phases is not the end of your turn — the story section and the four [OPTION] choices must always follow."})

    return messages

# Follow-up instruction when a generation stopped after its plan with no story.
ADVENTURE_CONTINUE_INSTRUCTION = (
    "Continue directly from your plan above. Write ONLY the next story section now — "
    "no reasoning, no tags, no restating the plan — then end with exactly 4 choices "
    "in the [OPTION 1] … [OPTION 4] format."
)

# Follow-up when a beat arrived without (all of) its choices.
OPTIONS_REPAIR_INSTRUCTION = (
    "Your story section is above, but its four choices are missing or incomplete. "
    "Do not continue or repeat the story. Reply with ONLY four short, distinct choices for "
    "what happens next, one per line, exactly like this:\n"
    "[OPTION 1] First choice\n[OPTION 2] Second choice\n[OPTION 3] Third choice\n[OPTION 4] Fourth choice"
)

# ── Splitting the choices off a beat ─────────────────────────────────────────
# Models write the markers in many shapes: [OPTION 1], **[Option 1]:**,
# OPTION 1 -, or a closing <options> block of numbered lines.
_OPTION_MARK = re.compile(
    r"(?:^|(?<=\n))[ \t>*_#-]*\[\s*option\s*([1-4])\s*\][*_]*[ \t]*[:.)\-–—]?[ \t]*"
    r"|(?:^|(?<=\n))[ \t>*_#-]*[*_]*option\s*([1-4])[*_]*[ \t]*[:.)\-–—][ \t]*"
    r"|\[\s*option\s*([1-4])\s*\][*_]*[ \t]*[:.)\-–—]?[ \t]*",
    re.IGNORECASE,
)
_OPTIONS_BLOCK = re.compile(r"<options>([\s\S]*?)(?:</options>|$)", re.IGNORECASE)
_RISK_TAG = re.compile(r"^\s*[\[(]\s*(safe|risky)\s*[\])]\s*[:\-–—]?\s*", re.IGNORECASE)
_LIST_MARK = re.compile(r"^\s*(?:[-*•]|\d+[.)]|\[\s*option\s*\d\s*\][:.)]?|option\s*\d\s*[:.)\-–—])\s*", re.IGNORECASE)
_TRAILING_HEADING = re.compile(
    r"(?:\n[ \t]*(?:[-*_]{3,}|[*_#\s]*(?:choices|options|what (?:happens|will you do|do you do)[^\n]{0,40})[*_:\s?]*))+\s*$",
    re.IGNORECASE,
)


def _clean_option(text: str) -> Optional[dict]:
    text = text.strip()
    risk = ""
    for _ in range(2):  # risk tag before or after the list marker
        text = _LIST_MARK.sub("", text, count=1)
        m = _RISK_TAG.match(text)
        if m:
            risk = m.group(1).lower()
            text = text[m.end():]
    text = re.sub(r"^[*_\s\"“]+|[*_\s\"”]+$", "", text)
    text = re.sub(r"\s+", " ", text)
    return {"text": text[:300], "risk": risk} if text else None


def split_adventure_options(full_content: str) -> tuple[str, list]:
    """Pull the closing choices off a generated beat.
    Returns (story text to store, [{text, risk}]). Choices are only looked for
    after the reasoning: the Draft phase often sketches candidates that aren't
    the final ones. The <think> block is kept on the stored story so it stays
    viewable, and stripped wherever the text is fed back to a model."""
    close_idx = full_content.rfind("</think>")
    think_part = full_content[:close_idx + len("</think>")] if close_idx >= 0 else ""
    story_part = full_content[close_idx + len("</think>"):] if close_idx >= 0 else full_content

    options = []
    story = story_part
    blocks = list(_OPTIONS_BLOCK.finditer(story_part))
    if blocks:
        block = blocks[-1]
        story = story_part[:block.start()]
        for line in block.group(1).splitlines():
            opt = _clean_option(line)
            if opt:
                options.append(opt)
    else:
        marks = [m for m in _OPTION_MARK.finditer(story_part)]
        # The last run that starts at 1: drafts or a recap earlier on don't count.
        start = max((i for i, m in enumerate(marks) if (m.group(1) or m.group(2) or m.group(3)) == "1"), default=None)
        if start is not None:
            run = marks[start:start + 4]
            story = story_part[:run[0].start()]
            for i, m in enumerate(run):
                end = run[i + 1].start() if i + 1 < len(run) else len(story_part)
                text = story_part[m.end():end]
                if i + 1 == len(run):
                    text = re.split(r"\n\s*\n", text.strip(), maxsplit=1)[0]  # commentary after the last one
                opt = _clean_option(text)
                if opt:
                    options.append(opt)

    story = _TRAILING_HEADING.sub("", story.rstrip()).strip()
    if story and think_part:
        story = f"{think_part}\n{story}"
    return story, options[:4]


async def _repair_options(llm: LLMService, prompt_messages: list, story: str, gen_kwargs: dict) -> list:
    """Ask for just the choices when the beat came without four of them."""
    messages = prompt_messages + [
        {"role": "assistant", "content": strip_think(story)},
        {"role": "user", "content": OPTIONS_REPAIR_INSTRUCTION},
    ]
    out = ""
    async for chunk in llm.generate(messages, stream=True, **gen_kwargs):
        out += chunk
    _, options = split_adventure_options(close_open_think(out))
    return options


# [ADVENTURE-CONTEXT-SCALING 2026-08-12] ─────────────────────────────────────
# Same fix as chat.py's summarize_chat_task (this function was a deliberate
# duplicate of it, per the original comment below) — the old trigger was a
# fixed message count (summary_threshold * 3) with no regard for the model's
# actual context window. Scales off max_input_tokens instead, falling back to
# the old count-based behavior if that isn't provided. See the longer comment
# above summarize_chat_task() in chat.py for the full rationale.
ADVENTURE_RESERVED_SYSTEM_OVERHEAD_TOKENS = 3000
ADVENTURE_MIN_HISTORY_TOKEN_BUDGET = 2000
ADVENTURE_KEEP_RAW_FRACTION = 2 / 3

async def summarize_adventure_task(session_id: str, user_id: int, max_input_tokens: int = None):
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

        def _action_tokens(a):
            return len(a.content or "") // 4

        if max_input_tokens:
            history_token_budget = max(ADVENTURE_MIN_HISTORY_TOKEN_BUDGET, max_input_tokens - ADVENTURE_RESERVED_SYSTEM_OVERHEAD_TOKENS)
            total_tokens = sum(_action_tokens(a) for a in unsummarized)

            if total_tokens <= history_token_budget:
                return

            keep_budget = history_token_budget * ADVENTURE_KEEP_RAW_FRACTION
            kept_tokens = 0
            keep_count = 0
            for a in reversed(unsummarized):
                t = _action_tokens(a)
                if kept_tokens + t > keep_budget and keep_count > 0:
                    break
                kept_tokens += t
                keep_count += 1

            to_summarize = unsummarized[:-keep_count] if keep_count else []
        else:
            trigger_limit = settings.summary_threshold * 3
            keep_recent = settings.summary_threshold * 2

            if len(unsummarized) <= trigger_limit:
                return

            to_summarize = unsummarized[:-keep_recent]

        if not to_summarize:
            return

        text_parts = []
        for a in to_summarize:
            if a.role == "user":
                text_parts.append(f"User direction: {a.content}")
            else:
                text_parts.append(f"Narrator: {strip_think(a.content)}")
        combined_text = "\n".join(text_parts)

        prompt = (
            "Write a detailed and comprehensive summary of the following adventure story. "
            "It is crucial to retain important context, key events, decisions made, and character developments and personality. "
            "Do NOT summarize too aggressively—preserving the rich context of the story is more important than brevity. "
            "Keep the final summary well-organized, using paragraphs or bullet points to track the narrative flow."
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
            # Utility task: must not inherit the user's creative temperature.
            async for chunk in llm.generate(messages, stream=True, temperature=UTILITY_TEMPERATURE):
                content_parts.append(chunk)

            summary = strip_think("".join(content_parts)).strip()
            if summary:
                session_data.summary = summary
                for a in to_summarize:
                    a.is_summarized = True
                bg_db.commit()
        except Exception as e:
            logger.error(f"Adventure summarization error: {e}")
        finally:
            await llm.close()


# ── Helpers ──────────────────────────────────────────────────────────────────

def _get_session(db: Session, session_id: str, user) -> models.AdventureSession:
    s = db.query(models.AdventureSession).filter(
        models.AdventureSession.id == session_id,
        models.AdventureSession.user_id == str(user.id),
    ).first()
    if not s:
        raise HTTPException(status_code=404, detail="Adventure not found")
    return s


def _get_action(db: Session, session_id: str, action_id: str) -> models.AdventureAction:
    a = db.query(models.AdventureAction).filter(
        models.AdventureAction.id == action_id, models.AdventureAction.session_id == session_id
    ).first()
    if not a:
        raise HTTPException(status_code=404, detail="Action not found")
    return a


def _next_index(db: Session, session_id: str) -> int:
    # max+1, not a count: after a delete in the middle a count reuses a live index.
    top = db.query(func.max(models.AdventureAction.order_index)).filter(
        models.AdventureAction.session_id == session_id).scalar()
    return 0 if top is None else top + 1


def _drop_orphans(db: Session, session_data: models.AdventureSession) -> None:
    """An empty assistant placeholder with no task behind it was left by a
    restart mid-beat. Remove it so the adventure doesn't read as "writing" for ever."""
    dead = [a for a in session_data.actions if a.role == "assistant" and not a.content and a.id not in _ACTIVE]
    for a in dead:
        db.delete(a)
    if dead:
        db.commit()
        db.refresh(session_data)


def _excerpt(session_data: models.AdventureSession) -> str:
    for a in reversed(session_data.actions):
        if a.role == "assistant" and a.content:
            text = re.sub(r"\s+", " ", strip_think(a.content)).strip()
            return text[:160] + ("…" if len(text) > 160 else "")
    return (session_data.starting_scenario or "")[:160]


def _is_default_title(title: str) -> bool:
    return not title or title.startswith(DEFAULT_TITLE_PREFIX) or title == "New Adventure"


# ── Routes ───────────────────────────────────────────────────────────────────

@router.get("/", response_model=List[schemas.AdventureSessionListOut])
def list_sessions(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    sessions = db.query(models.AdventureSession)\
        .options(selectinload(models.AdventureSession.characters), selectinload(models.AdventureSession.actions))\
        .filter(models.AdventureSession.user_id == str(current_user.id))\
        .order_by(models.AdventureSession.updated_at.desc())\
        .all()
    return [
        schemas.AdventureSessionListOut(
            id=s.id, title=s.title, created_at=s.created_at, updated_at=s.updated_at or s.created_at,
            characters=[schemas.AdventureCharacterOut(id=c.id, name=c.name or "") for c in s.characters],
            beats=sum(1 for a in s.actions if a.role == "assistant" and a.content),
            excerpt=_excerpt(s),
        )
        for s in sessions
    ]

@router.post("/", response_model=schemas.AdventureSessionDetailOut)
def create_session(session_in: schemas.AdventureSessionCreate, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    title = (session_in.title or "").strip()
    new_session = models.AdventureSession(
        user_id=str(current_user.id),
        title=title or DEFAULT_TITLE_PREFIX + datetime.utcnow().strftime("%d %b %Y"),
        title_auto=not title,
        starting_scenario=session_in.starting_scenario,
        system_prompt=session_in.system_prompt,
        play_config=json.dumps(session_in.config or {}),
    )
    db.add(new_session)
    db.flush()

    for card_id in dict.fromkeys(session_in.card_ids):
        link = models.AdventureCharacterLink(adventure_id=new_session.id, card_id=card_id)
        db.add(link)

    db.commit()
    db.refresh(new_session)
    return new_session

@router.get("/{session_id}", response_model=schemas.AdventureSessionDetailOut)
def get_session(session_id: str, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    session_data = _get_session(db, session_id, current_user)
    _drop_orphans(db, session_data)
    return session_data

@router.patch("/{session_id}", response_model=schemas.AdventureSessionOut)
def update_session(session_id: str, payload: schemas.AdventureSessionUpdate, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    session_data = _get_session(db, session_id, current_user)
    if payload.title is not None and payload.title.strip():
        session_data.title = payload.title.strip()[:200]
        session_data.title_auto = False
    if payload.starting_scenario is not None:
        session_data.starting_scenario = payload.starting_scenario
    if payload.summary is not None:
        session_data.summary = payload.summary
    if payload.system_prompt is not None:
        session_data.system_prompt = payload.system_prompt
    if payload.config is not None:
        session_data.play_config = json.dumps({**session_data.config, **payload.config})
    if payload.journal is not None:
        session_data.journal = json.dumps(payload.journal)
    db.commit()
    db.refresh(session_data)
    return session_data

@router.delete("/{session_id}")
def delete_session(session_id: str, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    session_data = _get_session(db, session_id, current_user)
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
    session_data = _get_session(db, session_id, current_user)
    settings = get_or_create_settings(db, current_user.id)
    if not settings.api_key:
        raise HTTPException(status_code=400, detail="API key not configured.")

    _drop_orphans(db, session_data)
    if any(a.role == "assistant" and not a.content for a in session_data.actions):
        raise HTTPException(status_code=409, detail="The narrator is already writing the next beat.")

    queue = asyncio.Queue()

    previous_reply = None
    if req.kind == "regen":
        # Replace the latest beat: delete it here, in the same request, so a
        # dropped connection can't leave the story with no beat and no choice.
        last = max(session_data.actions, key=lambda a: a.order_index, default=None)
        if last is not None and last.role == "assistant":
            previous_reply = (req.previous_reply or strip_think(last.content or ""))[:1500]
            db.delete(last)
            db.commit()
            db.refresh(session_data)

    next_order_index = _next_index(db, session_id)

    user_action = None
    if req.content and req.role == "user":
        user_action = models.AdventureAction(
            session_id=session_id,
            order_index=next_order_index,
            role="user",
            content=req.content.strip()[:2000],
        )
        db.add(user_action)
        next_order_index += 1

    session_data.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(session_data)

    max_input = req.max_input_tokens or DEFAULT_MAX_INPUT_TOKENS
    enable_cot = req.enable_cot is not False
    prompt_messages = build_adventure_prompt(session_data, db, max_input, enable_cot,
                                             native_reasoning=supports_reasoning_flag(settings.api_base_url))

    assistant_action = models.AdventureAction(
        session_id=session_id,
        order_index=next_order_index,
        role="assistant",
        content=""
    )
    db.add(assistant_action)
    db.flush()
    assistant_action_id = assistant_action.id
    _ACTIVE[assistant_action_id] = _STARTING
    db.commit()

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
        "assistant_action_id": assistant_action_id,
        "roll": None,
    })

    gen_kwargs = {
        "max_tokens": req.max_output_tokens,
        "temperature": req.temperature,
        "repetition_penalty": req.repetition_penalty,
        "presence_penalty": req.presence_penalty,
        "top_p": req.top_p,
    }
    user_id = current_user.id
    want_title = bool(session_data.title_auto) and _is_default_title(session_data.title)

    async def generate_task():
        llm = LLMService(settings)
        full_content = ""
        error = None
        cancelled = False
        request_id = str(uuid.uuid4())
        logger.info(f"[{request_id}] Adventure beat started for {session_id}, action {assistant_action_id}")
        try:
            try:
                # [NATIVE-REASONING 2026-10-01] see with_think_tags() in llm_service
                stream = llm.generate(prompt_messages, stream=True, **gen_kwargs,
                                      request_reasoning=enable_cot, yield_reasoning=True)
                async for chunk in with_think_tags(stream):
                    full_content += chunk
                    await queue.put(chunk)

                # Reasoning but no reply after it — ask for the reply on its own.
                if needs_prose(full_content):
                    logger.info(f"[{request_id}] Reasoning with no prose — requesting the reply")
                    async for chunk in prose_after_reasoning(llm, prompt_messages, full_content, ADVENTURE_CONTINUE_INSTRUCTION, **gen_kwargs):
                        full_content += chunk
                        await queue.put(chunk)

                story, options = split_adventure_options(close_open_think(full_content))
                if len(options) < 4 and strip_think(story).strip():
                    # Cut off at the ceiling, or the model forgot them: end the
                    # prose on a sentence and ask for just the choices.
                    if llm.finish_reason == "length":
                        full_content = trim_cut_reply(close_open_think(full_content))
                    logger.info(f"[{request_id}] Beat came with {len(options)} choices — asking for them")
                    await queue.put({"type": "status", "message": "Choosing the options…"})
                    try:
                        repaired = await _repair_options(llm, prompt_messages, story, gen_kwargs)
                        if len(repaired) >= len(options):
                            story, _ = split_adventure_options(close_open_think(full_content))
                            full_content = story + "\n\n" + "\n".join(f"[OPTION {i+1}] {o['text']}" for i, o in enumerate(repaired))
                    except Exception as rep_err:
                        logger.error(f"[{request_id}] Options follow-up failed: {rep_err}")

                await queue.put({
                    "type": "api_log",
                    "log": {
                        "id": log_id,
                        "endpoint": "Adventure Action Generation",
                        "response": {"choices": [{"message": {"content": full_content}}], "usage": llm.last_usage},
                        "usage": llm.last_usage
                    }
                })
            except asyncio.CancelledError:
                # Stop pressed (see cancel_generation): keep what arrived.
                cancelled = True
                logger.info(f"[{request_id}] Beat stopped by the user after {len(full_content)} chars")
            except Exception as e:
                # The error goes to the browser only. It used to be stored in
                # the beat, where the next turn fed it to the model as story.
                error = e
                logger.error(f"[{request_id}] Adventure beat failed: {e}")

            story, options = split_adventure_options(close_open_think(full_content))
            saved = bool(strip_think(story).strip())
            try:
                with SessionLocal() as bg_db:
                    msg = bg_db.query(models.AdventureAction).filter(models.AdventureAction.id == assistant_action_id).first()
                    if msg:
                        if saved:
                            msg.content = story
                            msg.options = json.dumps(options)
                        else:
                            bg_db.delete(msg)
                        bg_db.commit()
            except Exception as db_err:
                saved = False
                logger.error(f"[{request_id}] DB save failed: {db_err}")

            await queue.put({"type": "final", "action_id": assistant_action_id, "deleted": not saved,
                             "story": story if saved else "", "options": options if saved else []})
            if error is not None:
                await queue.put(error)
            elif saved and not cancelled and want_title:
                await _auto_title(llm, session_id, queue)
        finally:
            await llm.close()
            await queue.put(None)

    gen_task = asyncio.create_task(generate_task())
    _ACTIVE[assistant_action_id] = gen_task
    gen_task.add_done_callback(lambda t: _ACTIVE.pop(assistant_action_id, None))

    async def after():
        await asyncio.wait({gen_task})
        # [ADVENTURE-CONTEXT-SCALING 2026-08-12] the input budget scales the summary trigger.
        await summarize_adventure_task(session_id, user_id, max_input)

    asyncio.create_task(after())
    return StreamingResponse(sse_from_queue(queue), media_type="text/event-stream")


async def _auto_title(llm: LLMService, session_id: str, queue) -> None:
    """Name a new adventure after its first beat (until the user renames it)."""
    try:
        with SessionLocal() as bg_db:
            s = bg_db.query(models.AdventureSession).filter(models.AdventureSession.id == session_id).first()
            if not s or not s.title_auto:
                return
            text = next((strip_think(a.content) for a in s.actions if a.role == "assistant" and a.content), "")
            cards = list(s.characters)
        title = await name_story(llm, cards, text)
        if not title:
            return
        with SessionLocal() as bg_db:
            s = bg_db.query(models.AdventureSession).filter(models.AdventureSession.id == session_id).first()
            if not s or not s.title_auto:
                return
            s.title = title
            s.title_auto = False
            bg_db.commit()
        await queue.put({"type": "title", "title": title})
    except Exception as e:
        logger.warning(f"Adventure auto-title failed: {e}")


@router.post("/{session_id}/actions/{action_id}/cancel")
async def cancel_generation(session_id: str, action_id: str, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Stop a beat on the server too: closing the socket alone left the model
    writing (and paid for) the whole thing."""
    _get_session(db, session_id, current_user)
    task = _ACTIVE.get(action_id)
    cancelled = False
    if isinstance(task, asyncio.Task) and not task.done():
        task.cancel()
        cancelled = True
        try:
            # The task swallows the cancellation, saves, and ends normally.
            await asyncio.wait_for(asyncio.shield(task), timeout=15)
        except Exception as e:
            logger.warning(f"cancel_generation: task for {action_id} did not settle cleanly: {e}")
    action = db.query(models.AdventureAction).filter(
        models.AdventureAction.id == action_id, models.AdventureAction.session_id == session_id).first()
    if action is None:
        return {"cancelled": cancelled, "deleted": True, "content": "", "options": []}
    db.refresh(action)
    return {"cancelled": cancelled, "deleted": False, "content": action.content, "options": _options_list(action.options)}


@router.put('/{session_id}/actions/{action_id}', response_model=schemas.AdventureActionOut)
def update_action(session_id: str, action_id: str, payload: schemas.AdventureActionUpdate, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    _get_session(db, session_id, current_user)
    action = _get_action(db, session_id, action_id)
    content = payload.content.strip()
    # The editor shows the prose only; keep the beat's reasoning block.
    old = action.content or ""
    close = old.rfind("</think>")
    if "<think>" not in content and close >= 0:
        content = old[:close + len("</think>")] + "\n" + content
    action.content = content
    db.commit()
    db.refresh(action)
    return action

@router.delete('/{session_id}/actions/{action_id}')
def delete_action(session_id: str, action_id: str, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    _get_session(db, session_id, current_user)
    action = db.query(models.AdventureAction).filter(models.AdventureAction.id == action_id, models.AdventureAction.session_id == session_id).first()
    if not action:
        return {'status': 'ok', 'missing': True}
    db.delete(action)
    db.commit()
    return {'status': 'ok'}


# ── Rewind, new options, pictures, openings ──────────────────────────────────

def _sse_job(work) -> StreamingResponse:
    """Run work(queue) as a task that outlives the browser's connection and
    stream what it puts on the queue (with keep-alive pings). For the short
    utility calls: a reasoning model can think past iOS's 60 s cut-off for a
    request that sends nothing back."""
    queue = asyncio.Queue()

    async def run():
        try:
            await work(queue)
        except Exception as e:
            logger.error(f"Adventure utility call failed: {e}")
            await queue.put(e)
        finally:
            await queue.put(None)

    asyncio.create_task(run())
    return StreamingResponse(sse_from_queue(queue), media_type="text/event-stream")


def _latest_beat(session_data: models.AdventureSession, action_id: str) -> models.AdventureAction:
    beat = next((a for a in session_data.actions if a.id == action_id), None)
    if beat is None:
        raise HTTPException(status_code=404, detail="Action not found")
    last = max(session_data.actions, key=lambda a: a.order_index)
    if beat.role != "assistant" or not beat.content or beat is not last:
        raise HTTPException(status_code=409, detail="Only the latest beat's choices can be changed.")
    return beat


def _llm_text(out: str) -> str:
    return strip_think(close_open_think(out)).strip()


@router.post("/{session_id}/rewind/{action_id}", response_model=schemas.AdventureSessionDetailOut)
def rewind(session_id: str, action_id: str, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Go back to a beat: everything after it goes, and its choices are offered again."""
    session_data = _get_session(db, session_id, current_user)
    _drop_orphans(db, session_data)
    if any(a.role == "assistant" and not a.content for a in session_data.actions):
        raise HTTPException(status_code=409, detail="The narrator is still writing.")
    target = next((a for a in session_data.actions if a.id == action_id), None)
    if target is None or target.role != "assistant":
        raise HTTPException(status_code=404, detail="Beat not found")
    if target.is_summarized:
        raise HTTPException(status_code=409, detail="That part of the story has been folded into the summary.")
    for a in [a for a in session_data.actions if a.order_index > target.order_index]:
        db.delete(a)
    beats_left = sum(1 for a in session_data.actions if a.role == "assistant" and a.order_index <= target.order_index)
    if (session_data.journal_at or 0) > beats_left:
        session_data.journal = ""  # it knows about beats that no longer happened
        session_data.journal_at = 0
    session_data.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(session_data)
    return session_data


NEW_OPTIONS_INSTRUCTION = (
    "Offer four NEW choices for what happens next, different from these: {old}. "
    "Do not continue or repeat the story. Reply with ONLY the four choices, one per line, exactly like this:\n"
    "[OPTION 1] First choice\n[OPTION 2] Second choice\n[OPTION 3] Third choice\n[OPTION 4] Fourth choice"
)


@router.post("/{session_id}/actions/{action_id}/options")
async def new_options(session_id: str, action_id: str, req: schemas.AdventureSendActionRequest, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Fresh choices for the latest beat, without rewriting the beat."""
    session_data = _get_session(db, session_id, current_user)
    beat = _latest_beat(session_data, action_id)
    settings = get_or_create_settings(db, current_user.id)
    if not settings.api_key:
        raise HTTPException(status_code=400, detail="API key not configured.")
    old = "; ".join(f'"{o["text"]}"' for o in _options_list(beat.options)) or "none"
    messages = build_adventure_prompt(session_data, db, req.max_input_tokens or DEFAULT_MAX_INPUT_TOKENS, False,
                                      native_reasoning=supports_reasoning_flag(settings.api_base_url))
    messages.append({"role": "user", "content": NEW_OPTIONS_INSTRUCTION.format(old=old)})

    async def work(queue):
        llm = LLMService(settings)
        try:
            out = ""
            async for chunk in llm.generate(messages, stream=True, request_reasoning=True, temperature=req.temperature):
                out += chunk
            _, options = split_adventure_options(close_open_think(out))
            if not options:
                raise RuntimeError("The model didn't send any choices. Try again.")
            with SessionLocal() as bg_db:
                row = bg_db.query(models.AdventureAction).filter(models.AdventureAction.id == action_id).first()
                if row:
                    row.options = json.dumps(options)
                    bg_db.commit()
            await queue.put({"type": "options", "options": options})
        finally:
            await llm.close()

    return _sse_job(work)


@router.post("/{session_id}/actions/{action_id}/image-prompt")
async def image_prompt(session_id: str, action_id: str, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """An image prompt for one beat (the browser then draws it through the image API)."""
    session_data = _get_session(db, session_id, current_user)
    beat = next((a for a in session_data.actions if a.id == action_id and a.role == "assistant" and a.content), None)
    if beat is None:
        raise HTTPException(status_code=404, detail="Beat not found")
    settings = get_or_create_settings(db, current_user.id)
    if not settings.api_key:
        raise HTTPException(status_code=400, detail="API key not configured.")

    earlier = [strip_think(a.content) for a in session_data.actions
               if a.role == "assistant" and a.content and a.order_index < beat.order_index][-2:]
    chars = []
    for c in session_data.characters:
        name = c.name or "Character"
        bits = [f"Name: {name}"] + [f"{label}: {_sub_macros(v, name)[:1200]}" for label, v in
                                    (("Description", c.description), ("Personality", c.personality)) if v]
        chars.append("\n".join(bits))
    parts = []
    if chars:
        parts.append("Characters:\n" + "\n\n".join(chars))
    if earlier:
        parts.append("Story so far (the scenes just before):\n" + "\n\n---\n\n".join(earlier))
    parts.append("Scene to illustrate:\n" + strip_think(beat.content))
    parts.append("Write the image generation prompt:")
    messages = [
        {"role": "system", "content": (
            "You are an expert at writing prompts for AI image generators. Given a story excerpt and character "
            "descriptions, write a single concise image prompt that vividly captures the key moment of the scene. "
            "Output ONLY the prompt text: no explanation, no preamble, no quotes. Focus on setting, lighting, mood, "
            "the characters' appearance and pose, and composition. Under 200 words, descriptive comma-separated phrases.")},
        {"role": "user", "content": "\n\n".join(parts)},
    ]

    async def work(queue):
        llm = LLMService(settings)
        try:
            out = ""
            async for chunk in llm.generate(messages, stream=True, request_reasoning=True, temperature=UTILITY_TEMPERATURE):
                out += chunk
            prompt = _llm_text(out).strip("\"' ")
            if not prompt:
                raise RuntimeError("The model didn't write a prompt. Try again.")
            await queue.put({"type": "prompt", "prompt": prompt[:2000]})
        finally:
            await llm.close()

    return _sse_job(work)


MAX_IMAGE_CHARS = 12_000_000  # a data URI of a large PNG


@router.put("/{session_id}/actions/{action_id}/image")
def save_image(session_id: str, action_id: str, payload: schemas.AdventureImageIn, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    _get_session(db, session_id, current_user)
    action = _get_action(db, session_id, action_id)
    image = (payload.image or "").strip()
    if not re.match(r"^(https?://|/|data:image/)", image) or len(image) > MAX_IMAGE_CHARS:
        raise HTTPException(status_code=400, detail="Not an image URL.")
    action.image = image
    action.image_prompt = (payload.prompt or "")[:2000]
    db.commit()
    return {"ok": True}


@router.get("/{session_id}/actions/{action_id}/image")
def get_image(session_id: str, action_id: str, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    _get_session(db, session_id, current_user)
    action = _get_action(db, session_id, action_id)
    if not action.image:
        raise HTTPException(status_code=404, detail="No picture")
    return {"image": action.image, "prompt": action.image_prompt or ""}


@router.delete("/{session_id}/actions/{action_id}/image")
def delete_image(session_id: str, action_id: str, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    _get_session(db, session_id, current_user)
    action = _get_action(db, session_id, action_id)
    action.image = ""
    action.image_prompt = ""
    db.commit()
    return {"ok": True}


@router.post("/inspire")
async def inspire(req: schemas.AdventureInspireIn, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Three possible openings for a new adventure with these characters."""
    settings = get_or_create_settings(db, current_user.id)
    if not settings.api_key:
        raise HTTPException(status_code=400, detail="API key not configured.")
    cards = db.query(models.CharacterCard).filter(
        models.CharacterCard.id.in_(req.card_ids or [-1]), models.CharacterCard.user_id == current_user.id).all()
    who = []
    for c in cards:
        name = c.name or "Character"
        bits = [f"Name: {name}"] + [f"{label}: {_sub_macros(v, name)[:900]}" for label, v in
                                    (("Description", c.description), ("Scenario", c.scenario)) if v]
        who.append("\n".join(bits))
    ask = ("Characters:\n" + "\n\n".join(who)) if who else "No characters are chosen: invent the cast."
    if req.genre:
        ask += f"\n\nGenre or tone wanted: {req.genre[:200]}"
    messages = [
        {"role": "system", "content": "You pitch openings for interactive adventure stories."},
        {"role": "user", "content": ask + (
            "\n\nWrite three different openings for an adventure with them. Each is two or three vivid sentences "
            "setting the scene and the first spark of trouble: a place, a situation, a hook. Make the three differ "
            "in tone and genre. Reply with only the three, numbered 1. 2. 3., one per line.")},
    ]

    async def work(queue):
        llm = LLMService(settings)
        try:
            out = ""
            async for chunk in llm.generate(messages, stream=True, request_reasoning=True, temperature=0.9):
                out += chunk
            text = _llm_text(out)
            pieces = re.split(r"\n\s*(?=\d+[.)]\s)|\n\s*\n", "\n" + text)
            openings = [re.sub(r"^\s*(?:\d+[.)]|[-*•])\s*", "", p).strip(" *\"") for p in pieces if p.strip()]
            openings = [o for o in openings if len(o) > 20][:3]
            if not openings:
                raise RuntimeError("No openings came back. Try again.")
            await queue.put({"type": "openings", "openings": openings})
        finally:
            await llm.close()

    return _sse_job(work)
