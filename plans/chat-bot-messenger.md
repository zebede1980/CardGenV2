# Chat Bot mode ("Messenger"): plan

Written 2026-11-08. Joe's brief: a new tab where you pick one or more character cards and just
*talk* to them, as text messages, an internet chat room, or a spoken conversation. The AI stays
in character and writes only what the character says: no narration. Emoji welcome. NSFW allowed
the same way as the other modes. It must have everything Roleplay Chat has on the iPhone: the
full-screen shell, the keyboard handling, and surviving a lock mid-reply.

**Built and deployed 2026-11-08 night** (`90da154`, `69091c4`); see STATUS.md. One deviation: Roleplay
Chat was not moved onto `chat-core.js` (decision 3), see STATUS.md. Joe's answers are in "Decisions" at the end.

**Before building:** the uncommitted Adventure work in the tree (`index.html`, `main.css`,
`schemas.py`, …) must be committed first; this feature edits the same files.

## The short version

- **Backend: reuse Roleplay Chat's tables and routes, add a `mode` column.** A messenger chat is a
  `roleplay_chats` row with `mode = 'messenger'`, and its own prompt builder. That gets the
  server-side resilience for free: the reply runs as a server task that outlives the socket, is
  saved as it finishes, pings every 15 s, can be cancelled by Stop, and can be recovered by
  message id after a lock. Summary and memory extraction come along too.
- **Frontend: a new tab with its own handler and its own look**, built on the same shell and the
  same stream/recovery code as Roleplay Chat.
- **The model writes a burst of short texts**, one per paragraph (and `Name: text` lines in a
  group). The app splits the stored reply into bubbles when it draws it. One stored message per
  burst, so Regen, Edit, Stop and lock recovery keep working exactly as they do now.

## Why not a separate backend

A separate `messenger_*` table set and router would be a copy of `chat.py`'s send / cancel /
recover / summary / memory code, about 800 lines, and every future fix to one would have to be
made twice. What really differs is the prompt, the memory prompt, and the defaults. So:

| Piece | Reused as is | Changed for messenger |
|---|---|---|
| `roleplay_chats`, `chat_messages`, `chat_character_links`, `chat_memories` | ✓ | `roleplay_chats.mode` (`'roleplay'` default), `roleplay_chats.messenger` (JSON: style, relationship, options) |
| `POST /chats/{id}/message` (task, save, ping, cancel registry) | ✓ | picks `build_messenger_prompt` when `mode == 'messenger'`; skips the speaker router and the tag CoT |
| `POST …/cancel`, `PATCH`/`DELETE` messages, `GET /chats/{id}` | ✓ | — |
| `GET /chats/` | ✓ | `?mode=` filter, so each lobby only lists its own chats |
| `summarize_chat_task` | ✓ | — |
| `extract_chat_memory_task` | the plumbing | its prompt: the RP one tracks clothing and scene state; messenger needs facts about *you* and the relationship (your job, your dog's name, the argument on Tuesday) |
| Impersonate | ✓ | messenger wording ("write my next text") |

Roleplay Chat itself doesn't change, apart from its lobby asking for `?mode=roleplay` (old rows
get `'roleplay'` from the migration default).

## The prompt (`build_messenger_prompt`, new, in `chat.py` or a new `services/messenger_prompt.py`)

System block, in this order:

1. **The frame**, per style (below). Core rules for all styles:
   - You *are* {char}. Never say you are an AI, a model or a character; never step out of the
     conversation; never refuse in character for policy reasons.
   - Only what {char} types (or says, in Conversation). **No narration, no stage directions, no
     `*actions*`, no descriptions of {char} or the room** (decision 1).
   - Keep {char}'s voice from the card: vocabulary, spelling habits, punctuation, slang, how they
     use emoji. A terse soldier texts differently from a bubbly student.
   - React to what {user} actually said; ask things back; have moods, opinions, a life outside
     the chat (mention what you were doing); disagree sometimes.
   - Adult content between adults is fine; every character is an adult (18+). Same line as the
     Prompt Builder's NSFW block. Nothing in the app filters; the model may still soften.
2. **The card, adapted.** Name, description, personality, card system prompt, lorebook hits.
   Card `scenario` goes in as *background*, with a line saying the card may be written for
   roleplay but this is a chat: keep who they are and their history, drop the narrator role.
   `mes_example` is used for voice only and fades after 8 replies, as in Roleplay Chat.
3. **{{char}} / {{user}} substituted** with the card name and the persona name. Roleplay Chat
   still sends these literally (open finding from the 2026-11-03 review); here the persona name
   matters too much to leave it. The helper can be reused to fix Roleplay Chat later.
