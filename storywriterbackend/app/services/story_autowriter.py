"""Auto-written stories: one press plans a whole story and writes it to an
ending, chapter by chapter, on the server.

Why on the server: a story is 4–18 chapters plus a plan, ten minutes or more
with a reasoning model. Driven from the browser, the loop would die the first
time the phone locked. Here it runs as an asyncio task that outlives any
request; the browser only polls for progress. Every finished chapter is
committed as an ordinary StorySegment (with `chapter` set), so the existing
reader, narration and per-segment images work on it unchanged.

Flow:
1. plan_story(): one call returns the outline as JSON (title, spoiler-free
   blurb, the ending, cast arcs, one entry per chapter). Stored in
   Story.plan, which the browser only sees through GET /stories/{id}/outline.
2. For each chapter: write_chapter() with the cards and the whole outline as a
   fixed prefix (so prompt caching covers it), then the chapter's own brief,
   the summaries of earlier chapters and the end of the previous one.
3. After each chapter, summarise_chapter() writes the author's notes for it
   into StorySegment.summary; later chapters read those instead of the whole
   text.

Progress lives in Story.autowrite (JSON). A backend restart kills the task but
not the progress: the status endpoint reports "interrupted" and Resume carries
on from the next unwritten chapter with the same outline.
"""
import asyncio
import json
import logging
import re
import time
from datetime import datetime
from typing import Optional

from app.models import SessionLocal, Settings, Story, StorySegment
from app.services import push
from app.services.card_parser import extract_relevant_lorebook_entries
from app.services.llm_service import (
    LLMService,
    UTILITY_TEMPERATURE,
    needs_prose,
    prose_after_reasoning,
    strip_think,
    with_think_tags,
)

logger = logging.getLogger(__name__)

UNTITLED = "Untitled story"

LENGTHS = {
    "short": {"chapters": 4, "words": 800},
    "medium": {"chapters": 7, "words": 1100},
    "long": {"chapters": 11, "words": 1400},
    "epic": {"chapters": 18, "words": 1600},
}

ENDINGS = {
    "any": "Choose the ending that suits this story best, but make it a definite ending, not an open question.",
    "happy": "The story ends happily: the main characters get what they truly need, and it is earned by what they went through.",
    "bittersweet": "The story ends bittersweet: something real is won, at a real cost that stays with the reader.",
    "dark": "The story ends darkly: tragedy, loss, or a victory that turns sour. It must feel inevitable, not arbitrary.",
    "twist": "The ending turns on a twist that recasts what came before. Plant fair clues for it in earlier chapters.",
}

# How far the plan may stray from the cards. This works on the brief the
# planner gets rather than on sampling: a higher temperature makes prose less
# coherent, not plots bolder. Only the top stops nudge the planner's
# temperature up a little.
FAITHFULNESS = {
    1: ("Stick closely to the cards. Use the card's scenario as the setting and premise. Every character behaves "
        "exactly as their card describes and keeps their history. Add no major new characters, only minor walk-ons. "
        "Keep the plot grounded and believable within the card's world."),
    2: ("Stay close to the cards. Start from the card's scenario and keep every character true to their card. You may "
        "add places and a few supporting characters. Allow one real surprise."),
    3: ("Use the cards as the foundation. Keep the characters recognisably themselves, but the plot is yours: invent "
        "freely, let characters grow and change, and include one genuine twist."),
    4: ("Take liberties. Keep each character's name, appearance and core nature, but feel free to move them into a "
        "different setting or genre than their card suggests. Include more than one twist and take the story somewhere "
        "the reader won't predict."),
    5: ("Go off the rails. Keep only who the characters fundamentally are: names, looks, the heart of their "
        "personality. Everything else is up for grabs: setting, genre, premise, even the rules of reality. Subvert "
        "expectations again and again and land on an ending nobody would guess. It must still be one coherent story "
        "with a real ending."),
}
PLANNER_TEMPERATURE = {1: 0.7, 2: 0.8, 3: 0.85, 4: 0.95, 5: 1.05}

