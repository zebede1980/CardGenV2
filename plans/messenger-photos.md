# 💌 Messenger photos — plan

Phase 5 of `plans/chat-bot-messenger.md` ("photos/selfies, later"), brought forward 2026-11-09.
Texting and chat-room styles only; a spoken conversation has no photos.

## Joe's decisions (2026-11-09)

1. **Both ways.** Characters send photos; you send photos. Plus a **📷 Describe a photo** button
   that "sends" a photo you only describe, so the chat can flow without taking a real one.
2. **Characters send one when asked, and sometimes unprompted.** Per-chat setting
   **Photos: Never / When asked / Sometimes / Often** (default Sometimes).
3. **Likeness from the card's portrait**, keeping the portrait's art style, for immersion.
   Local GPU first (Qwen Lightning was the best tested for this), hosted fallback when the PC is off.
4. **Photos follow the chat.** No NSFW toggle: if the chat is explicit, so are the photos.

## Findings (2026-11-09, PC, Qwen Lightning) — these changed the design

3 card portraits (Fenne: anime, Concetta: painterly realistic, Nicola: 2D cartoon; all adults) ×
5 photos (café selfie, mirror selfie in a new outfit, in bed, night out, topless) × 4 routes, same seed.
Contact sheets in the session temp folder (`qwen-lightning-test/msgphoto/*.jpg`).

- **A plain edit of the portrait wins clearly.** New place, outfit and pose; face, hair, piercings,
  tattoo and art style kept. Anime and cartoon held perfectly; the painterly one drifted toward a
  photo. A short wrapped caption ("Make a new picture of this same woman: … Keep her face, hair and
  the art style …") and a full prompt with look + style came out almost identical.
- **Reimagine (close / balanced) is unusable here:** it keeps the portrait's background and outfit
  (a "café selfie" stays on the stage in the corset).
- **NSFW:** every topless edit was drawn as asked, no covering up.
- Warm: 3–6 s a photo (the first reimagine after load took 120 s, once). Edits come out at the
  portrait's shape.

So, simpler than planned: **no Gemini look cache and no image-prompt call.** The chat model writes
the `<photo>` caption in the third person; the browser wraps it in the edit instruction and sends
the portrait as the picture. Gemini then only ever describes photos *you* send.

## Character → you

**The reply.** The prompt gains one rule (when Photos isn't Never): to send a photo, put
`<photo>what it shows: framing, where you are, what you're wearing and doing, expression</photo>`
on its own line, written as the sender sees it. Send one when {user} asks; with Sometimes/Often,
also now and then when it fits (showing where you are, what you're wearing). Never in most replies.
This is the one exception to "no descriptions of yourself".

**Storage.** `clean_reply` lifts each `<photo>` out into a new `chat_photos` row
(`id, chat_id, message_id, owner: char|user, description, prompt, image, status, created_at`)
and leaves a marker line `<photo id="…"/>` in the message, so the burst keeps its order and the
bubble splitter shows a photo bubble there. `GET /chats/{id}` returns the marker, not the image
(a data URI can be MBs; images load per photo, as Adventure's do). History sent to the model turns
the marker into `[Mira sent a photo: <description>]`.

**Drawing, in the browser** (like Adventure's Picture: local models and the job registry live in
the proxy, not in Python):

1. **Look of the card, cached.** Once per card, the vision model (Gemini 3.5 Flash) reads the
   portrait and writes *appearance + medium/art style* (face, hair, eyes, build, marks; "glossy
   2.5D anime render", "35mm film photo"…). Stored with the card's Messenger data; redone if the
   portrait changes. Gemini only ever sees the portrait, never the chat, so it has nothing to refuse.
2. **Prompt.** `POST /messenger/chats/{id}/photos/{pid}/prompt`: the **chat's own text model**
   (GLM / DeepSeek, which already follow the chat) merges the description, the cached look and
   the last few texts into one image prompt in the photo model's format. Small utility call,
   streamed (iOS 60 s rule).
3. **Image.** The Messenger photo model (one global setting, default `local/qwen-image-2.1-lightning`):
   Reimagine's local route with the **portrait as the reference** (the reference keeps face *and*
   style). If the proxy says the local GPU is offline, the **fallback model** (setting) draws it:
   its edit route with the portrait if it can edit, else words alone.
4. `PUT …/photos/{pid}` stores the image; status `done`.

Typing dots are followed by a "📷 sending a photo…" bubble with a soft placeholder until it lands.
Tap a photo: full screen (the existing lightbox), Redraw, Save to Library, Copy prompt.

**iPhone.** The image call is a resumable job keyed by photo id. Locked mid-draw: the proxy keeps
going and the result is collected on wake. Tab discarded: on reopening the chat, a `pending` photo
with a job in the registry is collected, never redrawn; one with no job left shows **Tap to
draw** rather than paying again silently. Never draws while hidden.

## You → character

The ＋ menu gains **📷 Photo** with two choices:

- **From your photos / camera** (`<input type=file accept=image/*>`). Downscaled in a canvas to
  ≤1600 px JPEG (Safari decodes HEIC there), uploaded to `chat_photos` (owner `user`). The vision
  model writes a plain description; the character sees `[Joe sent a photo: …]`. If it refuses or
  fails, you're asked for a line about it instead (the picture still shows in your bubble).
- **Describe a photo.** A box: "What's in the photo?". Shown as a photo-card bubble (📷 + your
  words on a soft gradient), and the character sees exactly the same as above. No image, no cost.

Either can carry a caption text, and Send then asks for a reply as normal.

## Experiments first (on the PC, before building the drawing step)

Need **ComfyUI running on the PC**. Three portraits (a photo, an anime, a 2.5D render), five
photos each (café selfie, mirror selfie in a new outfit, in bed, on a night out, an explicit one):

- Qwen Lightning reimagine *close* vs *balanced* vs a plain edit: likeness, style kept, pose
  freedom (the 2026-11-06 note: Reimagine "barely moved the pose", plain edit "does turn the camera").
- NSFW: does Qwen draw it or cover up? If it covers up, compare MOSS edit (uncensored LoRA) and
  Klein for the explicit case, and consider routing explicit photos to whichever wins.
- **Hosted fallback** (a few paid calls, pennies): nano-gpt's Qwen edit model(s) and one other
  edit model, same tests: likeness, style, and whether they refuse NSFW.

## Phases

1. Backend: `chat_photos`, `<photo>` rule + parsing, history line, routes (prompt, get, put,
   upload, describe), Photos setting. Tests with the fake model.
2. Experiments (above) → pick default and fallback models and the reimagine setting.
3. Front end: photo bubbles, drawing + recovery, lightbox, ＋ 📷 Photo (upload / describe),
   settings. WebKit checks incl. lock mid-draw, tab discard with a pending photo, no double draw.
4. Real model check: does GLM/DeepSeek send photos when asked, and not too often?
5. STATUS, `?v=` bumps, deploy (**storywriterbackend rebuild**: interrupts live chat replies).

## Open questions

- Group chat room: who's in a photo? The sender only, unless the description names others with
  portraits too (Qwen takes up to 3 references). v1: sender only.
- Cost: one image + one small text call per photo. "Often" could mean a photo every few replies.
