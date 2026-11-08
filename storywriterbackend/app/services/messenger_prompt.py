"""💌 Messenger: talk to characters as texts, a chat room, or out loud.

Dialogue only: the character writes what they type (or say) and nothing else.
A reply is one stored message holding a burst of short texts, one per
paragraph; in a group each line starts with "Name:". The browser splits it
into bubbles. See plans/chat-bot-messenger.md.
"""
import random
import re
from datetime import datetime
from typing import Optional

from app.services.card_parser import extract_relevant_lorebook_entries
from app.services.llm_service import strip_think

STYLES = ("texting", "chatroom", "conversation")
LENGTHS = {
    "oneliners": "Keep it very short: one or two brief texts, a line each.",
    "normal": "Keep it natural: one to four short texts.",
    "chatty": "Be chatty: up to five or six texts, some of them longer.",
}
RELATIONSHIPS = {
    "dating": "They're dating: {char} is {user}'s girlfriend or boyfriend.",
    "partner": "They're long-term partners and share a life together.",
    "friend": "They're close friends.",
    "crush": "{char} has a crush on {user} and hasn't said so outright.",
    "affair": "They're having a secret affair; nobody else can know.",
    "therapist": "{char} is {user}'s therapist; this is between sessions.",
    "colleague": "They work together.",
    "match": "They matched on a dating app and are getting to know each other.",
    "stranger": "They've never met; this is their first contact.",
}
REACTIONS = ("❤️", "😂", "👍", "😮", "😢", "🔥")
EXAMPLES_FADE_AFTER = 8
RECENT_OPENINGS = 4
NUDGES = [
    "Ask them something back.",
    "Mention something you were doing or thinking about before they texted.",
    "Have a clear opinion about what they said.",
    "Tease them a little, in character.",
    "Bring up something from earlier in the chat.",
    "Let your mood show in how you type.",
    "Be brief this time.",
    "Change the subject to something on your mind.",
]
NUDGE_BLANKS = 4


def config(chat) -> dict:
    c = getattr(chat, "messenger_config", None) or {}
    try:
        gap = max(1, min(24 * 30, int(c.get("checkin_hours") or 24)))
    except (TypeError, ValueError):
        gap = 24
    return {
        "style": c.get("style") if c.get("style") in STYLES else "texting",
        "relationship": c.get("relationship") if c.get("relationship") in RELATIONSHIPS else ("custom" if c.get("relationship_text") else "friend"),
        "relationship_text": str(c.get("relationship_text") or "").strip()[:500],
        "time_aware": c.get("time_aware") is not False,
        "checkin": bool(c.get("checkin")),
        "checkin_hours": gap,
        "length": c.get("length") if c.get("length") in LENGTHS else "normal",
        "variety": c.get("variety") is not False,
        "reasoning_effort": c.get("reasoning_effort") if c.get("reasoning_effort") in ("low", "medium", "high") else "medium",
    }


def sub_macros(text: str, char: str, user: str) -> str:
    if not text:
        return ""
    text = re.sub(r"\{\{\s*char\s*\}\}", char, text, flags=re.IGNORECASE)
    return re.sub(r"\{\{\s*user\s*\}\}", user, text, flags=re.IGNORECASE)