PROSE_RULES = (
    "Write flowing prose with standard paragraph breaks (one blank line between paragraphs). No headings, chapter "
    "titles, bullet points, bold text or other formatting. Keep paragraphs full and readable; avoid strings of "
    "one-sentence paragraphs. No meta-commentary, no notes to the reader, never mention the plan. Finish at a natural "
    "sentence boundary."
)

# A steering note or idea is the user's text going into a prompt; cap it so a
# pasted essay can't crowd out the story.
MAX_NOTE_CHARS = 2000
PREVIOUS_ENDING_CHARS = 3000


# ── Run registry ─────────────────────────────────────────────────────────────
# Live runs by story id. The backend runs as a single uvicorn process, so an
# in-memory registry is enough; the durable state is Story.autowrite.
_RUNS: dict = {}


class Run:
    def __init__(self, story_id: int, user_id: int):
        self.story_id = story_id
        self.user_id = user_id
        self.task: Optional[asyncio.Task] = None
        self.phase = "planning"  # planning | thinking | writing | summarising
        self.chapter = 0
        self.raw = ""  # the current call's output so far, think block included
        self.last_poll = 0.0  # time.monotonic() of the browser's last status poll

    def watched(self) -> bool:
        """The page polls every 2.5 s while it's on screen, and never while hidden."""
        return time.monotonic() - self.last_poll < 20

    @property
    def partial(self) -> str:
        """The current chapter's prose so far, without the reasoning."""
        if self.phase not in ("thinking", "writing"):
            return ""
        if "</think>" in self.raw:
            return strip_think(self.raw)
        return "" if self.raw.lstrip().startswith("<think>") else self.raw


def active_run(story_id: int) -> Optional[Run]:
    run = _RUNS.get(story_id)
    return run if run and run.task and not run.task.done() else None


# ── State helpers ────────────────────────────────────────────────────────────

def load_state(story: Story) -> dict:
    try:
        return json.loads(story.autowrite) if story.autowrite else {}
    except json.JSONDecodeError:
        return {}


def load_plan(story: Story) -> Optional[dict]:
    try:
        return json.loads(story.plan) if story.plan else None
    except json.JSONDecodeError:
        return None


def _save_state(story_id: int, **changes) -> dict:
    with SessionLocal() as db:
        story = db.query(Story).filter(Story.id == story_id).first()
        if not story:
            return {}
        state = load_state(story)
        state.update(changes)
        state["updated_at"] = datetime.utcnow().isoformat()
        story.autowrite = json.dumps(state)
        db.commit()
        return state


def new_state(config: dict) -> dict:
    return {
        "config": config,
        "status": "planning",
        "total": config["chapters"],
        "steer": [],
        "error": "",
        "started_at": datetime.utcnow().isoformat(),
        "updated_at": datetime.utcnow().isoformat(),
    }


def build_config(length: str, ending: str, faithfulness: int, idea: str, title_given: bool) -> dict:
    size = LENGTHS.get(length, LENGTHS["medium"])
    return {
        "length": length if length in LENGTHS else "medium",
        "ending": ending if ending in ENDINGS else "any",
        "faithfulness": min(5, max(1, int(faithfulness or 3))),
        "idea": (idea or "").strip()[:MAX_NOTE_CHARS],
        "chapters": size["chapters"],
        "words": size["words"],
        "title_given": title_given,
    }


def chapters_written(db, story_id: int) -> int:
    """The highest chapter saved so far; the next one to write is this + 1."""
    seg = (db.query(StorySegment)
           .filter(StorySegment.story_id == story_id, StorySegment.chapter.isnot(None))
           .order_by(StorySegment.chapter.desc()).first())
    return seg.chapter if seg else 0


def status_for(story: Story, db) -> dict:
    """What the browser's poll gets. Never includes the outline."""
    state = load_state(story)
    if not state:
        return {"status": "none"}
    run = active_run(story.id)
    status = state.get("status", "none")
    if status in ("planning", "writing") and not run:
        status = "interrupted"  # the backend restarted mid-run
    done = chapters_written(db, story.id)
    out = {
        "status": status,
        "total": state.get("total") or state.get("config", {}).get("chapters", 0),
        "chapters_done": done,
        "error": state.get("error", ""),
        "title": story.title,
        "steer_pending": len(state.get("steer", [])),
    }
    if run:
        out.update({"phase": run.phase, "chapter": run.chapter})
    return out


