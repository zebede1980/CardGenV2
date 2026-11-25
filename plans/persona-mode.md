# Persona mode: who you play, as a card

Status: **planned, nothing built** (2026-11-25).

A persona is the player's own character: who "you" are in Roleplay Chat, Messenger and Adventure
(Protagonist). Today it is a free-text field. This makes it a generated, reusable card with a portrait,
made in Character Gen and picked the same way in every mode.

## Decisions (Joe, 2026-11-25)

1. **A chat follows its persona card.** Editing the persona changes every chat that uses it, from the
   next turn. History is not rewritten.
2. **`saved_user_personas` moves into persona cards.** One store.
3. **A persona can also be picked as a character the AI plays.** Not blocked, with the guards below.
4. **Persona is a card type in Character Gen**, not a section of its own. The expensive parts
   (prompt host, server runs, portrait, Looks, library, thumbnails) are shared; the differences are
   the prompt, the fields, and how the modes pick and use it.

## What exists today (and is wrong)

- `saved_user_personas` (`models.py`): name, age, gender, detail. Create and delete only, no edit,
  no portrait, nothing generated. Roleplay Chat, Messenger and Adventure each have their own copy of
  the "Use a saved persona…" dropdown (`chat-handler.js`, `messenger-handler.js` `_settingsForm`,
  `adventure-handler.js`).
- Roleplay Chat's "use a card as persona" (`chat-handler.js` ~1019) **copies** the card's description
  and personality into `user_persona_detail`. It stores `user_persona_card_id`, but no prompt code
  reads it, so edits to the card never arrive.
- **That copy carries the wrong macros.** A character card says `{{char}}` for itself. Chat sends the
  literal `{{char}}` (cards are never macro-substituted there; open review finding). Messenger's
  `sub_macros(detail, names[0], user)` would turn it into the *other* character's name. Only Chat
  offers card personas today, so it is a hazard rather than a live Messenger fault.
- Messenger asks for name + detail only (no age/gender); Adventure for name + detail, Protagonist only.
- Story Writer has no persona at all.

## How a persona differs from a character card

1. **The AI never plays it.** A character card is operational guidance for playing someone; a persona
   is facts the narrator respects: what others can see and know (appearance, role, background,
   reputation). Personality is a sketch, not behaviour rules. "{{user}} always…" phrasing invites the
   model to write the player's actions and feelings: the prompt forbids it.
2. **The persona's own name is `{{user}}`**, never `{{char}}`. The current card prompt forces `{{char}}`
   everywhere (`api-character.js` "CRITICAL MACRO RULE"), so this is a separate template, not a flag.