4. **Who you are to them**: the relationship (decision 6) plus the persona (reusing Personas).
5. **Summary and memory facts**, as now.
6. **Time** (default on, a per-chat toggle): the user's local date, time and weekday from the
   browser, and how long since the last message ("Joe's last text was 3 days ago"). Lets them
   say good morning, notice a long silence, or ask how the interview went yesterday.

Post-history (the per-turn block, as in Roleplay Chat): the style reminder, "no narration", the
length band, the variety nudge and recent-openings list (reused, reworded for texts), and the
Regenerate "different take" line.

**Reasoning:** GLM reasons natively, so it gets a short private checklist (what did they just
say, how does {char} feel about it, what would {char} actually type) and no `<think>` format.
Providers without native reasoning get no CoT at all: the tag format was built for prose turns
and is overkill for a text. Default Reasoning Effort **medium** (Roleplay's is high), because
waiting 90 s for "lol same 😂" feels broken. Changeable in the chat's settings.

## Styles (picked per chat, changeable later)

| | 📱 Texting | 💬 Chat room | 🗣️ Conversation |
|---|---|---|---|
| Feels like | iMessage / WhatsApp | Discord / IRC | Talking face to face (or on the phone) |
| Reply shape | 1–4 short texts, each its own bubble | lines from one or more characters, `Name: text` | one spoken turn, can be longer |
| Group (2+ cards) | a group text | characters talk to you *and each other*, @mentions | a conversation round a table |
| Emoji | yes, as {char} would use them | yes, plus `:shortcodes:` read as emoji | no (spoken); tone carried by words |
| Look | bubbles left/right, avatar on the first of a run, "Delivered / Read 21:04", typing dots | one column, coloured names, small avatars, timestamps on hover/tap | transcript: name then line, larger text |

In a group the model writes all the lines for the turn in one call and chooses who speaks, so
there is no separate speaker-router call (cheaper than Roleplay Chat's). The parser only accepts
`Name:` at the start of a line where Name is exactly one of the chat's cards, so "Ann" doesn't
match inside "Annabel" (another review finding in Roleplay Chat). A line with no known name goes
to the previous speaker.

## The tab (frontend)

New tab **💌 Messenger**, new view `#view-messenger`, new
`src/scripts/messenger-handler.js`, CSS under `#view-messenger` (to beat `main.js`'s dark button
rule, as the chat does).

**Lobby:** like Roleplay Chat's: a grid of chats with the characters' portraits, last message
preview and time ("Yesterday"), unread dot when a check-in text is waiting (decision 4).
**＋ New** opens a sheet: pick cards (the existing card gallery), Style, Relationship,
Persona, "They text first" tick (default on: one call writes an opener in style; the card's
`first_mes` is usually roleplay prose and won't fit). Home screen card tiles get a 💌 action
like their 💬 and 📖 ones.

**Open chat:** the same fixed shell as Roleplay Chat: `visualViewport` sizing, page lock, 16 px
fields, Return = newline on the phone and Send button sends, Enter sends on desktop, ↓ button
with the new-text dot, header with ‹ back / avatars + names (tap for the cards) / ⋯ (text size,
cards, chat settings, persona).

- **While a reply is generating:** "{char} is typing…" with dots. During GLM's reasoning nothing
  visible arrives, so the dots carry it (the stall watchdog already ignores that silence: pings
  keep flowing). Bubbles appear one by one as each paragraph completes in the stream, not
  letter by letter, so it reads like texts arriving. Optional small delay between bubbles
  **(default off)**: it's pure theatre and costs the reader time.
- **Your messages:** a blank line in what you type splits it into separate bubbles, so you can
  "double text". Each Send makes one reply.
- **Message actions:** tap a bubble → a small bar for its burst: ↻ Regen (latest), Edit (the
  existing full-screen edit sheet, raw text), Copy, Delete. Long-press for an emoji tapback (❤️ 😂
  👍 😮 😢 🔥) on any bubble; your tapbacks on their messages go into history as
  `[Joe reacted ❤️]` so they can notice. The model can also tapback yours with a leading
  `<react>😂</react>`, drawn on your bubble. **(default: in v1; small)**
- **OOC note** stays in ＋ (a nudge the character never "sees" as a text). Impersonate too.
- **Chat settings sheet:** Style, Relationship, Persona, Time awareness, Reasoning effort, Text
  length (one-liners / normal / chatty), Variety, Temperature / Presence; the Roleplay Chat
  settings module (`chat-settings.js`) is too RP-shaped to share, so it gets its own small one.

### Sharing code with Roleplay Chat (decision 3: extract)

The resilient parts live inside `RoleplayChatHandler` today: `_readChatStream` (watchdog that
ignores time asleep), `_recoverReply` (poll `GET /chats/:id` for that one reply), the wake logic
in `syncOnWake`, `_trackVisualViewport`, the scroll-follow code, `stopGeneration` +
`_settleCancel`. **Recommended:** move them into `src/scripts/chat-core.js` (plain functions /
a small class both handlers use), change nothing in how they behave, and rerun Roleplay Chat's
41 WebKit checks to prove it. The alternative, copying them, is quicker today but means two
watchdogs to keep in step, and CLAUDE.md is explicit that this logic is the thing not to break.

### Tab plumbing (worth knowing, not a decision)

Tab switching is hard-coded in at least five places, each with its own list of tab and view ids:
`home-handler.js` (3 spots plus a CSS block), `image-playground.js`, `adventure-handler.js`,
`chat-ui.js`, and the `#view-tabs` markup. Every one needs the new tab, or switching to/from
Messenger leaves a view showing. A shared `showView(name)` would fix the pattern, but that's a
refactor of code outside this feature, so I'd only add the entries unless Joe wants the cleanup.

## Phases

1. **Backend:** migration (`mode`, `messenger` JSON), `?mode=` filter, `build_messenger_prompt`,
   the burst/line format, macro substitution, time block, messenger memory prompt, opener call,
   `<react>` parsing. Python tests with the fake model, as for the autowriter.
2. **Shared chat core:** extract from `chat-handler.js`, Roleplay Chat retested, no behaviour
   change.
3. **Messenger tab:** lobby, New sheet, open chat in the three styles, typing dots, bubble
   splitting, actions, tapbacks, settings sheet, Home 💌 action, tab plumbing.
4. **Testing** (below), then STATUS.md, `?v=` bumps, commit. Deploy needs a
   **storywriterbackend rebuild** (interrupts in-flight chat/story replies and any auto-write).
5. **Later, not in v1:** photos/selfies, voice notes via the existing TTS, read-receipt timing
   games, a Home Screen app manifest.

Rough size: backend ~500 lines + tests, chat core ~300 moved, messenger handler ~1,500, CSS ~600.
Comparable to the Story Writer reader.

## Testing

- **Backend:** prompt builder per style and group size (macros substituted, no narration rule
  present, examples fade, time block, regen line); line parser (exact names, unknown lines,
  `<react>`); `?mode=` filter keeps the two lobbies apart; Roleplay Chat's prompt unchanged.
- **Headless WebKit** against a fake streaming backend, 320 / 390 / 430 px light and dark, plus
  1280 px desktop, asserting the page rendered first:
  - keyboard stand-in (viewport resize) keeps header and composer in view;
  - bubbles split as paragraphs complete; typing dots during a silent reasoning phase;
  - **lock cases:** page hidden mid-reply then visible; timers firing late; the socket dropped
    while hidden and the reply recovered by id with no redraw and **no second generation**; a
    45 s stall recovered, not at 30 s; Stop mid-reply leaves the bubble matching the server;
  - one Send makes exactly one request; regen, edit, delete, tapback.
- **Real model:** a few real GLM turns per style (Joe OK'd real chat calls for streaming checks
  on 2026-10-23) to see whether it actually keeps to dialogue and texting length.
- **Not possible headlessly:** the real iOS keyboard, a real lock. Try on the iPhone first:
  keyboard open/close, lock mid-reply, a long-press tapback, a group chat room.

## Decisions (Joe, 2026-11-08)

1. **Narration: strict dialogue.** The prompt forbids narration and `*actions*`; a bubble that is
   wholly an `*…*` action is dropped when the reply is saved (server side, so history stays
   clean). `*emphasis*` inside a sentence is kept.
2. **Photos / selfies: later** (phase 5).
3. **Resilience code: extract** into `chat-core.js` (phase 2), Roleplay Chat retested.
4. **Character texts first: yes, opt-in per chat.** Chat setting "Check in if I've been away",
   off by default, with a gap (e.g. 8 h / 1 day / 3 days). Fires only when *you open* the chat
   and the last message is older than the gap: one call, with the time block, writes a
   check-in burst in style. Never in the background, never twice for the same gap (the check-in
   itself becomes the last message). Lands in v1, phase 1 (route) and phase 3 (on open).
5. **Tab name: 💌 Messenger.**
6. **Relationship presets** as listed (girlfriend/boyfriend, partner, friend, crush, secret
   affair, therapist, colleague, someone you matched with, stranger) plus free text.
7. **Lobbies separate:** each tab lists only its own chats (`?mode=`).