# ── Prompt building ──────────────────────────────────────────────────────────

def _sub(text: str, name: str) -> str:
    if not text:
        return ""
    for token in ("{{char}}", "{{Char}}", "{{CHAR}}"):
        text = text.replace(token, name)
    for token in ("{{user}}", "{{User}}", "{{USER}}"):
        text = text.replace(token, "the user")
    return text


def card_text(card, lore_scan: str = "") -> str:
    name = card.name or "Character"
    parts = [f"Name: {name}"]
    for label, value in (("Description", card.description), ("Personality", card.personality),
                         ("Scenario", card.scenario)):
        if value and value.strip():
            parts.append(f"{label}: {_sub(value.strip(), name)}")
    if card.system_prompt and card.system_prompt.strip():
        parts.append(f"Character instructions: {_sub(card.system_prompt.strip(), name)}")
    if card.post_history_instructions and card.post_history_instructions.strip():
        parts.append(f"Additional notes: {_sub(card.post_history_instructions.strip(), name)}")
    if card.character_book and lore_scan:
        lore = extract_relevant_lorebook_entries(card.character_book, lore_scan)
        if lore:
            parts.append("Lorebook:\n" + "\n".join(lore))
    return "\n".join(parts)


CARDS_NOTE = (
    "These character cards were written for roleplay. Where a card says \"the user\", that is someone the character "
    "deals with: make them a proper, named character in the story, or leave them out."
)


def _structure_hint(n: int) -> str:
    mid = max(2, round(n / 2))
    if n <= 4:
        return ("Chapter 1 sets up the characters, what they want and the world, and ends on the event that starts the "
                f"story. The middle chapters raise the stakes. Chapter {n - 1} is the lowest point. Chapter {n} is the "
                "climax and the resolution.")
    return ("Chapter 1 sets up the characters, what they want and the world, and ends on the event that starts the "
            f"story. Stakes rise through the next chapters; around chapter {mid} a midpoint reversal changes what the "
            f"story is about. Chapter {n - 1} is the crisis, the lowest point. Chapter {n} is the climax and the "
            "resolution, and delivers the ending.")


def build_plan_messages(settings: Settings, cards: list, config: dict) -> list:
    n = config["chapters"]
    system = []
    if settings.system_prompt and settings.system_prompt.strip():
        system.append(f"Author's global instructions (they apply to this story too):\n{settings.system_prompt.strip()}")
    system.append(
        "You are a novelist planning a complete story that will be written chapter by chapter from your plan. "
        "The plan must be specific: named places, concrete events, real choices with consequences. Nothing generic."
    )
    if cards:
        system.append(CARDS_NOTE + "\n\n" + "\n\n".join("Character card:\n" + card_text(c) for c in cards))
    else:
        system.append("No character cards were given: invent the cast.")

    brief = [
        f"Plan a story of exactly {n} chapters, about {config['words']} words each.",
        f"How closely to follow the cards: {FAITHFULNESS[config['faithfulness']]}",
        f"The ending: {ENDINGS[config['ending']]}",
        f"Shape: {_structure_hint(n)}",
        ("The author's idea for the story:\n" + config["idea"]) if config["idea"]
        else "No premise was given: invent the most interesting story these characters could be in.",
        """Reply with JSON only, no other text, in exactly this shape:
{
  "title": "the story's title",
  "blurb": "two or three sentences for the back cover that give nothing away beyond the setup",
  "setting": "where and when, in two or three sentences",
  "style": "narrative voice: point of view, tense, tone",
  "ending": "exactly how the story ends, in two or three sentences",
  "cast": [{"name": "...", "role": "...", "arc": "how they change from start to end"}],
  "chapters": [
    {"title": "...", "events": "what happens in this chapter, three to six sentences",
     "ends_with": "the situation at the very end of the chapter",
     "plant": "anything set up here that pays off later, or an empty string"}
  ]
}""",
    ]
    return [
        {"role": "system", "content": "\n\n".join(system)},
        {"role": "user", "content": "\n\n".join(brief)},
    ]