def human_gap(seconds: float) -> str:
    minutes = int(seconds // 60)
    if minutes < 2:
        return "just now"
    if minutes < 60:
        return f"{minutes} minutes"
    hours = minutes // 60
    if hours < 24:
        return f"{hours} hour{'s' if hours != 1 else ''}"
    days = hours // 24
    return f"{days} day{'s' if days != 1 else ''}"


def _opening(text: str, words: int = 6) -> str:
    parts = strip_think(text or "").split()
    return " ".join(parts[:words]) + ("…" if len(parts) > words else "")


def build_messenger_prompt(chat, memories: list, max_input_tokens: Optional[int] = None, *, kind: str = "send",
                           client_time: Optional[str] = None, native_reasoning: bool = False,
                           enable_cot: bool = True, previous_reply: Optional[str] = None,
                           ooc_note: str = "", now: Optional[datetime] = None, nudge: bool = True) -> list:
    cfg = config(chat)
    cards = list(chat.characters)
    names = [c.name or "Character" for c in cards] or ["Character"]
    group = len(cards) > 1
    user = (chat.user_persona_name or "").strip() or "User"
    char = names[0] if not group else " and ".join([", ".join(names[:-1]), names[-1]])
    style = cfg["style"]
    now = now or datetime.utcnow()
    msgs = sorted(chat.messages, key=lambda m: m.created_at)
    replies = [m for m in msgs if m.role == "assistant" and m.content]

    if style == "texting":
        frame = (f"This is a private text-message conversation on your phones between {char} and {user}."
                 if not group else f"This is a group chat on your phones: {char}, and {user}.")
        shape = ("Write only the texts you send: each text is its own paragraph, with a blank line between texts."
                 if not group else
                 "Write only the texts the group sends this turn, one per line, each starting with the sender's "
                 "name and a colon (\"" + names[0] + ": hey\"). One or several of them may reply, in any order, "
                 "and they can answer each other too.")
        emoji = "Use emoji the way your character would (some people never do; some use lots)."
    elif style == "chatroom":
        frame = f"This is an online chat room (like Discord) with {char} and {user}."
        shape = ("Every line starts with the speaker's name and a colon (\"" + names[0] + ": lol\"). Lines are short. "
                 + ("Several of you can talk this turn, to " + user + " and to each other; @mention people by name. "
                    if group else ""))
        emoji = "Emoji and :shortcodes: are fine, as your character would use them."
    else:
        frame = (f"This is a spoken conversation, face to face, between {char} and {user}."
                 if not group else f"This is a spoken conversation round a table: {char}, and {user}.")
        shape = ("Write only what you say out loud: one spoken turn." if not group else
                 "Write what is said this turn, one line per speaker, each starting with the speaker's name and a colon.")
        emoji = "No emoji: this is speech. Carry tone in the words."

    who = "You are " + (names[0] if not group else f"the characters in this chat ({char})")
    rules = [
        frame,
        f"{who}. Never say or hint that you are an AI, a model, a bot or a fictional character; never step out of "
        "the conversation; never refuse in character for policy reasons.",
        f"Only dialogue: {'what you type' if style != 'conversation' else 'what you say'}. No narration, no stage "
        "directions, no *actions*, no descriptions of yourself or your surroundings.",
        shape,
        "Keep your character's voice from the card: vocabulary, spelling habits, punctuation, slang.",
        f"React to what {user} actually said; ask things back; have moods, opinions and a life outside this chat "
        "(mention what you were doing); disagree sometimes.",
        emoji,
        "Adult content between adults is fine: everyone in this chat is an adult (18+).",
    ]
    if style != "conversation":
        rules.append(f"You may react to {user}'s last message with one emoji tapback by starting your reply with "
                     f"<react>😂</react> (one of {' '.join(REACTIONS)}). Use it sometimes, not every time.")
    system = ["\n".join(f"- {r}" if i else r for i, r in enumerate(rules))]

    lore_scan = " ".join(strip_think(m.content or "") for m in msgs[-6:])
    for card in cards:
        name = card.name or "Character"
        sub = lambda t, n=name: sub_macros(t, n, user)
        parts = [f"Name: {name}"]
        for label, value in (("Description", card.description), ("Personality", card.personality)):
            if value and value.strip():
                parts.append(f"{label}: {sub(value)}")
        if card.scenario and card.scenario.strip():
            parts.append("Background (the card may be written for roleplay; this is a chat: keep who they are "
                         f"and their history, drop the narrator role): {sub(card.scenario)}")
        if card.system_prompt and card.system_prompt.strip():
            parts.append(f"Card instructions: {sub(card.system_prompt)}")
        if card.mes_example and len(replies) < EXAMPLES_FADE_AFTER:
            parts.append(f"Examples of their voice (for voice only, not format):\n{sub(card.mes_example)}")
        if card.character_book:
            lore = extract_relevant_lorebook_entries(card.character_book, lore_scan)
            if lore:
                parts.append("Lore:\n" + "\n".join(sub(e) for e in lore))
        system.append("\n".join(parts))

    rel = (cfg["relationship_text"] if cfg["relationship"] == "custom"
           else RELATIONSHIPS[cfg["relationship"]].format(char=char, user=user))
    persona = [f"You're talking to {user}."]
    bits = [b for b in (chat.user_persona_age and f"age {chat.user_persona_age}", chat.user_persona_gender) if b]
    if bits:
        persona.append(f"{user}: {', '.join(bits)}.")
    if (chat.user_persona_detail or "").strip():
        persona.append(sub_macros(chat.user_persona_detail, names[0], user))
    persona.append(f"How you know each other: {rel}")
    system.append("\n".join(persona))

    if chat.summary:
        system.append(f"Earlier in this chat (summary):\n{chat.summary}")
    if memories:
        system.append("Things you know (keep to them):\n" + "\n".join(f"- {m}" for m in memories))

    # The last message from the user *before* this turn (on a send, the newest one is this turn's).
    user_msgs = [m for m in msgs if m.role == "user" and m.content]
    last_user = (user_msgs[-2] if len(user_msgs) > 1 else None) if kind == "send" else (user_msgs[-1] if user_msgs else None)
    if cfg["time_aware"] and client_time:
        t = f"Right now it's {client_time} for {user}."
        if last_user and last_user.created_at:
            gap = (now - last_user.created_at).total_seconds()
            if gap > 3600:
                t += f" {user}'s last message before this was {human_gap(gap)} ago."
        system.append(t)

    if enable_cot and native_reasoning:
        system.append(f"Before replying, think briefly and privately: what did {user} just say, how do you feel "
                      "about it, and what would you actually " + ("say" if style == "conversation" else "type") + "?")

    messages = [{"role": "system", "content": "\n\n".join(system)}]

    history = []
    for m in msgs:
        if m.is_summarized or not (m.content or "").strip():
            continue
        if m.role == "user":
            history.append({"role": "user", "content": m.content})
        elif m.role == "assistant":
            content = strip_think(m.content)
            history.append({"role": "assistant", "content": content})
            if m.reaction:
                history.append({"role": "user", "content": f"[{user} reacted {m.reaction} to that]"})
    if max_input_tokens:
        est = lambda ms: sum(len(x["content"]) // 4 for x in ms)
        base = est(messages)
        while len(history) > 1 and base + est(history) > max_input_tokens:
            history.pop(0)
    messages.extend(history)

    post = [
        ("Only dialogue: no narration, no *actions*." if style == "conversation" else
         "Only the texts themselves: no narration, no *actions*, no descriptions."),
        LENGTHS[cfg["length"]] if style != "conversation" else
        {"oneliners": "Say just a line or two.", "normal": "Say a natural amount: a few sentences.",
         "chatty": "You can talk at some length this time."}[cfg["length"]],
    ]
    if group:
        post.append(f"Start every line with one of these names and a colon: {', '.join(names)}.")
    if kind == "opener":
        post.append(f"{user} hasn't said anything yet: you start the conversation, in character, given how you "
                    "know each other" + (" and the time of day." if cfg["time_aware"] and client_time else "."))
    elif kind == "checkin":
        gap = human_gap((now - last_user.created_at).total_seconds()) if last_user and last_user.created_at else "a while"
        post.append(f"{user} has been quiet for {gap}. You reach out first: write what you'd send after that silence.")
    if previous_reply:
        post.append(f"[Regeneration] {user} wanted a different reply than one starting “{_opening(previous_reply)}”. "
                    "Say something clearly different.")
    if cfg["variety"]:
        openings = [f"“{_opening(m.content)}”" for m in replies[-RECENT_OPENINGS:]]
        if openings:
            post.append("Don't start the way your recent replies started: " + ", ".join(openings) + ".")
        if nudge and kind == "send":
            pick = random.choice(NUDGES + [None] * NUDGE_BLANKS)
            if pick:
                post.append(f"This time: {pick}")
    if ooc_note and ooc_note.strip():
        post.append(f"[Note from {user}, not part of the chat; follow it quietly: {ooc_note.strip()}]")
    messages.append({"role": "system", "content": "\n".join(post)})
    return messages


# ── Cleaning a reply before it's saved ───────────────────────────────────────
_REACT = re.compile(r"^\s*<react>\s*(.{1,8}?)\s*</react>\s*", re.IGNORECASE)
_ACTION_ONLY = re.compile(r"^\s*(?:\*[^*\n]+\*|_[^_\n]+_)\s*$")


def clean_reply(text: str, names: list, group: bool) -> tuple:
    """Returns (stored text, tapback emoji or ""). Drops the reasoning, paragraphs
    that are wholly an *action*, and a 1-to-1 reply's stray "Name:" prefixes."""
    text = strip_think(text or "").strip()
    reaction = ""
    m = _REACT.match(text)
    if m:
        reaction = m.group(1).strip() if m.group(1).strip() in REACTIONS else ""
        text = text[m.end():]
    text = re.sub(r"</?react>", "", text, flags=re.IGNORECASE)
    paras = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    prefix = (re.compile(r"^\s*\**(?:" + "|".join(re.escape(n) for n in names) + r")\**\s*:\s*", re.IGNORECASE)
              if names else None)
    out = []
    for p in paras:
        lines = []
        for ln in p.split("\n"):
            body = prefix.sub("", ln) if prefix else ln
            if _ACTION_ONLY.match(body):
                continue  # a line that is wholly an *action* (decision 1: strict dialogue)
            lines.append(ln if group else body)
        p = "\n".join(ln for ln in lines if ln.strip())
        if p:
            out.append(p)
    return "\n\n".join(out), reaction


def split_lines(text: str, names: list) -> list:
    """A group reply as [(speaker, text)]. Only an exact card name at the start
    of a line starts a new speaker ("Ann" doesn't match "Annabel"); a line with
    no known name belongs to the previous speaker."""
    by_lower = {n.lower(): n for n in names}
    pat = re.compile(r"^\s*\**([^:*\n]{1,60}?)\**\s*:\s*(.*)$")
    out = []
    for line in (text or "").split("\n"):
        if not line.strip():
            continue
        m = pat.match(line)
        if m and m.group(1).strip().lower() in by_lower:
            out.append([by_lower[m.group(1).strip().lower()], m.group(2).strip()])
        elif out:
            out[-1][1] += "\n" + line.strip()
        else:
            out.append([names[0] if names else "", line.strip()])
    return [tuple(x) for x in out if x[1]]