3. **Portable.** No scenario, no first message, no relationship to a particular character. The
   relationship belongs to the chat (Messenger's "how you know each other" already does this).
4. **Short**: ~150–400 tokens. It sits in every prompt, every turn. Adventure and Messenger already cut
   the detail at 2,000 chars.
5. **Third person.** Adventure Protagonist turns it into "you" at prompt time.

### Fields

| Field | Persona | Stored in |
|---|---|---|
| Name | yes | `name` |
| Age, gender/pronouns | yes, structured (three prompts already use them) | new `persona` JSON column |
| Description: appearance, background | yes, short | `description` |
| Personality | yes, a sketch | `personality` |
| How I talk (2–3 lines) | optional; used only by Impersonate / ✨ Write my next text | `mes_example` (open question) |
| Portrait | yes | `image_path`, as cards |
| Tags | yes | `tags` |
| First message, alt greetings, scenario, post-history, system prompt | no | left empty |
| Lorebook, auto-cast | no | left empty |

## Storage

- `character_cards.kind`: `'character'` (default, every existing row) or `'persona'`. A column, not a
  tag: tags are AI-written and `PATCH /api/cards/:id/tags` replaces them.
- `character_cards.persona`: JSON `{age, gender, isDefault}`, null for characters.
- Added in `database.py` with the existing `_column_exists` pattern.
- Summary (`/api/cards/summary`), library (`/api/storage/cards/library`) and full card responses carry
  `kind`. Older clients ignore it.

## Moving `saved_user_personas`

- On backend start, once: each row becomes a `kind='persona'` card (name; detail → description;
  age/gender → `persona`), no portrait. Exact duplicates (same user, name, age, gender, detail) become
  one card. A marker in `app_secrets` (`personas_migrated`) stops it running twice.
- Existing chats keep their copied fields as they are. A chat whose fields match a migrated persona
  exactly gets its `user_persona_card_id` set, so it follows from then on.
- `/api/sw/personas` keeps answering (from persona cards) for one release, then the table and route go.

## Using a persona: following the card

- Roleplay Chat and Messenger share `roleplay_chats`, which already has `user_persona_card_id`.
  Adventure adds `persona_card_id` to its config JSON (`_config` in `adventure.py`).
- At prompt time each mode reads the persona card by id and builds the persona block from it. The
  copied `user_persona_*` fields are the fallback: they are refreshed whenever the chat is opened or
  the persona switched, and used if the card is gone (`cards.py` delete already nulls the id).
- One helper for all three modes (`services/persona.py`): `persona_block(chat_or_cfg, db) -> {name,
  age, gender, text, voice}`, with macros resolved for the user's side.

### Macro swap by role (decision 3)

- Persona text uses `{{user}}`. Used as **your** persona: `{{user}}` → its name.
- A persona cast as an **AI character**: its `{{user}}` → `{{char}}` before the normal substitution.
- A character card picked as **your persona** (Chat's "From a character card…"): its `{{char}}` →
  `{{user}}`. Better: offer "Make a persona from this card" (below) and use the copy as a fallback.
- **The same card can't be both your persona and a character in one chat**: the picker greys it out.
- A persona cast as a character has no first message: Chat starts empty, Messenger's opener already
  writes one.

## Making a persona

### In Character Gen

- `#card-type-select` gets **🎭 Persona (you)**. Hidden in that mode: POV, auto-cast, lorebook,
  greetings, example messages, post-history, creator's notes, consistency check. Shown: concept,
  name, age, gender, the 🎨 Look, portrait.
- A new template in `api-character.js` (shared script, so the proxy's prompt host gets it): the fields
  above, `{{user}}` macro rule, "facts, not behaviour" rule, length budget. Parser:
  `character-generator.js` reads the persona sections.
- Finishing step: tags only (+ "How I talk" if asked).
- Server runs (`proxy/runs/card-runs.js`): `spec.cardType: 'persona'` within `new-card`; the step list
  drops cast and the skipped fields. Saved to History then Library as other cards.
- Revise / Remaster work as they do; Reduce tokens matters more here.

### "Make a persona from this card"

A Revise-style run on a character card: rewrite it in persona form (keeping looks and background,
dropping behaviour rules and the first message), saved as a **new** `kind='persona'` card with the
same portrait. From Home's card sheet and from the picker's "From a character card…".

### Quick create, inside the picker

✨ New persona inside a mode's new-chat sheet: name + one-line idea (+ age/gender). Runs as a server
card run, so a phone locked mid-write still gets it; the sheet polls while visible. The portrait is
optional and off by default here (keeps it quick); it can be drawn later from Character Gen.

## One picker for every mode

`src/scripts/persona-picker.js`, replacing the three dropdowns:

- Tiles with portraits (thumbnail route), default first. **Just a name** (a one-off persona, not
  saved), **✨ New persona**, **From a character card…** (opens `cardGallery`).
- **Pre-selected:** the persona last used with this character (by card id, in the chat list), else the
  account default (`persona.isDefault`, one per user; "Make default" in the picker and on Home).
- **Shown in the session:** your portrait on your bubbles (Chat, Messenger); "playing as X" in
  Adventure's top bar. Tapping either opens the picker to switch; a switch changes later turns only.
- Where: Chat's new-chat sheet and chat settings; Messenger's `_settingsForm` (new and settings);
  Adventure's new sheet and 🎛️ This adventure, **Protagonist only**. Director has none (you're the
  narrator).
- **Story Writer: out of scope.** "Put me in the story" (persona as a cast member) would be new.

## Lists and filters

- Home: 🎭 Personas chip; personas left out of the grid unless it's picked (open question below).
  The card sheet shows **🎭 Use as me** instead of 💬 Chat for a persona (Chat stays in ⋯).
- Card pickers that choose the AI's characters show personas in a separate group at the end.
- Character Gen's library sidebar: a 🎭 marker on persona rows.
- The tagging run (`proxy/runs/tag-runs.js`) includes personas with the same vocabulary.
- Usage counts (`uses / last used`) count persona use as well.

## Phases

1. **Schema + move:** `kind`, `persona` columns; migration of `saved_user_personas`; `kind` in the
   summary/library/card responses; `/api/sw/personas` served from cards. Backend tests.
2. **Prompts follow the card:** `services/persona.py`, the macro swap, Chat / Messenger / Adventure
   build from it with the fallback; fix the card-as-persona copy. Backend tests per mode.
3. **The picker:** `persona-picker.js` in all three modes, default + last-used, session indicators.
4. **Character Gen persona type:** template, parser, hidden fields, server run steps, finishing.
5. **Quick create + "Make a persona from this card".**
6. **Lists:** Home chip and sheet, library marker, pickers' grouping, tagging, usage.

Each phase deploys on its own. 1–2 are backend only and change nothing visible except fixing the
macro bug.

## Tests

- Backend: migration (dupes, idempotent, chats linked), `persona_block` (follow, fallback after delete,
  macro swap both ways, same card both sides refused), each mode's prompt.
- `tests/cardgen/`: persona run through the real proxy (steps, no cast, `{{user}}` kept), picker in
  WebKit at 390 light / 320 dark (pre-select, switch mid-chat, quick create with the page hidden
  mid-run and back, greyed same-card), Home chip.
- Not testable headlessly: the iPhone. Say so when shipping.

## Open questions (don't block phase 1)

- Does "How I talk" live in `mes_example` (exports to SillyTavern as example dialogue, which is
  wrong-ish for a persona) or in the `persona` JSON?
- Same tag vocabulary for personas, or a smaller one?
- Home: hide personas from the main grid by default, or mix them in with a badge?
- A 🎭 tab in Character Gen's library sidebar, or just the marker?
- SillyTavern export of a persona: as a character card (macros swapped) or as ST's persona JSON?