def parse_plan(text: str, expected_chapters: int) -> dict:
    """The outline from the planner's reply, or ValueError saying what's wrong."""
    body = strip_think(text)
    body = re.sub(r"^```(?:json)?\s*|\s*```$", "", body.strip(), flags=re.IGNORECASE)
    start, end = body.find("{"), body.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("no JSON object in the reply")
    try:
        plan = json.loads(body[start:end + 1])
    except json.JSONDecodeError as e:
        raise ValueError(f"invalid JSON: {e}")
    chapters = plan.get("chapters")
    if not isinstance(chapters, list) or not chapters:
        raise ValueError("no chapters")
    clean = []
    for ch in chapters:
        if not isinstance(ch, dict) or not str(ch.get("events", "")).strip():
            raise ValueError("a chapter has no events")
        clean.append({k: str(ch.get(k, "") or "").strip() for k in ("title", "events", "ends_with", "plant")})
    # A chapter or two either way is the planner's judgement; far off means it
    # ignored the brief.
    if abs(len(clean) - expected_chapters) > 2:
        raise ValueError(f"{len(clean)} chapters instead of {expected_chapters}")
    plan["chapters"] = clean
    for key in ("title", "blurb", "setting", "style", "ending"):
        plan[key] = str(plan.get(key, "") or "").strip()
    if not plan["ending"]:
        raise ValueError("no ending")
    plan["cast"] = [c for c in plan.get("cast", []) if isinstance(c, dict)] if isinstance(plan.get("cast"), list) else []
    return plan


def outline_text(plan: dict) -> str:
    lines = [f"Title: {plan['title']}"]
    if plan.get("setting"):
        lines.append(f"Setting: {plan['setting']}")
    if plan.get("style"):
        lines.append(f"Narrative voice: {plan['style']}")
    if plan.get("cast"):
        lines.append("Cast:\n" + "\n".join(
            f"- {c.get('name', '?')} ({c.get('role', '')}): {c.get('arc', '')}" for c in plan["cast"]))
    lines.append(f"How the story ends: {plan['ending']}")
    lines.append("Chapters:")
    for i, ch in enumerate(plan["chapters"], 1):
        lines.append(f"{i}. {ch['title']}: {ch['events']}")
    return "\n".join(lines)


def build_chapter_messages(settings: Settings, cards: list, plan: dict, config: dict, chapter: int,
                           earlier: list, steer: list) -> list:
    """earlier: the saved chapters before this one, as (content, summary) in order."""
    n = len(plan["chapters"])
    ch = plan["chapters"][chapter - 1]
    lore_scan = " ".join([ch["events"], ch["ends_with"]] + [s for _, s in earlier[-2:]])

    # Fixed prefix: the same for every chapter, apart from lorebook entries.
    system = []
    if settings.system_prompt and settings.system_prompt.strip():
        system.append(f"Author's global instructions:\n{settings.system_prompt.strip()}")
    system.append(
        "You are a novelist writing a complete story one chapter at a time, working to the plan below. The reader "
        "never sees the plan; they only read the chapters, so everything they need must be on the page."
    )
    if cards:
        system.append(CARDS_NOTE + "\n\n" + "\n\n".join("Character card:\n" + card_text(c, lore_scan) for c in cards))
    system.append("THE PLAN\n" + outline_text(plan))
    system.append(PROSE_RULES)

    user = []
    if earlier:
        notes = "\n\n".join(f"Chapter {i}: {summary or content[:600]}" for i, (content, summary) in enumerate(earlier, 1))
        user.append("What has happened so far (author's notes):\n" + notes)
        user.append("The previous chapter ended like this:\n…" + earlier[-1][0][-PREVIOUS_ENDING_CHARS:])
        openings = [" ".join(content.split()[:8]) for content, _ in earlier[-5:]]
        user.append("Earlier chapters opened with these words; open differently:\n" + "\n".join(f"- {o}" for o in openings))
    if steer:
        user.append("The author's notes for this chapter (follow them, never quote them):\n" + "\n".join(f"- {s}" for s in steer))

    brief = [f"Write chapter {chapter} of {n}" + (f", \"{ch['title']}\"" if ch["title"] else "") + "."]
    brief.append(f"What happens: {ch['events']}")
    if ch["ends_with"]:
        brief.append(f"By the end of the chapter: {ch['ends_with']}")
    if ch["plant"]:
        brief.append(f"Set up, without drawing attention to it: {ch['plant']}")
    if chapter < n:
        nxt = plan["chapters"][chapter]
        brief.append(f"The next chapter (do not write any of it): {nxt['events']}")
    brief.append(f"Length: about {config['words']} words.")
    if chapter == 1:
        brief.append("Open in a scene, not with background. Bring the characters in through what they do and say.")
    else:
        brief.append("Carry straight on from where the previous chapter ended. Don't recap it.")
    if chapter < n:
        brief.append(
            "This is not the end of the story. Do not resolve the central conflict, do not reflect on or summarise "
            "events, and do not close on a wrap-up line or a moral. End on a moment that pulls the reader into the "
            "next chapter."
        )
    else:
        brief.append(
            f"This is the final chapter. Deliver the ending: {plan['ending']} Resolve the central conflict and close "
            "the main threads. End on a final image or line that feels like an ending. Don't write \"The End\"."
        )
    user.append("\n".join(brief))
    return [
        {"role": "system", "content": "\n\n".join(system)},
        {"role": "user", "content": "\n\n".join(user)},
    ]


_HEADING_RE = re.compile(
    r"^\s*(?:#+\s*|\*\*\s*)?chapter\s+(?:\d+|[ivxlc]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|"
    r"twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b[^\n]{0,100}\n+",
    re.IGNORECASE,
)


def clean_chapter(text: str) -> str:
    """The prose only: no reasoning, no chapter heading (the reader draws its
    own), and cut back to a sentence end if the model stopped mid-sentence."""
    body = strip_think(text).strip()
    body = _HEADING_RE.sub("", body, count=1).strip()
    body = re.sub(r"\n+\s*(?:the end|THE END)\.?\s*$", "", body).strip()
    return body


def trim_to_sentence(text: str) -> str:
    m = re.search(r"(.*[.!?…][\'\")\]”’]*)", text, re.DOTALL)
    if m and len(m.group(1)) >= len(text) * 0.5:
        return m.group(1).rstrip()
    return text.rstrip()


# ── Model calls ──────────────────────────────────────────────────────────────

async def _call(llm: LLMService, run: Run, messages: list, temperature: float, follow_up: str) -> str:
    """One generation with native reasoning, streamed into run.raw. A model
    that stops after its reasoning is asked once more for the text itself."""
    run.raw = ""
    stream = llm.generate(messages, stream=True, temperature=temperature, top_p=llm.top_p,
                          request_reasoning=True, yield_reasoning=True)
    async for chunk in with_think_tags(stream):
        run.raw += chunk
        if run.phase == "thinking" and ("</think>" in run.raw or not run.raw.lstrip().startswith("<think>")) \
                and run.raw.strip():
            run.phase = "writing"
    if needs_prose(run.raw):
        async for chunk in prose_after_reasoning(llm, messages, run.raw, follow_up, temperature=temperature):
            run.raw += chunk
    return run.raw


async def plan_story(llm: LLMService, run: Run, settings: Settings, cards: list, config: dict) -> dict:
    messages = build_plan_messages(settings, cards, config)
    temperature = PLANNER_TEMPERATURE[config["faithfulness"]]
    raw = await _call(llm, run, messages, temperature, "Now reply with the JSON plan only.")
    try:
        return parse_plan(raw, config["chapters"])
    except ValueError as first_error:
        logger.warning(f"[autowrite {run.story_id}] plan rejected ({first_error}); asking again")
        retry = messages + [
            {"role": "assistant", "content": strip_think(raw)[:4000]},
            {"role": "user", "content": f"That plan can't be used ({first_error}). Reply again with the complete "
                                        f"JSON plan only, {config['chapters']} chapters, in the shape asked for."},
        ]
        raw = await _call(llm, run, retry, UTILITY_TEMPERATURE + 0.3, "Now reply with the JSON plan only.")
        return parse_plan(raw, config["chapters"])


async def write_chapter(llm: LLMService, run: Run, settings: Settings, messages: list, words: int) -> str:
    raw = await _call(llm, run, messages, settings.temperature, "Now write the chapter itself, prose only.")
    text = clean_chapter(raw)
    if llm.finish_reason == "length":
        text = trim_to_sentence(text)
    # Far too short means the model wandered (a refusal, a note to the author).
    if len(text.split()) < words * 0.25:
        logger.warning(f"[autowrite {run.story_id}] chapter {run.chapter} came back with "
                       f"{len(text.split())} words; writing it again")
        raw = await _call(llm, run, messages, settings.temperature, "Now write the chapter itself, prose only.")
        text = clean_chapter(raw)
        if len(text.split()) < words * 0.25:
            raise RuntimeError(f"Chapter {run.chapter} came back almost empty twice")
    return text


async def summarise_chapter(llm: LLMService, chapter: int, text: str) -> str:
    messages = [
        {"role": "system", "content": "You keep a novelist's continuity notes. Be exact and brief; never invent."},
        {"role": "user", "content": (
            f"Write the notes for chapter {chapter} below in 4 to 8 sentences: what happened, where each character "
            "ends up and how they feel, anything that changed, and every new name, object, injury, promise or "
            f"secret introduced. Plain prose.\n\n{text}")},
    ]
    try:
        out = ""
        async for chunk in llm.generate(messages, stream=False, temperature=UTILITY_TEMPERATURE):
            out += chunk
        return strip_think(out).strip()[:3000]
    except Exception as e:
        # The run must not die for want of a note: fall back to the text's
        # opening and close, which still anchor the next chapter.
        logger.warning(f"[autowrite] summary for chapter {chapter} failed: {e}")
        return f"{text[:500]} … {text[-500:]}"


async def name_story(llm: LLMService, cards: list, text: str) -> str:
    names = ", ".join(c.name for c in cards if c.name) or "none"
    messages = [
        {"role": "system", "content": "You name stories. Reply with the title only: no quotes, no explanation."},
        {"role": "user", "content": f"Characters: {names}\n\nThe opening of the story:\n{text[:4000]}\n\n"
                                    "Give it a short, evocative title (two to six words)."},
    ]
    out = ""
    async for chunk in llm.generate(messages, stream=False, temperature=0.7):
        out += chunk
    title = strip_think(out).strip().splitlines()[0] if strip_think(out).strip() else ""
    return title.strip(" \"'*#")[:120]


# ── The run ──────────────────────────────────────────────────────────────────

def _load(story_id: int):
    """Settings, cards, plan, state and earlier chapters, from a short session."""
    with SessionLocal() as db:
        story = db.query(Story).filter(Story.id == story_id).first()
        if not story:
            raise RuntimeError("Story not found")
        settings = db.query(Settings).filter(Settings.user_id == story.user_id).first()
        if not settings or not settings.api_key:
            raise RuntimeError("API key not configured")
        cards = [sc.card for sc in story.cards]
        for c in cards:
            db.expunge(c)
        db.expunge(settings)
        earlier = [(s.content, s.summary or "") for s in
                   db.query(StorySegment).filter(StorySegment.story_id == story_id, StorySegment.chapter.isnot(None))
                   .order_by(StorySegment.chapter).all()]
        return settings, cards, load_plan(story), load_state(story), earlier


async def _run_story(run: Run):
    story_id = run.story_id
    llm = None
    try:
        settings, cards, plan, state, earlier = _load(story_id)
        config = state["config"]
        llm = LLMService(settings)

        if not plan:
            run.phase = "planning"
            _save_state(story_id, status="planning", error="")
            plan = await plan_story(llm, run, settings, cards, config)
            with SessionLocal() as db:
                story = db.query(Story).filter(Story.id == story_id).first()
                story.plan = json.dumps(plan)
                if not config.get("title_given") and plan["title"]:
                    story.title = plan["title"][:200]
                if not (story.synopsis or "").strip() and plan.get("blurb"):
                    story.synopsis = plan["blurb"]
                db.commit()

        total = len(plan["chapters"])
        _save_state(story_id, status="writing", total=total, error="")
        with SessionLocal() as db:
            start = chapters_written(db, story_id) + 1

        for chapter in range(start, total + 1):
            run.chapter = chapter
            run.phase = "thinking"
            with SessionLocal() as db:
                story = db.query(Story).filter(Story.id == story_id).first()
                steer_all = load_state(story).get("steer", [])
            steer = [s["note"] for s in steer_all]
            messages = build_chapter_messages(settings, cards, plan, config, chapter, earlier, steer)
            text = await write_chapter(llm, run, settings, messages, config["words"])

            run.phase = "summarising"
            summary = await summarise_chapter(llm, chapter, text)
            with SessionLocal() as db:
                order = db.query(StorySegment).filter(StorySegment.story_id == story_id).count()
                db.add(StorySegment(story_id=story_id, order_index=order, content=text, summary=summary, chapter=chapter))
                story = db.query(Story).filter(Story.id == story_id).first()
                state = load_state(story)
                # Notes sent during this chapter's writing were already in its
                # prompt only if they arrived before it started; keep the rest.
                state["steer"] = [s for s in state.get("steer", []) if s not in steer_all]
                state["updated_at"] = datetime.utcnow().isoformat()
                story.autowrite = json.dumps(state)
                db.commit()
            earlier.append((text, summary))
            run.raw = ""

        _save_state(story_id, status="done", error="")
        logger.info(f"[autowrite {story_id}] finished, {total} chapters")
        _notify(run, f"Finished: {total} chapters. Tap to read it.")
    except asyncio.CancelledError:
        # Stop: the half-written chapter is dropped so the arc stays whole;
        # Resume writes it again.
        _save_state(story_id, status="stopped")
        logger.info(f"[autowrite {story_id}] stopped at chapter {run.chapter}")
    except Exception as e:
        logger.exception(f"[autowrite {story_id}] failed")
        _save_state(story_id, status="failed", error=str(e)[:500])
        _notify(run, f"Stopped at chapter {run.chapter or 1}: {str(e)[:120]}", failed=True)
    finally:
        run.raw = ""
        if llm:
            await llm.close()


def _notify(run: Run, text: str, failed: bool = False):
    try:
        with SessionLocal() as db:
            story = db.query(Story).filter(Story.id == run.story_id).first()
            title = (story.title if story else "") or "Your story"
        push.done(run.user_id, "story", None, reading=run.watched(), name=f"✨ {title}", generic=text,
                  path=f"/?open=story&id={run.story_id}", tag=f"story-{run.story_id}", failed=failed)
    except Exception:
        logger.exception(f"[autowrite {run.story_id}] push failed")


def start_run(story_id: int, user_id: int) -> Run:
    """Starts (or resumes) the run; the caller has already checked none is live."""
    run = Run(story_id, user_id)
    run.task = asyncio.create_task(_run_story(run))
    _RUNS[story_id] = run
    run.task.add_done_callback(lambda t: _RUNS.pop(story_id, None) if _RUNS.get(story_id) is run else None)
    return run


async def stop_run(story_id: int) -> bool:
    run = active_run(story_id)
    if not run:
        return False
    run.task.cancel()
    try:
        await asyncio.wait_for(asyncio.shield(run.task), timeout=10)
    except (asyncio.CancelledError, asyncio.TimeoutError):
        pass
    except Exception:
        pass
    return True


async def name_story_task(story_id: int):
    """Hand-written stories start untitled; once the first chunk exists, name it."""
    llm = None
    try:
        settings, cards, _, _, _ = _load(story_id)
        with SessionLocal() as db:
            story = db.query(Story).filter(Story.id == story_id).first()
            if not story or story.title != UNTITLED:
                return
            first = (db.query(StorySegment).filter(StorySegment.story_id == story_id, StorySegment.is_summary == False)  # noqa: E712
                     .order_by(StorySegment.order_index).first())
            if not first:
                return
            opening = first.content
        llm = LLMService(settings)
        title = await name_story(llm, cards, opening)
        if title:
            with SessionLocal() as db:
                story = db.query(Story).filter(Story.id == story_id).first()
                if story and story.title == UNTITLED:  # the user may have renamed it meanwhile
                    story.title = title
                    db.commit()
    except Exception as e:
        logger.warning(f"[autowrite] naming story {story_id} failed: {e}")
    finally:
        if llm:
            await llm.close()
