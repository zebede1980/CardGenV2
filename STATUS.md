# CardGenV2 — where things stand

Last updated 2026-11-26 (provider error reasons shown; 🖌️ Paint an area deployed; ✨ Edit + Reimagine merged, deployed; ⤢ Playground Extend deployed; 🎭 personas deployed; light card lists at app start + new app icon; Home character browser + AI tagging deployed, all 481 cards tagged; notification tap no longer replaces the open app, deployed; 🔊 Faster Kokoro deployed; Character Gen backend-driven phases 0–2 + server portrait deployed; 🔒 App lock PIN deployed; 🖼️ MiniMax H3-Image deployed; 🔔 push Stage 3 deployed; 📱 Home Screen app + push Stages 1–2 deployed; 💌 Messenger photos deployed; Messenger and the Adventure overhaul deployed 2026-11-08; Story Writer reader and story list portraits deployed). Branch `ChatTest`. MOSS-Image editing, Bria FIBO 2.0 and FLUX.3
Klein deployed 2026-10-26 (`f837558`). Roleplay Chat variety work committed 2026-11-03. Auto-written stories, the
output-token change, Qwen Lightning and Z-Image fp8 **deployed 2026-11-06 (`475442f`)**, with the earlier
chat work, in one rebuild of frontend, proxy and storywriterbackend. Update this file when you ship
something or find something worth remembering: it is the hand-over between machines, since
Claude's own memory does not travel between them.

## Text model errors say why (2026-11-26) — proxy only

Joe got bare "API Error: 503 Service Unavailable" on two new cards. The proxy log had the reason: **nano-gpt's
billing service was down** (`{"error":"Billing reservation failed","reason":"admission_unavailable",
"limit_source":"prepaid_reservation",…}`, one 500 too), with $7.56 spendable and nothing pending on the account
(checked with `/api/check-balance`). DeepSeek V4 Pro and Gemini 3.5 Flash both failed; a Gemini call two minutes
earlier had worked.
- `upstreamErrorReason` / `upstreamErrorDetail` in `server.js` read the provider's body (`error` as a string or
  `{message}`, plus `reason`/`code`), drop a reason that only repeats the status, and add "The AI provider is
  having trouble; try again in a few minutes." on a 5xx. Used by server card runs (`callTextUpstream`) and the page's
  `/api/text/chat/completions` (its `message` no longer starts with "API Error", since `api.js` adds
  "API Error: <status> - "). Now reads e.g. "API Error: 503 - Service Unavailable: Billing reservation failed
  (admission_unavailable). The AI provider is having trouble; try again in a few minutes."
- Not changed: image routes, and Story Writer / Chat / Adventure / Messenger (the Python backend's own errors).
- **Tested:** `runs.test.js` 83 (4 new, all 4 fail on the old code; the fake model takes `failBody`), phase0 50,
  runs-page 81. **Not tested:** a real provider error on the iPhone.

## 🖌️ Paint an area (2026-11-26) — deployed 2026-11-26 (`da28c1e`, proxy + frontend; the running proxy has `addPaintPasteBack`)

✨ Edit → ✏️ Change it → **🖌️ Paint an area**: paint over the picture (S / M / L brush, 🧽 Erase, ↶ Undo, ✕ Clear),
type the change as usual, **✨ Edit the painted area**. Only the painted part changes.
- **How:** the edit model edits the whole picture as normal, then the proxy pastes it over the original through the
  mask, grown 12 px and softened (`addPaintPasteBack` in `server.js`: `LoadImageMask` → scaled to the original's own
  size → `ThresholdMask` → `GrowMask` → `ImageBlur` → `ImageCompositeMasked`). Works on **any local edit model** (Qwen,
  Lightning, FIBO, Klein, H3, MOSS); a hosted model is refused (the page disables the button and says so). The mask is
  `inpaint: { mask }` on an ordinary `editImage` request, kept in Recent as an edit.
- **Page** (`image-playground.js` "Paint an area"): a canvas over the picture at its natural size (capped 1536 px),
  strokes in one colour shown half see-through; the mask is white where painted. The paint area stays hidden until
  its layer fits the picture (a first stroke before that was lost). The painted area is kept for a result of the same
  size (try again) and cleared for a picture of another size.
- **Why not AnyPaint** (the plan): tested on the PC with a photo of two children. AnyPaint needs the whole finished
  picture described; with no description it filled a removed girl's place with a balloon, and with a tighter mask
  (her hand left outside it) it drew **a different, older-looking girl in a crop top and shorts**. Qwen Lightning with
  a plain instruction removed her cleanly, put a red cap on the boy first time and turned his shirt yellow, ~6 s warm,
  with **0.00 mean change outside the painted area** at full size.
- **Tested:** `paint.test.js` (new, 44); edit-modes 25, extend 70, playground 63, runs 79, landing 46, image-jobs 14;
  3 painted edits on the PC's GPU through the staged proxy. **Not tested:** a real finger on the iPhone, hosted models
  (not built: the paste-back would have to run in the proxy with sharp).

## ✨ Playground Edit and Reimagine merged (2026-11-26) — deployed 2026-11-26 (`208dde8`, frontend only)

The 🔄 Reimagine tab is gone; ✨ Edit has a two-way switch at the top (`_setPlaygroundEditMode` in
`image-playground.js`, remembered as `api.image.editMode`):
- **✏️ Change it**: the old Edit (presets, edit model, ✨ Edit Image).
- **🔄 New shot**: the old Reimagine (pinned source, Likeness for local Qwen, Shape, How many, the written Prompt,
  🔄 Make the new shot). Same handlers as before; only the controls moved.
- One instruction box (`#playground-edit-instruction`, relabelled per mode) and one row of 📐 angle buttons
  (`data-angle-mode="auto"`: an edit instruction or a new-shot phrase, decided at the tap; switching modes rewords an
  angle already in the box). Each mode keeps its own model (`editModel` / `reimagineModel`). The panel's `newshot`
  class hides the other mode's controls (`.pg-change-only` / `.pg-newshot-only`). Anything that opened the Reimagine
  tab (`_setPlaygroundToolTab("reimagine")`, reusing a history entry) opens Edit in New shot.
- **Tested:** `edit-modes.test.js` (new, 25: WebKit 390 / 320 dark); playground 63, extend 70, lightbox 28. **Not
  tested:** the iPhone, a real model.

## ⤢ Playground Extend (2026-11-26) — deployed 2026-11-26 (`63fdc52`, then the paste-back in `a5e4032`, proxy + frontend)

Outpainting, local GPU only (Joe's choice), with **MOSS AnyPaint**: the inpainting LoRA on MOSS-Image *Base* plus
a DMD2 8-step LoRA, already on the PC for SparkleImage (its 2026-11-17 evaluation: seamless outpainting, ~3 s warm;
Qwen edit can't outpaint). A new ⤢ Extend tab after Reimagine:
- **New shape** (1:1 … 21:9) and **Extra room** (Shape only / A little more / More / Lots = 1, 1.25, 1.5, 2× each way).
- **Place the picture**: a frame preview of the new shape (checked = drawn new; never taller than ~45% of the screen);
  drag the picture, tap the empty area, or the 3×3 arrow buttons. Buttons along a side with no new room are off.
- Optional **Description**: AnyPaint wants the *whole finished picture* described, not a change; empty sends a generic
  "carry on what's there" prompt (`ANYPAINT.defaultPrompt`). **✍️ Describe it** fills the box from the vision model
  (the same call as 🔍 Describe, only when tapped). When over 60% of the result is new and the box is empty, the note
  under the frame warns.
- **Room on both axes runs in two passes** (sides, then top and bottom, in one ComfyUI graph).
- **The original is pasted back** over the result (`SolidMask` → `FeatherMask` → `ImageCompositeMasked`), fading in over
  32 px (`ANYPAINT.seamFeatherPx`, the band AnyPaint redraws) only on sides that meet new room. Joe spotted the boy in
  the samples turning into someone else: AnyPaint regenerates the whole canvas and only steers the original back, so
  colours shifted and faces changed (mean difference 4–12 of 255 inside the original, up to 6% of pixels well off;
  worst with two passes). After: 0.0–0.5 on landscape sources, no visible seams at normal size. **Still imperfect:** a
  person cut off by the picture's own edge (a face at the seam) gets a made-up other half, and the join through the
  face can look off. Deployed in `63fdc52` without this; the paste-back is the commit after.
- **Proxy** (`server.js`): `extend: { sourceWidth, sourceHeight, ratio, x, y, room }` on a `local/moss-image` request →
  `parseExtendRequest` / `extendLayout` (canvas 1–1.5 MP, every size a multiple of 16) → `buildMossExtendGraph`
  (`ImageScale` then `MOSSAnyPaintPrepare` with padding, no mask). Resumable and kept in Recent (`__keep` tool
  `extend`) like the other tools. `extend` on a hosted model is refused before any call.
- `apiHandler.extendImage` in `api-image.js` (a shared script, so the proxy image rebuilds).
- **Tested:** `extend.test.js` (new, 59: fake ComfyUI + real proxy + WebKit 390 / 320 dark, incl. the tab closed
  mid-draw); playground 63, runs 79, image-jobs 14, lightbox 28, landing 46. **Not tested:** the iPhone (real touch drag),
  the deployed proxy through the gateway.
- **On the PC's GPU (2026-11-26, the staged proxy against local ComfyUI, 17 runs on a photo of two children at a swing
  set, landscape and a portrait crop):** one axis (sides, or top and bottom, or one side) seamless, ~9 s warm (38 s
  cold); two passes 14–21 s. Findings that shaped it:
  - **All four sides in one pass drew a frame round the picture** every time (poster border, vignette, ghosted copy,
    fake lettering), with the default prompt and with "a wide shot photograph"; only a full scene description avoided
    it. Two passes fixed it with or without a description.
  - **Most of the canvas new + no description** (portrait → 16:9 with room 1.5, ~77% new) wandered into a street scene
    with poster lettering on 2 of 2 seeds; with a one-line scene description it was excellent. Hence the warning.
  - A face right at the picture's edge gets redrawn (AnyPaint redraws a 32 px band at the seam,
    `boundary_redraw_px`), so a person cut off by the edge comes back as a different face.
  - Square with room from a landscape left a faint brightness step at the original's top and bottom edges.
- **Licence note:** AnyPaint LoRA's licence not checked here; MOSS-Image itself is OpenMOSS's.

## Queue (2026-11-26)
- Empty. Possible: 🖌️ Paint an area on hosted edit models (paste-back in the proxy with sharp).

## 🎭 Personas (2026-11-26) — deployed 2026-11-26 (`991cce8`, storywriterbackend + proxy + frontend)

After deploying (DB backed up first: `~/backups/cardgen-db-20261126-1138-prepersona.sql.gz`): all containers
healthy, the backend started cleanly, the 11 `saved_user_personas` rows became 11 persona cards (484 characters
beside them), and the site serves `persona-picker.js?v=20261126-persona`. Nothing signed-in tried on the live site yet.

The player's own character as a card (`character_cards.kind = 'persona'`, extras in `persona` JSON:
age, gender, voice, isDefault). Plan, decisions and deviations: `plans/persona-mode.md`.
- **Make one:** Character Gen → Card Type → 🎭 Persona (you): a short "facts, not behaviour" template
  with the persona's real name (no `{{char}}`), no POV / cast, finishing = tags only; the editor hides
  scenario, first message, examples, notes, post-history, lorebook and greetings and shows Age,
  Gender / pronouns, How they talk. Revise / Remaster have a persona branch. Server runs handle it.
  Or from the picker (✨ New: save as typed, or ✨ Write it for me on the server), or Home → a
  character's sheet → 🎭 Make a persona.
- **Pick one:** `src/scripts/persona-picker.js`, the same in Roleplay Chat's new-chat sheet,
  Messenger's new / ⚙️ settings sheets and Adventure (Protagonist) new / 🎛️ sheets. Pre-picks the
  persona last played with those characters, else the ★ default. Roleplay Chat: "🙋 As X" chip in the
  ＋ tray switches mid-chat.
- **Chats follow the card** (`storywriterbackend/app/services/persona.py`): the copied
  `user_persona_*` fields are refreshed from the card on open and every turn; a deleted card leaves
  the last copy. Roleplay Chat cards now get `{{char}}`/`{{user}}` filled in.
- **On startup** `saved_user_personas` rows become persona cards once (exact duplicates merged;
  matching chats and adventures linked; marker `personas_migrated_v1` in `app_secrets`).
- **Home:** 🎭 badge on persona tiles, 🎭 Personas chip, ★ Make my default on a persona's sheet.
- **Tested:** backend 117 (11 new); `persona.test.js` 53 (proxy + WebKit 390 / 320 dark, incl. page
  hidden mid-write and the tab discarded mid-write); parser, runs 79, phase 0 50, runs-page 81 and
  the other cardgen suites re-run. **Not tested:** a real model writing a persona, the iPhone.
- **Flaky:** `landing.test.js` "reopened: the picture is offered to pick" failed 3 of 10 runs with this
  work, 0 of 4 completed runs on the commit before it; no page errors, and it couldn't be caught again
  in 4 instrumented runs. Nothing here touches that code path, but not proven unrelated. home-browse's
  tagging check failed once only when run alongside another suite (145/145 alone).
- **To try after deploying:** Character Gen → 🎭 Persona, generate, Save to Library; ★ it on Home;
  start a Messenger chat (it should be pre-picked); edit the persona and see the next reply use it.

## Light card lists at start-up; new app icon (2026-11-25) — deployed 2026-11-25 (`57f8f5b`, proxy + frontend; live light list 74 KB / 155 ms vs 11.3 MB)

- **Every app start downloaded every card in full** (11.3 MB for Joe's 481 cards + 30 history), twice, whatever
  tab was open. That turned out to be **Roleplay Chat's persona dropdown** (`chat-handler.js` `loadPersonas`, at
  init and on opening Chat), not only Character Gen's library sidebar. Both only show names.
- New proxy route `GET /api/storage/cards/library` (before `/:id`): the backend's `/api/cards/summary` + history,
  cut to `{id, characterName, isPermanent, createdAt, updatedAt}`. `storage.listCardsLite()` reads it (falls back
  to `listCards()` if the proxy is older). Used by: the library sidebar, the persona dropdown, Prompt builder's
  🖼️ Match → Characters, the save paths' "existing card / createdAt" lookups, and Clear history.
- `refreshLibraryViews` does nothing while `#view-cardgen` is hidden except mark the lists stale; a
  MutationObserver on the view's style fills them when Character Gen is next shown, however it is shown.
- Still on the full list (on demand only): 🖼️ Gallery, Messenger's and Adventure's card pickers (`cardGallery.open`
  shows card text).
- **New icon:** fanned character cards + gold sparkle on a purple night sky. Source `icons/icon.svg`; PNGs made with
  sharp (apple-touch 180, 192, 512, maskable 512 with the art in the middle 78%, favicon 256 rounded). `?v=20261125`
  on the links and manifest. **iOS keeps the icon from when the app was added to the Home Screen:** remove and re-add
  it to see the new one.
- Tests: `home-browse` 145 (new: no full list on start, library unfilled on Home, fills from the light list when
  Character Gen opens, Load still opens the full card); all other suites green. Not tested on the iPhone.
- Deploy: proxy + frontend.

## Home: character browser + 🏷️ AI tagging (2026-11-24) — deployed 2026-11-24 (`b3242de`, proxy + storywriterbackend + frontend)

Joe's library had grown to 481 cards (25 pages of 20). Browsing was slow and clumsy: search matched any word
in any card's text, Prev/Next jumped the scroll (the grid emptied, the page shrank, then a smooth scroll to the
heading), and opening Home downloaded every card in full (~4.7 MB with lorebooks) plus full-size portraits
(median ~290 KB, up to 8 MB) for every tile.
- **Light list:** `GET /api/storage/cards/summary` (backend `GET /api/cards/summary`): id, name, tags, dates, a
  240-char blurb, has-lorebook, and **uses / last used** counted from roleplay + Messenger chats, stories and
  adventures. The card's text is fetched only for 📄 Full card.
- **Thumbnails:** `/api/storage/cards/thumbnail?cardId=…&w=320` → a WebP made with **sharp** (new proxy
  dependency, `0.33.5`), kept in `users/<id>/card-thumbs/<id>-<w>.webp`, remade when the portrait file is newer,
  ETag/304. Widths snap to 160/320/480/640. No `w` → the full picture as before. If sharp fails to load, the
  full picture is sent. Deleting a card deletes its thumbnails.
- **The page** (`home-handler.js`, CSS under "Home: character browser"): one grid that grows 48 at a time as you
  scroll (scroll listener + IntersectionObserver: headless WebKit's IO missed a transition after a batch was
  added, so IO alone stalled), small 3:4 tiles (3 a row on a 375+ phone, 2 at 320). A **sticky bar**: search,
  sort (Newest · Last edited · Last used · Most used · A–Z · Oldest), and a sideways-scrolling chip row:
  📝 Descriptions, 💬 Used, 🌱 Never used, then the 40 commonest tags (AND when several are picked), ✕ Clear.
  Changing a filter while scrolled deep brings the results back to just under the bar, not to the page top.
  Sort, the used filter and Descriptions are remembered (`cardgen.homeBrowse.v1`). `#view-home` uses
  `overflow-x: clip` (was `hidden`, which would stop the bar sticking).
- **Search** matches names and tags only, ranked: name starts with the word → a word in the name starts with it
  → name contains it → tag → tag contains; every word must match. **📝 Descriptions** adds the backend's text
  search (`GET /api/cards/search?q=`: every word, in name/description/personality/scenario/first message/tags).
- **Tapping a tile** opens a card sheet (bottom sheet on a phone): portrait, made date, usage, 📚 lorebook, tags
  (tap one to filter by it), the blurb, and 💬 Chat · 📖 Story · 💌 Text · ✏️ Edit · 📄 Full card · 🗑️ Delete
  (the old per-tile buttons, same handlers).
- **🏷️ Tag N untagged** (only 30 of 481 had tags): the proxy tags them itself (`proxy/runs/tag-runs.js`,
  `GET/POST /api/card-tags/run`, `POST …/run/stop`), 3 at a time, with the page's own `generateTags`
  through the prompt host, so the editor's ✨ tags and these match. **`generateTags` now picks from a fixed
  vocabulary** (`CARD_TAG_VOCABULARY` in `api-character.js`: who, setting, species, role, personality, tone,
  nsfw/sfw, plus at most 2 extras) with synonyms folded (`CARD_TAG_SYNONYMS`), so filters group cards together.
  Only untagged cards are picked, so a stopped, failed or restart-interrupted run is just started again. Stops
  after 5 failures in a row, or at once on a 401/402/403 from the model. Saves with `PATCH /api/cards/:id/tags`,
  which leaves `updated_at` alone (Character Gen's library is sorted by it). Uses the settings the page sends,
  else the saved config. State: `users/<id>/tag-run.json` (no keys). The page polls every 3 s while visible
  and refreshes the grid as tags land.
- **Live check before deploy:** the tag prompt on 3 of Joe's real cards with `deepseek/deepseek-v4-pro-0813`:
  ~2.5–3.6 s and ~1,500 tokens each, no reasoning, good tags (e.g. Neill Ratcliffe → female, fantasy, elf,
  royalty, dominant, cold, confident, dark, romance, nsfw). The replies come in ```json fences; the parser
  handles them.
- **After deploying (checked live as Joe):** summary 481 cards in 211 KB / 92 ms (the old full list: 10.7 MB /
  457 ms); a tile thumbnail 22 KB (portrait 1,236 KB), 101 ms to make, 5 ms after; sharp 0.33.5 loads in the
  Alpine image; the site serves the new script versions. **The tagging run was started for Joe and finished:**
  451 tagged, 0 failed, 4.7 min (~2 cards/s). Now 0 untagged; 341 distinct tags, 167 on 2+ cards (the chips show
  the top 40 of those). Commonest: female 435, nsfw 417, modern 325, human 271, mysterious 201, dark 192,
  romance 174. `tokens` in the run reads 0: nano-gpt sends no usage on streamed replies (cosmetic).
  **Not yet seen on the iPhone.**
- **Tested:** `tests/cardgen/home-browse.test.js` (new, 130 checks: proxy routes + tagging run without a
  browser; the page in WebKit 390 / 320 dark / 1280; tagging from the page with the page hidden mid-run);
  backend `tests/test_card_summary.py` (new, 4) and all 106 backend tests. **Not tested:** the iPhone; a real
  full tagging run (it's about to be Joe's first).
- **Follow-up done 2026-11-25:** see "Light card lists at start-up" above.
- **Deploy:** proxy (new `sharp` dependency → image rebuild) + storywriterbackend + frontend.

## Image retries join the running job (2026-11-23) — deployed 2026-11-23 (`fb5f65b`, proxy only; the running proxy has `joinExistingImageJob`)

Joe's Qwen edit in the Playground (desktop Chrome) never arrived. From the logs: the edit took ~85 s on the
GPU; the browser closed the request at ~60 s (NPM 499) and the page re-sent the POST, three times, each a
new ComfyUI job; then `GET /api/jobs?clientRef=` returned the **newest** duplicate (still queued, then
deleted by Joe), so the page waited on a job that would never finish. The first picture was saved to
Playground Recent at 15:42.
- **Fixed (`proxy/server.js`):** `joinExistingImageJob` at the top of `/api/image/generations` and
  `/api/image/combine` (hosted and local): a resumable request whose clientRef already has a running or
  finished job for that user joins it (answered when it finishes) or gets the result, instead of drawing
  again. A ref whose job failed starts afresh. `/api/jobs?clientRef=` sorts done, then running, then
  failed (`byJobPreference`); the unfiltered list is still newest first.
- **Not found: why the browser gave up at 60 s.** Joe's image timeout is 180 s, the frontend nginx's
  300 s, and 499 means the client hung up. Nor why the first two retries didn't look for the job first
  (`_tryCollectResult` should have, and NPM shows only one lookup). The console's `[API] Attempt N
  failed: …` lines would say.
- **Tested:** `tests/cardgen/image-jobs.test.js` (new, 14; 9 fail on the old code), runs 79, playground
  63, landing 46 (two early runs failed different checks while the PC's GPU was thrashing; 8 later runs
  clean, and no request in that suite reaches the join). **Not tested:** the local ComfyUI route itself
  (shares the same check at the route top), the iPhone. **Deploy:** proxy only.

## Story Writer: ✍️ Freeform beside the lengths (2026-11-23) — deployed 2026-11-23 (`0e8cff0`, frontend only; the site serves the new version)

Joe couldn't find the old part-by-part mode after the auto-writer went in. It was still there as "✍️ Write it
with me" in the sheet's footer, under Length / Ending / the cards slider, which don't apply to it. Now **✍️ Freeform**
is a fifth tile under Short–Epic (full width): picking it hides Ending and the slider, shows a one-line hint, and
the footer becomes **✍️ Start writing**, which creates a plain story (idea → synopsis) and **writes the opening at
once** (`generateNext()`); every later part waits for Continue, with the steer box as before. The choice is
remembered with the other sheet prefs (`cardgen.storySetup.v1`). Planned lengths are unchanged.
**Tested:** `tests/cardgen/story-setup.test.js` (new, 44: WebKit 390 light / 320 dark, `/api/sw/*` faked with
`page.route`; needs `serviceWorkers: "block"` or the routes miss). **Not tested:** the iPhone, a real model.
**Deploy:** frontend only.

## Narration chunks; Story Writer sex scenes (2026-11-23) — deployed 2026-11-23 (`9fc2181`, frontend + storywriterbackend)

After deploying: the backend started cleanly with both prompt rules loaded; the site serves
`storywriter.js?v=20261123-ttsmerge` with the merge. No story generated or narrated on the live site yet.

- **Narration** (`TTSPlayer._takeNextRequest`, `storywriter.js`): paragraphs already queued for the same voice
  go to TTS together up to 450 chars (`MERGE_UP_TO_CHARS`). Kokoro speaks ≤510 phonemes (~500 chars of
  English, measured ~1 per char) as one piece and splits anything longer, so bigger requests add no context.
  Stored stories: paragraph median 259 chars, 90th pct 535, 21% under 80. Never waits for more text, so
  streaming starts no later. Merged paragraphs lose the paragraph pause (a sentence pause instead). Applies to
  every provider and to Adventure's Read aloud. **Tested:** 6 Node checks of the merge. **Not tested:** by ear,
  the Story Writer WebKit suite (not on this PC), the iPhone. **Deploy:** frontend only.
- **Sex scenes** (`SEX_SCENES` in `context_manager.py`, used by Continue and every auto-written chapter;
  `PLAN_SEX_SCENES` in the planner): on the page, explicit, slow and moment by moment, no fade to black, adults
  only; Continue leaves an unfinished scene for the next section; a chapter with one may run 1.5× long; the
  planner builds a chapter around such a scene and doesn't soften an adult premise. **Tested:** 102 backend
  tests. **Not tested:** a real model. **Deploy:** storywriterbackend (interrupts running auto-writes).

## Lightbox uses the whole screen; Describe toggles (2026-11-22) — deployed 2026-11-22 (`d201dfd`, frontend only)

Joe on the iPhone: the lightbox zoomed inside the picture's own box and wouldn't pan. Cause:
`.gallery-image-container` was capped at 90vw × 80vh with `overflow: hidden` and hugged the picture, so a
zoomed picture was cropped to its resting box, and a touch outside it hit the backdrop (a tap there closed).
- **The picture area is now the whole screen** (`main.css`): the picture rests fitted to the screen, zoomed
  it fills it, and pinch/pan start anywhere. Toolbar, arrows and caption float over it.
- **Tap on the picture** hides/shows them (`chrome-hidden`, after the 300 ms double-tap window); a tap off
  the picture closes, as the backdrop did. Mouse: a click off the picture closes unless it ended a drag.
- **Max zoom** is twice the picture's own pixels, 6×–16× (`_galleryMaxScale`; was a flat 5×). The 50 ms
  transform transition is gone (lag under a finger). Applies everywhere the lightbox opens.
- **🔍 Describe** is now a toggle: "Hide description" while open, "Show description" (no call) for the same
  picture, **🔄 Describe again** in the box replaces ✕ Close; a failed redo keeps the old text.
- **Tested:** `lightbox.test.js` (new, 28: WebKit 390 px with synthetic touches + 1280 px mouse), playground
  63, landing 46. **Not tested:** a real iPhone (real multi-touch; whether Safari renders a 10× zoom sharp).
  **Deploy:** frontend only (`--no-deps`).

## Playground: 🔍 Describe (2026-11-22) — deployed 2026-11-22 (`be89bb0`, proxy + frontend)

🔍 Describe beside 💾 Save to library: the vision model (`api.text.visionModel`, else the text model)
describes the working image as a reusable prompt (`describeImageForPrompt` in `api-image.js`: medium +
subject, appearance, pose and camera, setting, lighting and style, 100–200 words, nudity described
plainly). Not Character Gen's `describeReferenceImage`, which is worded for roleplay cards and leaves out
style and framing. Streams into an editable box under the picture (resumable, like every vision call);
🪄 Use to generate puts it in the Generate box, 📋 Copy, ✕ Close. The box hides when the working image
changes. A failed or cut-off reply shows nothing. **Tested:** `playground.test.js` (56, 12 new: streams,
hidden mid-stream → lands with one model call, Use to generate, hidden on a new picture, failure, no
sideways scroll at 390), `runs.test.js` 79. **Not tested:** the real vision model (does Gemini refuse
NSFW pictures?), the iPhone. **Deploy:** frontend + proxy (`api-image.js` is a shared script).

## Playground: tool tabs on top, "2 per model" (2026-11-22) — deployed 2026-11-22 (`83c5c51`, frontend; the proxy was recreated with it)

The Generate / Crop / Edit / Reimagine / … tabs (`#playground-tool-tabs`) moved above the drop zone and
picture; their panels stay below the picture. How many → **2 per model** (`models2`): each ticked model
draws twice, grouped in the grid (up to 4 models, so up to 8 images). `_playgroundPerModelCount()` in
`image-playground.js`. Tested in headless WebKit (390 light / 320 dark / 1280; real page + proxy, fake
image model): tab order, panels switch, no sideways scroll, 2 per model sends 2 requests per ticked model,
remembered on reload, 1 per model and plain counts unchanged. Not tried on the iPhone.

## Playground: Recent pictures + prompt history (2026-11-22) — deployed 2026-11-22 (`6b85489`, proxy + frontend)

- **Every Playground picture is kept for 3 days** (Generate, Edit, Reimagine, Enhance, Combine; not Crop,
  not Character Gen or Messenger). The page tags the request `__keep: { tool, prompt }` (a `keep` option on
  the five `api-image.js` calls); `createGenerationJob` reads it and `finishGenerationJob` saves the picture
  (`keepPlaygroundImage` in `server.js`), so it is kept even if the phone locked or the tab was discarded, and
  the phone never uploads it again. Stored on the proxy's disk, not the database: `users/<id>/playground-recent/`
  (`<id>.img` + `index.json`), pruned on every write and list to 3 days and 300 pictures
  (`PLAYGROUND_RECENT_DAYS`, `PLAYGROUND_RECENT_MAX`), with unlisted files swept. One write at a time per user.
  Routes: `GET /api/storage/playground-recent`, `GET …/:id/image`, `DELETE …/:id`.
- **📚 Library → 💾 Saved / 🕘 Recent.** Recent tiles: ✏️ Edit, 💾 Keep (copies into Saved, stays in Recent),
  🎭, ⬇, 🗑️. A picture the page rejected as "blank" (safety filter) is still kept, as the provider returned it.
- **Prompt history:** the last 30 prompts sent from Generate, Edit and Combine each, newest first, repeats moved
  to the top, as a "Recent" group in each box's presets dropdown. Per account in
  `users/<id>/playground-prompts.json` (`GET/POST /api/storage/playground-prompts`), not in the config, which
  is re-sent whole on every settings change.
- **Tested:** `tests/cardgen/playground.test.js`, 43 checks (real proxy + page, WebKit 390 / 320 dark / 430 dark).
  **Not tested:** a real provider's URL result being fetched and kept (the fake returns a data URL), the local GPU
  route, the iPhone. **Deploy:** proxy + frontend (the proxy rebuild drops in-flight jobs).

## Local model survey (2026-11-22): Ideogram 4 parked

Joe dropped `local/flux3-klein` from his model list (results consistently a bit off). Its DiT file and the
unused NoobAI-XL checkpoint were then deleted from the PC, so `local/flux3-klein` (still in
`LOCAL_COMFY_MODELS`) now fails in ComfyUI if picked; its text encoder and VAE stay (FIBO 2.0 uses them). A survey of ComfyUI's
local image templates found nothing clearly better than what's installed. **Ideogram 4.0** (Comfy-Org/Ideogram-4,
int8, Ideogram non-commercial licence) was started and **parked before testing**: it runs two 9.6 GB DiTs per
step (conditional + unconditional guider, won't both fit in 16 GB), has a built-in NSFW safety filter,
is text-to-image only, and ranks below Qwen 2.1 / level with H3 on Arena. Its strength is typography and
layout, not portraits. If revisited: the template is `image_ideogram4_t2i_int8`; the existing
`qwen3vl_8b_int8_convrot` and `flux2-vae` serve as its text encoder and VAE. Possible later adds: SeedVR2
(3B/7B int8) as a free local upscaler for ⬆️ Enhance; Anima v1 as an Illustrious alternative.

## A notification tap no longer replaces the open app (2026-11-20) — deployed 2026-11-20 (`9177cb2`, frontend + storywriterbackend)

After deploying: the site serves the new `card-recovery.js` version and `sw.js`, and the backend builds
`mutable` payloads (checked inside the container). No push has been sent or tapped since.

Joe started ⚔️ Compare Models on the iPhone (Home Screen app), locked it, tapped the "done" push, entered
the PIN and got an **empty Character Gen**. From the logs: the four pictures finished at 17:35:26; at
17:35:35 the *old page* sent its pagehide presence beacon and a fresh page booted. The app was alive; the
tap replaced it. Cause: pushes are Apple's declarative format, and a tap on a declarative notification
makes Safari load its `navigate` URL with no JavaScript involved ("navigated to by the browser upon
activation", WebKit's Declarative Web Push post), so `sw.js`'s "is the app already open?" check never ran.
The pictures weren't lost: the proxy saved them as History copies ~10 min later, and the new page hadn't
landed them sooner because they were under 2 minutes old.

- **Pushes are `mutable`** (`services/push.py`, top level and inside `notification`; WebKit bug 297389
  says it moved). Safari then hands them to `sw.js`, which shows its own notification without
  `navigate`; a tap goes to `notificationclick`, which messages the open page. The declarative one is
  only Safari's fallback if `sw.js` fails. `sw.js` also listens for `pushnotification` (WebKit's
  name in bug 261956), always tags notifications so a double delivery replaces itself, and looks for the
  open window 4 times over ~750 ms before `openWindow`, in case a frozen page isn't listed at once.
- **A replaced or discarded page puts the card back** (`card-recovery.js`): on every hide the page writes
  `cardgen.openCard.v1` (the card's text as on screen, its id, the newest stored copy `_lastStoredId`,
  POV/type). The next page loads the stored copy (portrait, picture history) and lays the on-screen
  text over it, so unsaved edits survive. A new card cut short still wins (`NewCardMarker`). Skipped if
  another tab answers (a second tab starts empty, as before). Kept 24 h. **Every cold start now opens
  Character Gen on the last card**, not an empty form.
- **Its pictures are offered again**: image jobs now record the card (`cardKey`), model and prompt in
  `cardgen.pendingJobs`. For the card put back, the next page shows the pick-one screen ("Drawn while the
  app was away: pick one", Keep current first), waiting for any still being drawn; it opens when
  Character Gen is shown. Closing it before a picture is collected leaves that picture to the proxy, which
  saves it to History. Other cards' pictures land in History as before (2-minute rule kept for those).
  A picture the proxy already saved can also be offered (then it is in History twice).
- **Tested:** landing 46 (14 new: card back with portrait, picture offered and picked, still drawing,
  Keep current, closed early → History, another card → History, unsaved text, Compare Models with two
  models, nothing open → empty), phase 0 50, runs-page 81, runs 79, parser; backend push 22; `sw.js` in
  Node (7: mutable push shown without navigate, `pushnotification` with only a proposed notification,
  click with the page found at once / on the third look / not at all, foreign link).
  **Not tested:** whether iOS really runs `sw.js` for a mutable push and calls `notificationclick` (only
  a real iPhone can say), or whether `clients.matchAll` lists a locked app's page.
- **To try on the iPhone after deploying** (frontend + storywriterbackend; no proxy rebuild): start
  Compare Models, lock, tap the push, enter the PIN: the same page should be there with the pictures.
  The logs tell the two cases apart: a `POST /api/push/presence` then a burst of boot requests
  (`/api/proxy-data/config`, Story Writer connection check) means the page was still replaced.

## 🔊 Faster Kokoro for narration (2026-11-19) — deployed 2026-11-19

AkinVox **Faster Kokoro** (`AKinvox/faster-kokoro-v1`, released 2026-11-19, Apache-2.0): Kokoro-82M's
own text front-end, voices and prosody, with the waveform decoder swapped for a 31M mel head + the
public Vocos vocoder. New service `faster-kokoro/` (Dockerfile + `server.py`, a small FastAPI server
speaking the same `/v1/audio/speech` and `/v1/audio/voices` as kokoro-fastapi, wav/pcm only).

- **Proxy** (`fetchFasterKokoro` in `server.js`): Kokoro speech goes to `FASTER_KOKORO_URL`
  (default `http://faster-kokoro:8880`, empty turns it off) first. Any non-200 (legacy `v0` voices,
  Japanese/Mandarin, mp3) or network error falls back to stock `kokoro-tts`; after a network error
  it is skipped for 60 s, so a stopped container costs one ~5 s DNS timeout, not one per sentence.
  The proxy now also aborts the upstream request when the browser hangs up. The voice list still
  comes from stock Kokoro (67), since every voice keeps working through the fallback.
- **Server:** 41 voices (the 54 minus `j*`/`z*`, whose misaki extras aren't installed); blends
  `a+b` and `a(2)+b(1)` mixed by weight; one request at a time (asyncio lock); between pieces
  (KPipeline's ≤510-phoneme chunks) it checks whether the caller left and stops. All weights and
  voices are baked at build (pinned Kokoro revision; `HF_HUB_OFFLINE=1` at run). **Torch must stay
  CPU-only:** vocos → torchaudio pulls a CUDA torch (+6 GB, a 12 GB image); the Dockerfile installs
  torch + torchaudio from the CPU index and holds them with a constraints file (image 3.5 GB).
- **Measured on OCI (4 cores, one request at a time, median of 3, bf_alice and am_eric):** 54 chars
  2.4–2.6 s → 0.6 s; 278 chars 11–12 s → 2.1–2.3 s; 877 chars 33–36 s → 5.9–6.3 s. **3.9–5.8× faster**;
  stock was barely faster than real time on long text, Faster is ~7× real time. Memory ~1.3 GB, as stock.
  Whisper base.en transcripts of both engines match word for word (only the usual Whisper slips in both);
  long clips are ~10% shorter because the pauses between sentences are shorter.
  After a hang-up mid-request the next short request waited 2.8 s (stock: ~15 s).
- **Tested:** the server directly (blends give distinct audio, speed, French, 400s with the voice list,
  hang-up), and the dev `server.js` in a throwaway proxy container on the app network (fast path, blend,
  `af_v0bella` → stock, bogus voice → stock's 400 passed through, fast server gone → stock, the 60 s skip,
  a browser hang-up reaching Faster Kokoro). **Not tested:** listening by ear (the voices are 0.90–0.99
  similar to stock per the model card; Hindi lowest), the deployed stack, Story Mode on the iPhone.
- **Deploy:** the live `docker-compose.yml` is untracked; add the `faster-kokoro` service block from
  `docker-compose.example.yml` (no host port) and `FASTER_KOKORO_URL` on the proxy, then build
  `faster-kokoro` and rebuild the proxy. `kokoro-tts` stays: HandyTime and offbook use it too.
- **After deploying (`663f90e`):** through the live proxy (throwaway user): `bf_alice` answered by Faster
  Kokoro (76 chars, 4.8 s of audio in 0.72 s), `af_v0bella` fell back to stock (3.1 s), voice list still 67.
  Live compose backed up as `docker-compose.yml.bak-20261119-fasterkokoro`. **To try:** Story Mode on the iPhone.

## Character Gen backend-driven (2026-11-19) — phases 0–3a, cast, the Revise group and picture landing **deployed 2026-11-19 (`223472e`)**

Plan and reasoning: `plans/character-gen-backend-driven.md` (its "What was built" section lists the
deviations). Built while Joe was in meetings, on his instruction to carry on through the phases.
**After deploying** (proxy + frontend rebuilt; compose recreated storywriterbackend as well): all
healthy. The proxy image has `/app/runs` and the ten shared scripts in `/app/src/scripts`; inside the
container the prompt host loaded them, built a card prompt (8,932 chars) with no page access, and the
data folder is writable for run files. `GET /api/card-runs/active-count` with no token answers 401 with
`X-Session-Expired`, directly and through nginx. The site serves the new script versions and the
Settings switch. **No signed-in request and no real generation was made on the live site**; the
"server runs" setting is off until Joe turns it on.

**Phase 0, on for everyone (no setting):**
- **Every single-field call is a resumable stream** (`APIHandler.streamedText`, `api.js`): Redo,
  example messages, notes, post-history, tags, name ideas, alt greeting, consistency check, Revise,
  the Inspire and 4-ideas brainstorms, image analysis, style extraction, prompt shortening. Nine were
  non-streamed (iOS 60 s cut and re-send). An empty reply no longer falls back to the model's reasoning.
- **A new card is saved to History as soon as its text is parsed** (a draft; `saveDraftToHistory`),
  and the save at the end replaces that item (`replaceHistoryId`). Stop after the text step now
  leaves the card in History.
- **Recovery after a discarded tab** (`card-recovery.js`): a marker in localStorage
  (`cardgen.newCard.v1`); a page that loads and finds one nobody finished puts the card back, from
  History (applying a finishing-fields reply the proxy still holds) or from the held card job. No paid
  calls; it says what is still missing. A second tab asks the first over a BroadcastChannel first.
- **Parser** (`character-generator.js`): scenario titles read from the plain `# Title` header; "The
  Red Cobras" no longer turns every "The" into `{{char}}` (`ORDINARY_WORDS`); "The name's X" only
  looked for in the description.
- **Proxy History saves and deletes** touch one item (`saveHistoryCard`, and the History branch of
  `DELETE /api/storage/cards/:id`); saves evict the oldest by date. Before, both rewrote the whole
  list from a read that returned `[]` on any error, so a failed read followed by a working write
  would have deleted all of History. A failed write is now reported. The client-side trim (it
  downloaded every card on each save) is gone, and so is `writeHistory()`.
- The image routes no longer forward the page's internal `__jobLabel` field to the image provider.
- **Fix:** a pipeline still unwinding after Stop no longer resets the form of a generation started
  straight after it (`_beginNewCard` / `_endNewCard(flow)`; classic, 4 ideas, Inspire Me).

**Phases 1–3a, behind Settings → "Make new characters on the server (beta)" (`app.serverRuns`, off):**
- **Card runs** (`proxy/runs/card-runs.js`): `POST /api/card-runs` and the proxy writes the card,
  parses it, saves it to History, writes the finishing fields, **draws the portrait**, saves again and
  reports once (push label "New character", never the name). Routes:
  `GET /api/card-runs[/:id]`, `/:id/stop`, `/:id/resume`, `/active-count` (how many are running:
  a replacement for reading `docker logs` before a rebuild). State is one JSON file per run in
  `proxy/data/users/<id>/runs/`, written after every step, kept 24 h; API keys stay in memory. A
  proxy restart leaves a run "interrupted" and Resume carries on from the first unfinished step.
- **The proxy runs the browser's own prompt files** (`proxy/runs/prompt-host.js`): `api-character.js`,
  `api-image.js`, `prompt-look.js`, the name bank, the parser, `character-search.js` and four small
  ones are loaded into a Node `vm` sandbox with a server-side `APIHandler` (`host-api.js`). No second
  copy of any prompt. **Those ten files (`SHARED_SCRIPTS`) now run in two places**: a change in them
  that reaches for `document` on a path a run uses breaks server runs, and the tests say so.
  `content-context.js` and `image-model-caps.js` are new files split out of `api.js` and `config.js`.
  `Dockerfile.proxy` copies them one by one (`SHARED_SCRIPTS`), so other front-end changes still
  leave the proxy container alone.
- **The page** (`card-runs.js`) polls every 1.5 s while visible and not at all while hidden; no
  watchdog, no resume loop. Gateway errors and no connection are waited out. Stop reaches the server.
  On load it attaches to a run in progress (its own, or one another device started) or shows one
  that finished while it was away. `writeNewCard()` is the shared middle of Generate, 4 ideas and
  Inspire Me, so all three use a run.
- **The portrait** is the run's third step when images are on and there is no reference image: the
  first model marked Generate, the style reset as the page does it, one retry on the hosted fallback
  if a local model fails (prompt reused), result stored with the card. A failed portrait does not
  fail the run; the page reports it and does not draw one itself. `generateNewCharacterImage` shows
  the run's portrait instead of drawing. **Only supporting cast is still the page's step**: a card
  whose page went away is complete in History, portrait included, but has no auto-cast.
- Name history for server runs is per user in `users/<id>/cardgen-state.json`, separate from each
  device's own list.
- The brainstorm call of 4 ideas and Inspire Me (before you pick) is still a page request, as are
  saving the prompt to the library and every action on an existing card.

**Tests** (`tests/cardgen/`, README there; needs playwright-core and the proxy's packages outside the
repo): the **real** `proxy/server.js` against a fake backend and a fake streaming model, and the real
page in headless WebKit at 390 px. 187 checks: parser 19, run engine 60 (also in the image's folder
layout), phase 0 page 50, runs from the page 58 (hidden page, discarded tab, attach on reload, Stop,
proxy restart, gateway errors, two devices, the portrait) including that the run sends **the same
requests as the page**: the card and finishing calls for single (third and first person), group and
scenario cards, and the portrait's prompt-writing call and image request.
**Not tested:** a real model, a real iPhone (a frozen page, a real lock, Safari's own discard), a real
`docker build` of the proxy image, a real push, web search with a Brave key, the PIN lock over a run,
and **a portrait drawn on the local GPU from a run** (only "PC off → hosted fallback" ran; the local
path is the existing `runLocalComfyImage`).

**To try on the iPhone after deploying:** with the setting **off**: start a card, close the app from
the switcher during "example messages", reopen: the card should come back. With it **on**: start a
card and lock the phone straight away for two minutes; unlock: the card and its fields should be
there at once, then the portrait is drawn. Then start one and close the app: a push should arrive,
and the card is in History with its portrait.

**First real runs (2026-11-19, after deploying):** one run through the deployed proxy as Joe, from
inside the container: DeepSeek V4 Pro on nano-gpt, 66 s in all (card 28 s, finishing 8 s, portrait
28 s). The PC was off, so the portrait step fell back from `local/qwen-image-2.1` to `z-image-turbo`
as designed, with the active Look applied. Every field filled, `{{char}}` used, the portrait stored
(303 KB JPEG). It is "Malcolm Dickinson" in History. Streamed calls report no token usage, so the run
file has none. Joe then turned the setting on and made a character from the app: "seemed fine".
**Still untried:** a lock or a closed app mid-run on the phone, a portrait from the local GPU in a run.

**Added and deployed 2026-11-19 (`62e1389`, proxy + frontend; the backend was left running):** after
the rebuild the proxy came up healthy with "2 recent run(s) loaded" (the earlier runs survived the
restart from their files), the image has all 11 shared scripts, and the prompt host inside the
container has the cast and revise code with no page access. Nothing signed-in was tried on the live
site after this second deploy: **cast and the Revise group have not met a real model**.
Joe chose these with: results to
History only (never over a Library card), and "keep what I typed, offer the AI's version".
- **Supporting cast is a step of the new-card run** (between finishing and portrait) when auto-cast is
  ticked. The cast orchestration and its helpers moved from `lorebook-handler.js` to `APIHandler` in
  `api-lorebook.js` (now a shared script, 11 in all); the page delegates. The page adopts the entries
  from the card's `character_book` so later saves keep them.
- **Revise, Remaster, Reduce tokens and Consistency auto-fix** go through one page method,
  `reviseCard()` (`card-runs.js`). With the setting on it is a `kind: "revise"` run: rewrite, then
  for Revise the finishing fields, saved to History as a **new** item with the card's portrait
  (sent with the request). The diff dialog is unchanged: accept saves over the run's copy, discard
  deletes it. A tab closed mid-revision reloads onto the revised card. Stop revision reaches the server.
- **Keep-my-edits, in both modes:** a field typed in while a rewrite runs keeps what was typed; the
  AI's whole version stays in History (`_keepEditsMadeMeanwhile`). Before, accepting overwrote it.
- Tests now 229: parser 19, engine 79, phase 0 page 50, runs page 81. Reduce tokens shares the path
  but its candidate dialog was not driven.

**Portrait follow-ups: "landing" (2026-11-19) — deployed 2026-11-19 (`223472e`, proxy + frontend).**
After the rebuild: both healthy, the running proxy has the landing code, `/api/jobs/land` and
`/api/jobs/collected` answer 401 with `X-Session-Expired` without a token (directly and through
nginx), and the site serves the new script versions. No signed-in request was made, so **landing has
not met a real image provider, the local GPU or a phone**.
Joe chose "History copies": a picture drawn while the page is gone is saved as a History copy of the
card with that picture as its portrait. Built without touching the image screens, and **for everyone,
not behind the setting**, because the proxy already holds every image job:
- Character Gen's image requests carry the card they are for (`__landing: { card, replaceHistoryId? }`,
  added in `api.js` `makeRequest` from `app._imageLanding()`, Character Gen view only; never for an
  edit of the reference image). The proxy strips it before the provider sees it.
- A finished image job that has a card and has not been **collected** 10 minutes after it was drawn
  (`JOB_LAND_AFTER_MS`) is saved to History (`landImageJob` in `server.js`). Covers Regenerate, Gen 4,
  Compare, takes, Edit portrait, the gallery generator and a page-drawn new-card portrait (which names
  its draft, so the draft is completed rather than duplicated).
- **Collected is something the page says**: `POST /api/jobs/collected` when the picture arrives, or
  the existing `/api/jobs/:id/result`. The proxy never assumes it from having written a response, since
  a locked phone's dead connection can look open. A lost confirmation means the picture is saved as
  well as shown.
- **On load**, image jobs this browser left uncollected more than 2 minutes ago are landed at once
  (`POST /api/jobs/land`) and the page says "N pictures drawn while the app was closed are in
  History", unless another tab of the browser is open (`CardgenPages`, a BroadcastChannel roll-call).
- **Limits:** jobs live in the proxy's memory, so a proxy restart loses pictures that had not landed
  yet. Gen 4 with the app closed leaves four History items. A landed edit is not checked for the
  "blank image" safety result (that check needs a canvas). The chain "write prompt, then draw" inside
  Gen 4 and Compare still needs the page between the two; only the drawn picture is protected.
- Tests: `landing.test.js`, 32 checks (261 in all). The local ComfyUI handler has the same hook but
  only the hosted route was exercised.

Single-field Redo was not chosen and is unchanged (resumable, lost on a closed app).

## 🔒 App lock PIN (2026-11-16) — deployed 2026-11-16 (`f75c959`, proxy + frontend)

Joe asked whether the Home Screen app could ask for Face ID on opening. It can (WebAuthn), but iOS always
offers the phone passcode instead, so it keeps out nobody who knows that passcode. Built instead: a separate
PIN, asked for per device. 🔒 in the header (next to 🔔) opens the sheet.

- **A privacy screen, nothing more.** `src/scripts/app-lock.js` puts an opaque layer over the app; the
  session token works without the PIN and no other route checks it. The app boots and keeps running
  underneath, so streams, resume loops and job collection carry on behind it. Locking never pauses, aborts
  or reloads anything.
- **PIN per account, lock per device.** The PIN (4–8 digits) is a bcrypt hash in `users.json` (`pinHash`,
  `pinLength`, `pinFails`, `pinLockedUntil`). Whether a device asks is in its localStorage
  (`cardgen.appLock.v1`: `on`, `user`, `after`, `len`), so the phone can lock while the PC doesn't.
  iPhone Safari and the Home Screen app have separate storage: turn it on in each.
- **When it asks:** every cold start, and on coming back after longer than the device's "ask after" time
  (every time / 1 / 5 (default) / 15 / 60 min). Measured from the clock at hide and show, no timers.
- **Nothing is drawn on the way out** (changed and deployed 2026-11-16, `edbce61`, frontend only), except with "every
  time", where the PIN screen goes up as the page is hidden. The first version put a blank cover up on
  every hide. On Joe's iPad that gave a black screen on the first return and a lone padlock for a second
  or two on the next: iOS freezes the page on the frame it left with and takes that long to wake it.
  **Cost:** with a time limit, the app switcher's thumbnail shows the app, and coming back late shows the
  last screen for that second or two before the PIN screen. "Every time" has neither gap.
- **Keypad of buttons, no text field**, so iOS never offers to save or fill the PIN. Physical keys work too.
- **Proxy routes** (`server.js`, after change-password): `GET /api/auth/pin`, `POST /api/auth/pin/verify`,
  `PUT /api/auth/pin`, `POST /api/auth/pin/remove`. Wrong guesses are counted per account (not per IP)
  and kept in the file: 5 free, then 30 s doubling to an hour between tries. Changing or removing needs
  the PIN or the account password. None of them answers 401 for a wrong PIN or password (`authFetch`
  would sign the user out).
- **Ways past it, by design:** "Forgot it? Sign out" on the lock screen, then signing in with the password,
  counts as unlocking; the sheet's "Forgot the PIN?" removes it with the password. So if the account
  password is saved in the phone's Passwords app, anyone with the phone passcode can still get in.
- **Notification links** (`?open=`) wait for the PIN (`cardgenLock.whenUnlocked()` in `pwa.js`).
- **Requests:** each PIN check is cut off after 12 s and a network failure is retried once, so a dead
  connection after a wake doesn't mean typing the PIN again.
- **Tested:** 41 checks of the routes against a scratch copy of the real `server.js` (hashing, the wait
  schedule, a restart keeping the count, 10 guesses at once → 5 looked at, never a 401). 323 WebKit checks
  at 390 light / 320 dark / 430 dark / 1280 desktop / 667×375 and 568×320 landscape, real page + real
  proxy routes + fake everything else: cold start locked before the session is confirmed, the app starting
  underneath, a stream that keeps arriving and finishes behind the lock, hidden and back in time with
  the lock screen never drawn, "every time" locking as the page hides, back late, clock moved backwards, 5 wrong → countdown that is right after 20 s "asleep", dropped and
  silent connections, a second device with its own setting, PIN changed or removed on another device,
  session ending while locked, focus and keys kept out of the app, layout.
  **Not tested:** the no-cover change on a real device (headless WebKit can't freeze a page as iOS does),
  whether the photo picker or share sheet count as "leaving" with "every time", the deployed proxy, a real generation
  behind the lock (only a test stream).
- **After deploying:** proxy and frontend rebuilt and healthy; `GET /api/auth/pin` with no token answered
  401 with `X-Session-Expired` from inside the proxy container. Nothing signed-in was tried on the live site.
- **To try on the iPhone:** 🔒 → Set a PIN; swipe to another app for a few seconds and back (no PIN);
  "Lock now"; close the app and reopen; start a card, lock the phone past the limit, unlock and enter the
  PIN: the card should be there. Then remove the account password from the Passwords app if it is saved.

## Adventure: beats pick up from the last line (2026-11-13) — deployed 2026-11-19 (backend rebuilt with the Character Gen work; `_last_moment` confirmed in the running container)

Joe saw a beat open "Megan didn't answer right away…" when Megan had just asked *Joe* a question
("Rain-Slicked Compliance", beats 18–20: beat 18 had opened with the same words, and the [Variety] note
listing it was ignored). `routers/adventure.py`: the plan's first step now covers how the last beat ended
and what it left hanging; a rule says a question or words aimed at someone are answered, dodged or cut off
first, never skipped; a rule bans stalling openings ("X didn't answer right away", "Silence stretched");
choices must follow on from the final line; and a per-beat **[Pick up from]** note quotes the last beat's
final paragraph (trimmed to ~400 chars at a sentence, `_last_moment`). 3 new tests, 102 backend tests pass.
**Replayed on DeepSeek V4 Pro** (Joe's model; built from the real session up to the pick, nothing saved):
2 runs with the new prompt, 1 with the old. All three opened with Megan stepping closer and Joe
answering; none stalled. The old prompt didn't reproduce the fault either, so 3 runs can't prove it's
fixed. In both new runs Megan's own "Why?" was folded into the new question rather than answered first.

## Saved prompts keep their reference image (2026-11-13) — deployed 2026-11-13 (`a3a4ad1`, frontend)

Creating a character from a picture often warned "Omitted large reference-image snapshot": the saved
prompt drops any embedded image over 400,000 characters (~290 KB). `savePromptToLibrary` now first
redraws a too-big image as a JPEG (≤1024 px, quality stepped down until it fits:
`shrinkImageDataUrlToFit` in `library-handler.js`), white behind transparency. The full-size image stays
in memory for the generation itself. The cap is unchanged (`PROMPT_MAX_EMBEDDED_CHARS`), because
**every save downloads every saved prompt** (`listPrompts()` to find a duplicate by fingerprint):
on 2026-11-13 that was 414 prompts, 213 with images, **41 MB per card generated**. Worth a lighter
route (server-side fingerprint lookup) some time. Tested in WebKit (9 checks: a 2400×3000 PNG stored
as a ≤400k-char JPEG with no warning, small image untouched, transparency → white, undecodable image
still dropped with the old warning). Not tried on the iPhone.

**Storage on OCI (2026-11-13):** ~1.3 GB in all: card images 969 MB (`proxy/data/users/<id>/card-images`:
portraits `<id>.img`, every earlier version `<id>_h<n>.img`, gallery `<id>_gallery_<row>.img`), Playground
images 129 MB, Postgres 72 MB (saved_prompts 43 MB). Every portrait, version and gallery file belongs to a
live card. Orphans: 678 history-item files (`h_…`, 107 MB) whose items are gone from `history_items`, nearly
all from May–June 2026 (the history.json → DB move, 13 June). Legacy `proxy/data/cards.json` (74 cards, never
read) and `users/<id>/cards.json` (76 cards, read only by the manual `POST /api/storage/migrate-cards`), 52 MB.
**Deleted 2026-11-13 at Joe's request:** the 678 orphaned history files (106 MB, list re-checked just before;
every live file re-verified after) and both `cards.json` files (the migrate route now just reports none).
`proxy/data` went from 1.2 GB to 1.0 GB.

## 🖼️ MiniMax H3-Image (`local/minimax-h3-image`) (2026-11-13) — deployed 2026-11-13 (`8103b4b`, proxy + frontend)

MiniMax's open-weight image model (released 2026-11-10): one 33B checkpoint that generates and edits
from 1–16 pictures, distilled to 6 steps without CFG. **Licence:** the MiniMax H3-Image Community
Licence excludes the UK (and EU, US, Korea) and §V.4 forbids use outside its territory. That's why
P-H3-Image was skipped on 2026-11-06; **Joe chose to install and run it anyway (2026-11-13).** Offering it to
other users would also need MiniMax's written permission (its "Hosted Service" clause).

- **Files on the PC** (from `Comfy-Org/MiniMax-H3-Image`, SHA-256 checked): `minimax_h3_image_pruned_int8_convrot`
  (21 GB, `diffusion_models`) and `minimax_h3_image_vae_fp16` (1.2 GB). The text encoder is the H3 video
  model's `qwen3vl_32b_minimax_h3_nvfp4_awq` (already there; the template's int8 is 27 GB). ComfyUI 0.45.0
  has the core `MiniMaxH3ImageConditioning` node. Not downloaded: the template's local prompt expander
  (`qwen3.5_9b_w4a8_gptq`), the bf16 (40 GB) and w4a8 (12.5 GB, untried on a 40-series card) DiTs.
- **Graph** (`buildMinimaxH3ImageGraph`): from Comfy's `image_minimax_h3_image_t2i`/`_edit` templates minus
  the expander branch: euler/simple, 6 steps, CFG 1, zeroed negative; the conditioning node returns the
  latent too. Edits: references resized to ~1 MP (`H3_IMAGE.editMegapixels`), width/height 0, so the result
  takes picture 1's shape; the node itself scales the short edge up to at least 1024. "image 2" /
  `<image_2>` in a prompt becomes `<Picture 2>` (`nameReferencesAs(…, "picture")`). Combine up to 4.
- **Captions:** like Klein, every H3 edit and combine goes through `writeEditCaption` first, with MiniMax's
  own expander prompt (`src/scripts/h3-edit-caption-prompt.js`, verbatim from the template: each picture
  labelled `<Picture N>` with its aspect ratio, the instruction as a JSON string, JSON reply whose
  `expanded_caption` is sent; `parseH3EditCaption`). ~38 KB of instructions, so ~10k input tokens per
  caption. A refusal or failure sends the instruction as typed, as for Klein.
- **Why captions:** with one-line instructions H3 made characters generic: it dropped a cat-girl's cat ears
  and the anime girl's ponytail and framing. With a hand-written caption in MiniMax's format, both came
  back exactly. **The real vision model (Gemini 3.5 Flash) has not written one yet**: untested whether it
  follows the 38 KB prompt, keeps to the JSON, or refuses NSFW pictures.
- **Tested on the PC** through the real builder (harness sliced it out of `server.js`), same seeds and
  pictures as Klein, one-line instructions:
  - Night rain on a photo: **H3 better** (stronger likeness, detail). Coat from picture 2 onto picture 1:
    both right, H3 copied the coat more exactly. Two women at a café: both right, H3 more natural.
  - "Redraw picture 1 in picture 2's anime style": **both failed** (Klein returned picture 2; H3 drew the
    anime girl in picture 1's jacket). Uncaptioned; untried with a caption.
  - Text-to-image: an elf ranger with a lettered sign, very good at 1 and 2 MP.
  - **Speed (16 GB, warm):** generate ~14 s at 1–2 MP; edits 19–25 s; 2-picture combines 24–56 s; first
    run after a model swap ~80 s. Klein does the same edits in 3–6 s. The 21 GB DiT doesn't fit in VRAM.
- **After deploying:** the deployed builder ran from inside the proxy container through the gateway to the
  PC: generate 16.5 s, a captioned single edit 20.3 s (cat ears, fur and tail kept), a 2-picture coat
  combine 24.3 s (right coat, right woman).
- **Not tested:** the browser or the iPhone, the caption with the real vision model, NSFW,
  Messenger photos (still on Qwen Lightning), Reimagine (goes the "reference" route, as an edit), 3–4
  picture combines, edits above ~1 MP (the template uses 4 MP; MiniMax says it is best at 4–20 MP).
- **To finish (Joe):** Settings → Image API → Fetch models, add `local/minimax-h3-image`, tick
  "Natural-language prompts". ✨ Edit and 🔀 Combine come ticked from the proxy.

## 🔔 "It's done" notifications, Stage 3 (2026-11-10) — deployed 2026-11-10 (`94886f3`, frontend + storywriterbackend + proxy)

`plans/ios-app.md` Stage 3. Joe tried Stages 1–2 on the iPhone first: "all looks good so far".

- **When:** a push goes to all your devices when something you started finishes **while the page that
  started it is hidden** (locked, another app, another tab). Each page load has a random id
  (`window.cardgenPage` in `auth.js`, sent as `X-Page-Id` + `X-Page-View` by `authFetch` and
  `api.js`) and reports hidden/shown to `POST /api/sw/push/presence` (`Presence` in `pwa.js`, keepalive
  fetch on visibilitychange/pagehide/pageshow). Presence is in the backend's memory
  (`services/push.py`); a restart forgets it until each page next hides. A page that never reported
  falls back on "nobody was reading the result" (proxy jobs only). Stop never pushes.
- **What:** Roleplay Chat replies (`chat.py`), Messenger replies (`messenger.py`), Adventure beats
  (`adventure.py`), Story Writer parts (`generation.py`), auto-written stories finished or failed
  (`story_autowriter._notify`, pushed unless the page polled in the last 20 s), and proxy jobs
  (cards, lorebooks, pictures, anything resumable). The proxy reports a page's jobs **once, when the
  last one finishes** (`onJobFinished`/`sendJobPush` in `server.js`) to
  `POST /api/push/internal/jobs-done`. The browser can't reach that route: the `/api/sw/*` forwarder
  404s it and the backend also wants `X-Proxy-Job: 1`, which the forwarder never sends. Failures
  push too ("Character image failed: Local GPU is offline."). Tags per chat/story/adventure/view,
  so a new push replaces the old one. The main card call now has `__jobLabel: "Character card"`.
- **Settings** (🔔 sheet, per user, table `push_prefs`): on/off for six kinds; lock screen shows a
  preview / name only (default) / nothing.
- **Keeping results:** a proxy job that finished with nobody reading it, or that pushed, is kept
  24 h instead of 10 min (`JOB_KEPT_RETENTION_MS`, capped at 128 MB in all, oldest dropped first).
  `ResumableJobs.MAX_AGE_MS` is 24 h to match; the update bar ignores entries over 30 min old.
  **Only a page still alive in the background can collect a card or picture.** If iOS closed the
  app, the result is lost (no recovery UI). Backend items are in Postgres, so they are always there.
- **Tested:** 14 backend tests in `tests/test_push_done.py` (99 in all): presence rules, Messenger
  hidden/visible/no-id/failed, Roleplay reply, Adventure beat, auto story polling, privacy, prefs,
  the jobs-done route. The real `server.js` against a fake model and backend (17 checks):
  attached/detached reports, a dropped reader's result kept past retention and collected whole,
  3 pictures → one report, no page id → nothing, Stop → nothing, the internal route blocked
  (incl. `%69nternal`, `//internal`). WebKit 38 checks at 320/390/430 px light/dark (headers on
  backend and card requests, presence on hide/show/pagehide, nothing when signed out, prefs
  load/save/failure revert, layout), plus the Stage 1–2 suite again (102) and `sw.js` (9).
  **Not tested:** a real lock on the iPhone (does the hidden report get out before iOS freezes the
  page?), real pushes through Apple, Story Writer parts end to end (no test harness for
  `generation.py`).
- **After deploying:** backend and proxy started cleanly; `push_prefs` created; through the live
  proxy as Joe: `/push/prefs` gave the defaults, `/push/presence` 200, `/push/internal/jobs-done` 404.
- **To try on the iPhone:** start a Messenger reply and lock straight away; a card in Character Gen,
  then switch to another app; an auto-written story, close nothing, lock. Then open the app and
  generate while watching: there should be no push.

## 📱 Home Screen app + push notifications, Stages 1–2 (2026-11-09) — deployed 2026-11-09 (`42f2fbb`, frontend + storywriterbackend)

`plans/ios-app.md` has the five stages; Stages 1 and 2 are built. Stage 3 ("it's done" pushes) is next.

- **Install (Stage 1):** `manifest.webmanifest`, `icons/` (the mug on cream; iOS turns transparency
  black), `apple-*` metas, `theme-color` following the theme toggle, black-translucent status bar. An
  inline script in `<head>` adds `html.pwa` when running from the Home Screen (or when localStorage
  `cardgen.pwaTest` is `1`, for tests); all the new top padding is under `html.pwa`, so Safari and the PC
  don't change. A strip under the status bar (`body::before`, z 35) hides content scrolling under the
  clock. Bars that already padded for the inset (chat shells, readers, sheets) were left alone.
  **"Update ready" bar:** the image writes `version.json` at build; `pwa.js` checks it on wake and every
  30 min, and won't reload while a wake lock or resumable job is live.
- **Push (Stage 2):** `sw.js` has **no fetch handler** (push, notificationclick, pushsubscriptionchange
  only). Backend `routers/push.py` (`/api/sw/push/key|devices|subscribe|unsubscribe|test`) and
  `services/push.py` (`notify_user()` for Stage 3), tables `push_subscriptions` and `app_secrets`. The
  **VAPID key is made on first use and kept in `app_secrets`**: no `.env` change; deleting that row
  orphans every device. Payload in Apple's declarative format. Endpoints must be a real push service
  (Apple/Google/Mozilla/Microsoft), so Send a test can't be aimed at an internal host. New dependency
  **`pywebpush==2.5.0`**. 🔔 in the header opens the sheet: turn on/off, Send a test, the device list.
- **Links:** `?open=<home|cardgen|storywriter|roleplay|adventure|messenger|playground>` and
  `&id=` for roleplay/messenger/story/adventure items (through `homeHandler.openRecent`). Waits for
  login; removed from the URL; a tap while the app is open arrives as a message and opens in place.
- **Not done from the plan:** the internal route for the proxy to request pushes (Stage 3 needs it).
- **Tested:** 8 backend tests (85 in all), with real encryption decrypted by a fake device; 102 WebKit
  checks at 320/390/430 px light and dark and 1280 px against a fake backend, with a 47 px status bar
  stood in (gating, padding, no sideways scroll, update bar, links incl. signed out, the sheet's flows
  with a faked PushManager: permission asked before any request, stale key replaced, refusal, XSS in a
  device name); 9 Node checks of `sw.js`; the built frontend image's headers. **Not tested:** a real
  iPhone, a real push through Apple, whether Safari shows a declarative push twice (it shouldn't), real
  push on desktop Chrome/Edge.
- **After deploying:** manifest, sw.js, version.json and icons served with the right types; `/api/push/key` and
  `/devices` answered inside the backend container. `main` was fast-forwarded to `ChatTest` the same day.
  **To try on the iPhone:** Safari → Share → Add to Home
  Screen, open it, sign in again (separate storage from Safari), 🔔 → Turn on → Send a test.

## 🏠 Home: Recent activity (2026-11-09) — deployed (`d03df0c`)

The "SillyTavern Character Generator" title and its four page buttons are gone from Home (the tabs above
already link to every page). "Recent Roleplay Chats" is now **🕘 Recent activity**: the four latest things
from Roleplay Chat, Messenger, Story Writer and Adventure, newest first, all as one tile (`.hr-*` in
`main.css`, `loadRecent`/`renderRecent` in `home-handler.js`): portraits split across the cast (or the mode's
icon), a mode badge, 🗑️, title, cast, how long ago, Continue. Two a row on a phone like the character cards
(one a row at 320 px, as they are). Tapping opens it in its own tab; deleting one that is open there closes it.
`GET /chats/` now returns `last_at` (newest message, else updated_at), because a new roleplay message doesn't
touch `updated_at` ("Wěn Mèilíng" read September with a message on 3 Nov). The roleplay lobby's own order is
unchanged (still updated_at). Tested: 77 backend tests, 34 WebKit checks at 390 light / 320 dark / 1280 dark
(order across modes, stale item left out, cast fetched, escaping, same parts and height, columns, delete route,
Messenger tile opens the chat). **Confirmed by Joe on the iPhone and PC 2026-11-09**: layout good, Messenger and Story tiles open the right item; Roleplay and Adventure tiles and delete not yet tried.

## 💌 Messenger photos (2026-11-09) — deployed 2026-11-09 (`8e64355`, frontend + storywriterbackend)

`plans/messenger-photos.md` has the design and the test results. Texting and chat-room styles only.

- **Characters send photos:** the chat model writes `<photo>third-person caption</photo>` when asked,
  and now and then on its own (per chat: 📷 Never / Only when I ask / Sometimes (default) / Often).
  The backend lifts each into `chat_photos` (pending) and leaves `<photo id="…"/>` in the message; the
  model sees `[Mira sent a photo: …]`. The **browser draws it as an edit of the card portrait**:
  "Make a new picture of this same character: <caption> Keep the character's face, hair and the art
  style of the picture exactly the same." on `local/qwen-image-2.1-lightning`, and on
  `qwen-edit-uncensored` (nano-gpt, $0.04) when the PC is off. Both can be changed in Chat settings →
  More (global). No portrait or no edit model: the caption shows as a words card.
- **Why a plain edit:** tested on 3 of Joe's cards × 5 photos (PC, 60 pictures). The edit kept face,
  tattoos and the anime/cartoon style while changing place, outfit and pose; Reimagine kept the
  portrait's background and outfit. NSFW drawn as asked on both models. Hosted (9 paid calls) kept
  style but weaker likeness and slimmer figures. Edits come out at the portrait's shape.
- **You send photos:** ＋ → 📷 Photo (shrunk to ≤1600 px JPEG on the phone; the vision model writes the
  caption the character goes by, editable; if it refuses you write one) or 📝 Describe a photo (words
  only, free). Tap a photo for the lightbox (swipe through the chat's photos); 🎨 Redraw in the actions.
- **iPhone:** never draws while hidden; drawn once on wake. Each draw's job ref is kept in localStorage
  by photo id (`cardgen.messenger.photoJobs`), so a tab discarded mid-draw collects the result on reopen
  instead of paying again; a job that can't be found asks "Draw it again" rather than paying silently.
  `editImage` takes a `clientRef` for this (and `makeRequest` honours one).
- **Tested:** 9 backend tests (74 in all); 68 WebKit checks at 390 light / 320 dark against a fake
  backend (draw once, PC off → fallback, hidden then wake, tab discarded mid-draw, lost job, failure +
  Try again, no portrait, XSS in a caption, your photo + vision caption, described photo, settings,
  lightbox, Redraw), plus a dark-mode look. **Not tested:** a real chat model sending `<photo>` (does
  it use it when asked, and not too often?), the vision caption on a real photo, the whole thing
  through the deployed proxy, the iPhone.
- **Deploy needs** frontend + storywriterbackend rebuilds (new `chat_photos` table is created on start).
- **Not built:** photos in group chat rooms show only the sender's portrait (Qwen takes up to 3);
  re-cropping square portraits to a phone shape; the Roleplay-Chat-style summary still sees raw markers.
- **Fixed 2026-11-09 (`1a54a58`, deployed):** a sent text could show above the reply before it, because
  `RoleplayChat.messages` had no order and Postgres returns an updated row last; it now orders by
  `created_at` (Roleplay Chat lists too) and Messenger also sorts on load. Typed emoticons (`:)` `;)` `:D`
  `<3` `:(` `:P` `XD` …, `EMOTICONS` in `messenger-handler.js`) show as emoji in bubbles and the lobby
  preview when they stand alone; the text sent and stored is unchanged.
- **Photos too like the portrait (2026-11-09):** Rhonda's portrait is already in bed in lingerie and the
  captions asked for that, so the edit, drawn in the portrait's own frame, barely changed it. Local photos now draw
  in a phone frame unlike the portrait's (3:4, or 9:16 if the portrait is already tall) via a new `reframe` flag on
  local Qwen edits (proxy), and the caption rule asks for the shot first and a new framing/angle/pose each time.
  Tested on the PC (contact sheets; see `plans/messenger-photos.md`), 75 backend tests, 72 WebKit checks.
- **A photo sent as words, and extra arms (2026-11-09):** the model copied the history's "[Rhonda sent a photo: …]"
  form instead of <photo>; its own photos now show in history as <photo>…</photo> and the bracket form is lifted too.
  Extra arms came from a selfie caption giving the free hand a job while the portrait's hand pose was kept; the rule
  now allows the free hand one thing. 25-step Qwen drew the same pictures 2.5x slower, so Lightning stays. 76 tests.## 💌 Messenger (2026-11-08) — deployed 2026-11-08 night (`90da154`, `69091c4`)

Built overnight from `plans/chat-bot-messenger.md` (Joe asked for it to be built and deployed unattended).
A new tab where you text your characters: dialogue only, no narration.

- **Backend (`90da154`):** chats live in Roleplay Chat's tables with `roleplay_chats.mode = 'messenger'`
  (+ `messenger` JSON settings, `chat_messages.reaction`). `GET /chats/` now returns roleplay chats only
  unless `?mode=messenger`, so the two lobbies stay apart (all 51 existing chats are 'roleplay').
  `routers/messenger.py` has its own send path (send / opener / checkin / regen / retry), list, settings,
  read, tapback, impersonate; replies run in Chat's `_ACTIVE_GENERATIONS`, so Chat's cancel route stops
  them. Prompt in `services/messenger_prompt.py`: per style, cards adapted, `{{char}}`/`{{user}}` filled,
  relationship presets, time awareness, short private checklist for native reasoners (effort medium).
  Replies are cleaned server-side: `*action*`-only lines dropped, a leading `<react>` becomes a tapback.
  Memory prompt about you and the relationship, every 8 messages.
- **Front end (`69091c4`):** 💌 Messenger tab and Home 💌 Text button. Texting bubbles with receipts,
  a Discord-style chat room, a spoken transcript. Typing dots, bubbles appear as paragraphs finish,
  double-texting with blank lines, tap for React / Redo / Edit / Copy / Delete, long-press for tapbacks,
  ＋ for a note to the AI and ✨ Write my next text, ⋯ for text size, cards, chat settings, delete.
  Fixed shell on the visual viewport like Roleplay Chat; check-ins only when you open the chat.
- **Deviation from the plan:** decision 3 said move Roleplay Chat's resilience code into a shared
  `chat-core.js`. `chat-core.js` exists and Messenger uses it, but **Roleplay Chat was not moved onto it**:
  its 41-check WebKit suite isn't on this PC, and changing that code without it overnight was the wrong
  risk. Do it with that suite to hand.
- **Tested:** 15 backend tests (66 in all); 145 WebKit checks at 320/390/430 px light+dark and 1280 px
  (keyboard stand-in, wake mid-reply, dropped socket recovered by id with no second request, Stop,
  error + Try again, groups, check-in, opener, XSS). **Real model** (DeepSeek V4 Pro, 4 calls, nothing
  saved): texting gave two short texts, no narration (5 s); a 2-card chat room had both reply with
  names, @mentions and talk to each other (24 s); conversation gave one spoken turn (6 s). The same run
  checked Adventure: a 321-word beat ending on tension with four tagged choices of different kinds (37 s).
  **Not tested:** a real iPhone or lock, the 45 s stall itself (needs a 45 s test), push notifications
  (not built: a Home Screen web app could get real iOS push; ask if wanted).
- **Fixed 2026-11-09 (first iPhone try):** the card gallery opened *behind* the New conversation
  sheet (both z-index 2000, the sheet later in the DOM). Messenger sheets are now 1990, as Story
  Writer's setup sheet. Deployed (`37af943`, frontend only). Checked in headless WebKit (390 light / 320 dark); not yet re-tried on the iPhone.
- **Try on the iPhone:** start a chat from a Home card's 💌 Text; keyboard open/close; lock mid-reply;
  long-press a bubble; a 2-card chat room; turn on Check in and come back the next day.

## Adventure overhaul (2026-11-08) — deployed 2026-11-08 night (`6745e0e`..`f5af2a8`)

Adventure mode rebuilt in four phases, overnight while Joe was away (he asked for all four, then deploy).
Only two old adventures existed (June); they still open, and get an auto title on their next beat.

- **Phase 1, under the hood (`6745e0e`):** Stop cancels the beat on the server; SSE keep-alive pings
  (shared with Chat via `services/gen_stream.py`); errors no longer stored as story text; an empty
  placeholder orphaned by a backend restart is dropped instead of "writing" for ever; choices parse from
  `[OPTION n]`, `**[Option n]:**`, `OPTION n:` or an `<options>` block, and a short follow-up call asks
  for them when they're missing; new beats use `max(order_index)+1`; title saves (PATCH) and is set
  automatically after the first beat; the list sends names only; `{{char}}`/`{{user}}` filled in.
  Context falls back to 8192 when a user never saved Adventure settings (it used to be 2048).
- **Phase 2, iPhone reader (`cb8f2e1`):** like Story Writer's reader: sticky top bar (back, title,
  Aa shared with Story Writer, ⋯), one column, and a tray at the bottom with four big choice cards
  (Safe/Risky tags), ✍️ Your own…, 🎲 New options, ▶ Continue when a beat came without choices, and
  "writing…" + timer + Stop while a beat streams. Picks show as chips (tap: the options not taken).
  Tap a beat: Read aloud (Story Writer's TTS settings), Edit (full-screen sheet), Picture (stored per
  beat, fetched separately), Rewind; the latest beat has Redo and Undo. Watchdog 45 s ignoring time
  asleep; waking never aborts a live beat; a dropped beat is fetched by id. New adventure is a
  full-screen sheet with ✨ Inspire me (three openings).
- **Phase 3, the story (`d59fd1e`):** new narrator prompt that plans the beat *and* the choices (four
  different kinds, specific, under 15 words, never repeated, tagged safe/risky), keeps the cast in play
  without forcing everyone into every beat. Play styles Director (3rd person) and Protagonist (2nd
  person, you play a persona; saved personas fill it). Beat length, Chat's writing styles, variety
  nudges, Redo asks for a different take. 🎲 Dice (d20 on risky picks, honoured by the narrator,
  badge on the pick) and an optional ending arc (~8/15/25 beats). ⋯ → 🎛️ This adventure edits it all.
- **Phase 4, journal (`f5af2a8`):** goals / threads / items / people / places, updated every 3 beats,
  fed back to the narrator; ⋯ → 📜 Journal to read, edit or Update now.
- **Tested:** 51 backend tests (`tests/test_adventure.py`, fake model); 118 WebKit checks at 320/390 px
  light/dark against a fake streaming backend (stream, Stop, error + Try again, dropped connection
  recovered, wake mid-stream, Undo/Rewind, edit, Aa, rename, picture, XSS, pending beat on open, new
  sheet, play settings, dice badge, journal); Story Writer's 98 + 18 checks unchanged.
  **Not tested:** a real model (does GLM keep to the `<options>` block and 15 words?), a real iPhone,
  a real lock.
- **Try on the iPhone:** a new Protagonist adventure with dice on; lock mid-beat and come back; Your
  own… with the keyboard open; Rewind from an early beat; a picture; the Journal after 3+ beats.

## Story list portraits (2026-11-08) — deployed (`bf61268`)

Each story card in Story Writer's list has a portrait strip on top, split between its characters
like the chat lobby's (`_buildStoryCover` in `storywriter.js`, `.sw-story-cover*` in `main.css`),
plus a line naming them. The initial shows until a portrait loads and stays if the card has none;
over four characters the last slot reads "+N"; a story with no cards shows 📖.
`GET /api/sw/stories/` now returns `characters: [{id, name}]` per story (`StoryListOut`, the
`Story.characters` property; cards loaded with `selectinload`, so no query per story). Portraits
come from `/api/storage/cards/thumbnail`, same as the chat lobby.
**Deploying needs a storywriterbackend rebuild** (not just the frontend), which interrupts
any running auto-write (Resume picks it up) and in-flight chat/story replies.
Tested: 2 new backend tests (17 pass; run them with `--python 3.12`, as Pillow 11.0 won't
install on 3.14), 18 headless WebKit checks at 390 light / 320 dark, the 98 reader checks again.

## Story Writer reader overhaul (2026-11-08) — deployed (`787dc0d`)

An open story is now a full-screen reader, iPhone first. New `src/scripts/story-reader.js`; the
"Story Writer reader" block at the end of `main.css`; workspace markup in `index.html`.

- **Layout:** `#sw-workspace-view.sw-reader-open` hides the app header, tabs, footer and the
  settings panel (a `body:has(#view-storywriter:not([style*="none"]) …)` rule, so any code that
  switches views releases the page). Sticky top bar: ‹ back, title (tap → Story details), **Aa**,
  **⋯**. Sticky bottom bar: narration mini-player, then steer box + **Continue** (was "Generate
  Next"); Return in the steer box generates; while generating the steer box steps aside for
  Generating… + Stop. The document still scrolls normally (no fixed shell as in the chat).
- **Aa:** text size 85–170% in 9 steps, Sans/Serif (Iowan Old Style → Palatino → Georgia, all
  system fonts), Compact/Normal/Roomy spacing. Per device in localStorage
  (`cardgen.storyReader.v1`), applied as `--sw-text-scale/-leading/-font` on `:root`; the edit
  sheet and streaming text use them too. The passage at the top of the screen stays put on change.
- **⋯:** Story details (sheet: title, characters + voices, synopsis, script mode, all the old
  header controls with their ids), Contents (tap a part to jump), Character cards, Outline (auto
  stories), Story Writer settings (borrows `#sw-settings-panel` into a sheet and puts it back).
- **Passages:** actions hidden until you tap the text (the latest always shows them); a tapped row
  sticks just above the bottom bar. Play / Edit / Picture, Delete set apart at the far end. Edit is
  a full-screen sheet (Cancel / Save in the header, asks before discarding changes).
- **Auto stories:** the run panel docks into the bottom bar while writing (Stop + note in reach),
  back above the story when idle.
- **Story list** above the settings: title, synopsis, ✨ Auto-written pill, date, bigger delete.
- **Fixed on the way:** `--bg-tertiary` is undefined, so the old passage action bar was near-black
  in light mode. The Gallery button reused the first render's card list, so it kept offering
  cards already attached. The scene-picture prompt and card names were put into `innerHTML`
  unescaped. A wake refresh no longer overwrites the title/synopsis while you're typing in them.
- **Tested:** headless WebKit against a fake backend, 98 checks at 390 px light and 320 px dark
  (reader chrome hidden/restored, Aa steps/limits/persistence, tap-to-reveal, edit save/cancel,
  details rename, contents jump, settings borrow/return, one generate request, auto panel
  docking, release when another view takes over), plus a 1280 px desktop look. **Not tried on
  the iPhone.** Try there first: the steer box with the keyboard open (the bottom bar is
  `position: sticky`, not following `visualViewport` like the chat), the edit sheet with the
  keyboard open, and a tapped passage's action row while scrolling.

## Home 📖 Story opens the New story sheet (2026-11-08) — deployed

A home-screen card tile's 📖 Story still drove the old title box + Create button, which the
✨ New story sheet replaced, so it did nothing. It now switches to Story Writer and calls
`autowriter.openSetup({ cards: [{ id, name }] })` with that card picked; the user sets the rest and
presses Write. Tested in headless WebKit at 390/320 px against the fake backend (preselect, picker
hides the picked card, the run starts with that card id). Not yet tried on the iPhone.

## Qwen Combine + 📐 angle buttons (2026-11-06) — deployed 2026-11-08 with the above

From a LoRA survey of every local model (HF likes/downloads, cards read, the best tested on the
PC with and without, same seeds; contact sheets and pixel-drift numbers in that session's temp
folder). The LoRAs mostly lost to plain Qwen-Image 2.1, which is what got built:

- **Combine on both Qwen entries** (`combine: true`, `maxReferences: 3`): `buildQwenImageGraph`
  adds pictures 2–3 as `images.image_2…` (`addLocalComfyReferences`, ~1 MP each, result at
  picture 1's size) and rewrites `<image_N>` to "image N". On Lightning a combine whose instruction
  names clothing (`OUTFIT_INSTRUCTION_RE`) also loads ausboss's Outfit Swap LoRA
  (`qwen-image-2.1-outfit-swap`, 159 MB, in `models\loras`): plain Lightning shifted the picture
  6 px and changed 24% of the face; with it 0 px and 1.6–2.8%. The 25-step model managed
  3.4–5.7% without. Tested through the real builders: coat swap ✓, two people into one shot ✓,
  **"redraw in the style of image 2" ✗** (a photo with a faint painted look; Qwen copies people
  and clothes from a second picture, not art style).
  **To finish (Joe):** on `local/qwen-image-2.1` (and Lightning, if added before this deploy) tick
  🔀 Combine in Settings → Image API: saved ticks override the new default.
- **📐 angle buttons** in Playground Edit (fill the instruction with
  `Show the same person from this camera position: <pose>. Keep everything else the same.`) and
  Reimagine (fill "What should the new picture show?" with a short phrase). `PLAYGROUND_ANGLES` in
  `image-playground.js`. On Lightning: from behind, from below and full body worked on a photo
  and an anime character; close-up on the anime one; from above on the photo; "left" and "right"
  gave the same profile, so there is one Side button; the ¾ button barely moves a source that is
  already near ¾. This contradicts the Reimagine note below that an edit "keeps the old
  composition": with ComfyUI 0.44 a plain Qwen edit does turn the camera.
- **LoRAs tried and not built:** akhaliq's Multiple-Angles v2 (grey studio backgrounds, tiny
  full-body figures; worse than a plain prompt); ausboss's Consistency LoRA (face change 6.5% →
  1.9% on a restyle, but its card says it blocks pose changes); BFS head swap (plain Qwen swaps
  heads convincingly; the LoRA matches the source's light and head turn a little better). All
  four files are in `models\loras`; `qwen21_multiple_angles_v2_1500` can be deleted.
- **Parked:** Krea-2 Identity Edit V2 needs the third-party `comfyui-krea2edit` node pack.
- **Tested:** ComfyUI on the PC via the real builders; the buttons in headless WebKit at 390 px
  light and 320 px dark against the fake server. Not yet in the deployed app or on the iPhone.

## Local GPU: ComfyUI 0.44, Qwen Lightning, Z-Image fp8 (2026-11-06) — deployed

Tested on the PC by running the proxy's real graph builders straight against ComfyUI (harness in
the session's temp folder: builders sliced out of `server.js`, timed from ComfyUI's own execution
stamps). After deploying, one Lightning picture from inside the proxy container through the gateway:
14 s including the model load. Not yet tried from the browser or the iPhone.

- **ComfyUI is master `v0.44.0-23` (`63e5bf59`)**, 69 commits past the last tested `0b05cd8a`. No
  node the app uses was renamed or removed. All 7 local models generated and all 4 edit models
  edited correctly (warm: Qwen 8–20 s, Z-Image 5 s, Krea 5.4 s, MOSS 21.5 s / edit 18.6 s, FIBO
  19.6 s / edit 9.9 s, Klein 7–11 s / edit 7.2 s, Illustrious 5 s).
- **`local/qwen-image-2.1-lightning`** (new): the same int8 Qwen-Image 2.1 plus lightx2v's
  `qwen_image_21_lightning_v2_rl_4steps_lora_rank64` (688 MB, in `J:\…\models\loras`; from
  `lightx2v/Qwen-Image-2.1-Lightning-v2-RL`, which also ships a 28 GB fp32 transformer we don't
  need). 4 steps, CFG 1, the release's own sigmas through `ManualSigmas` +
  `SamplerCustomAdvanced`. Warm: **2–3 s per picture against 8–9 s, edits ~3 s against 14–17 s,
  Reimagine ~3 s against 17 s**; at least as good on 3 prompts (sign text right) and 3 edits (face
  kept). Reimagine splits the 4 sigmas with `SplitSigmas`: references join after step 1 (close) or
  2 (balanced); after 3 the face drifted. A "from the side, walking" reimagine kept the likeness
  but barely moved the pose. Licence: Qwen Research (non-commercial), as for the base.
  **To finish (Joe):** Settings → Image API → Fetch models, add `local/qwen-image-2.1-lightning`,
  tick ✨ Edit and Natural-language prompts. The base entry stays for comparison.
- **VRAM:** nothing measurable beyond the base model (+0.7 GB LoRA). nvidia-smi read 15.1–15.6 GB
  used during every run of every model, because ComfyUI keeps whatever fits cached, so that number is
  the card being full, not what a model needs.
- **Z-Image-Turbo now loads as `fp8_e4m3fn_fast`** (the 0.44 fix, #16941): 3.5–4.5 s against
  4.9–6.5 s warm, 4 s first load against 17 s, pictures near-identical. No other app workflow
  used fp8 weights (the rest are int8_convrot), so this is the only one that gains. A true
  before/after across ComfyUI versions wasn't possible: the update was already installed.
- **P-H3-Image: not installed, licence.** The MiniMax H3 Community Licence's "Applicable Territory"
  excludes the UK (and EU, US, Korea) and §V.4 forbids any use outside it, personal use included.
  It also needs ~21 GB VRAM at 8 MP. The PC already has MiniMax-H3 FL2VA files, so the 2 GB
  P-H3 LoRA route would be cheap if the licence ever changes.

## ✨ Auto-written stories (2026-11-06) — deployed, never run on a real model

Story Writer's "Create Story" (which demanded a title) is now **✨ New story**, a sheet
(`src/scripts/story-autowriter.js`, `.saw-*` styles) with characters (picked through the card
gallery), an optional idea, length (Short 4 / Medium 7 / Long 11 / Epic 18 chapters at
800–1,600 words), ending (AI decides / happy / bittersweet / dark / twist), a 1–5 "how closely to
follow the cards" slider and an optional title. Two buttons: **✨ Write the whole story** and
**✍️ Write it with me** (the old hand-driven mode, now without a title; it is named from its first
chunk by `name_story_task`).

- **Runs on the server** (`storywriterbackend/app/services/story_autowriter.py`,
  routes in `routers/autowrite.py`): one planning call returns the outline as JSON (title, blurb,
  setting, voice, cast arcs, ending, one entry per chapter), retried once if unusable, failing before
  any chapter is paid for. Then one call per chapter, with the cards and whole outline as a fixed
  system prefix, and the chapter's brief, earlier chapters' notes, the end of the previous chapter,
  earlier openings to avoid and any steering notes in the user message. Chapters before the last are
  told not to resolve or wrap up; the last must deliver the planned ending. After each chapter a
  utility call writes its continuity notes into `story_segments.summary`.
- **The slider changes the planner's brief** (`FAITHFULNESS`), not sampling; the top two stops
  also nudge the planner's temperature (`PLANNER_TEMPERATURE`). Chapter calls use the user's own
  temperature. Untested whether neighbouring stops differ enough in practice.
- **Storage:** `stories.plan` (outline JSON, only ever sent by `GET /stories/{id}/outline`),
  `stories.autowrite` (setup choices + run state JSON), `story_segments.chapter`. Every finished
  chapter is an ordinary segment, so the reader, narration, images and editing work unchanged;
  chapters show a "Chapter N" heading.
- **iPhone:** the run is an asyncio task in `_RUNS` (single uvicorn process). The page polls
  `GET /stories/{id}/autowrite?from=<chars>` every 2.5 s while visible, never while hidden, and
  catches up on wake. A backend restart shows "Interrupted" and **Resume** carries on from the next
  unwritten chapter with the same outline (only the half-written chapter is paid twice). **Stop**
  cancels the server task and drops the half chapter. Manual Generate is refused (409) and hidden
  during a run; narration's auto mode is blocked from starting one. New chapters join a running
  narration queue.
- **Tested:** 15 backend tests (`storywriterbackend/tests/`, fake model; run with
  `uv run --with-requirements requirements.txt --with pytest python -m pytest tests -q`), and the real
  page in headless WebKit at 390 px light and 320 px dark against a fake backend (66 checks: sheet
  layout, gallery above the sheet, double tap starts one story, live text, steering, no polling while
  hidden, an outage during unlock, restart → Resume, outline gated and escaped, write-with-me).
  **Not yet run against GLM or on a real iPhone.**
- **To try first:** a Short story with a card you know. Then check: did it end properly, did
  chapters repeat their openings, did the planner soften an adult premise, and does Off the rails
  feel different from Balanced.
- **Not built yet:** "✨ Finish this story" for an existing hand-written story; re-planning when
  chapters drift; using the outline in hand-driven Generate. `context_window` is not applied to
  auto-written prompts (cards + outline + notes for 18 chapters is roughly 10k tokens).

## Output-token ceiling (2026-11-06) — deployed

Every storywriterbackend call (Story Writer, Roleplay Chat, Adventure) now sends
`max_tokens = max(asked, 32768)` (`MAX_OUTPUT_TOKENS` in `llm_service.py`): reasoning models count
their thinking against it, so the old caps (Story Writer 2048, Chat 1024, Adventure 512) cut prose
short. A host that rejects the ceiling (400/422 naming max_tokens) is asked once more without one.
The Max Tokens / Max Output Tokens fields are gone from Story Writer, Chat and Adventure settings.
Story Writer's history budget reserves `min(8192, context_window / 4)` for the reply instead of
max_tokens. Untested whether nano-gpt accepts 32768 for GLM 5.3; if not, the retry covers it.

## Shipped recently, not yet tried for real

All of these were tested only headlessly against fake APIs. No real paid generation or local-GPU
run was made.

| What | Commit | Try this |
|---|---|---|
| Playground Generate **Shape** picker (`api.image.generateAspectRatio`) | `279755b` | Generate a 16:9 and a 3:4 image and check the shape |
| Nano Banana 2.1 fix: tier models get `aspect_ratio` only, no pixels (they 400 on pixels) | `d15f16a`, `6f652c0` | Generate with Nano Banana 2.1 and qwen-image-3-pro |
| Image sizes follow nano-gpt's catalogue (`GET /api/image/catalog`, cached 6 h) | `6f652c0` | flux-2-pro at 4:3 should come back 1536×1024 (it lists no 4:3) |
| Text-stream stall fix: proxy `: ping` every 15 s, client watchdog after 45 s silence | `ef00936` | Nothing to do unless a card stalls again; if it does, check whether it resumed |
| Status badge is free now (`checkTextApiReachable`, GET `/models`, cached 5 min) | `768a86f` | Badge still goes green; Settings → Test Connection still makes a real call |
| ⚔️ Compare Models in Character Gen | `eda75dd` | Never run against the real GPU |
| Combine tab (qwen-image-3-pro, reve/2.1/remix, grok-imagine edit) | — | Never confirmed against a real model |
| 💾 Save to Library shows ⏳ Saving… and can't be pressed twice; a failed save now says so instead of "saved" | `65909f8` (2026-10-31) | Tap Save on a card with a portrait; the button should grey out until the toast |
### How image sizes are sent now (`src/scripts/api-image.js`, `applyImageRatio`)

- **Tier models** (catalogue lists `1k`/`2k` and no sizes — Nano Banana family, qwen-image-3-pro):
  `aspect_ratio` only. Enhance asks for `2k`, or the model's largest tier, or nothing if the model
  only offers `auto`.
- **Fixed-list models** (flux-2-*, z-image-turbo, illustrious): the listed size closest in shape
  (shape weighted 10× over area).
- **Any-size models** (seedream, flux-pro/v1.1), **local models** and **unknown ids**: the old
  pixel sizes from `getRatioDims`.
- If the catalogue can't be fetched, everything falls back to the old behaviour, and Nano Banana is
  still recognised by name.
- Hand-added ids may be aliases: `nano-banana-2.1` is `google/gemini-nano-banana-2.1` in the
  catalogue. `findImageCatalogEntry` matches a unique id ending in the name at a `/` or `-`.

## Playground Generate grid opens the lightbox — `a7fba76`, confirmed on the iPhone 2026-10-23

Tapping a pick-grid tile opens the lightbox (context `playgroundGenerate`) on every landed result
instead of swapping the preview at the top of the page; ✓ Use This makes the one on screen the
working image. Results that land while it is open join it (`_renderPlaygroundGenerateResults`).

## Playground **1 per model** — `bd06db7`, confirmed live 2026-10-23

How many → 1 per model (picks shared with ⚔️ Compare Models, max 4). Joe ran it across Qwen-Image 2.1,
Krea-2 Turbo, MOSS-Image and Z-Image-Turbo on the PC; all four came back and looked good.

## FLUX.3 Klein (`local/flux3-klein`) — deployed 2026-10-26

**After deploying**, a generation sent from inside the proxy container through the gateway to
the PC came back in 3.7 s (Klein) and 13 s (FIBO), and `/api/image/local-models` lists both.
Edits and Combine through the deployed proxy, and anything in the browser, are untried.

BFL's distilled 5.6B Klein: generates, edits, and combines 2–4 pictures (BFL allows 10), one
checkpoint. **The best local model tested so far, and the fastest**: ~6 s to generate at 1 MP,
~8 s per edit, ~12 s for a 2-picture combine (cold loads included). Tested on the PC through a
scratch copy of the proxy; not through nginx/OCI, the browser or the iPhone.

- **Files:** `flux3-image-klein-int8-convrot` (5.8 GB, from the gated
  `black-forest-labs/flux-3-image-klein-comfy`; Joe accepted the terms as zebede1980). Text encoder
  `qwen3vl_4b_int8_convrot` is byte-identical to FIBO's (same SHA-256), VAE `flux2-vae`.
  **Licence: FLUX Kommunity** (non-commercial, with a commercial-output exception for some users).
- **Graph:** from Comfy's "FLUX 3 Image Klein Distilled" templates, minus the upsampler and
  bounding-box branches: CFG 1 with a zeroed negative, er_sde for text-to-image and euler for edits,
  16 steps. Edits go through `ReferenceMultiLatent` (each picture ~1 MP; its autogrow inputs are
  `images.image0`, `image1`…), and the result takes the first picture's size.
- **Captions:** Klein wants full captions. `writeEditCaption` in `api-image.js` has the vision model
  look at the picture(s) and expand the instruction with BFL's own "i2i" upsampler system prompt
  (verbatim, Apache-2.0), before every Klein edit and combine. Reimagine's prompt is already a
  caption (`captioned: true`). Generation uses the app's own prompt writer as it is.
  - With hand-written captions in that format: edits were as good with a one-line instruction as
    with a caption, but **Combine needs the caption**. Short instructions mixed the two pictures
    up; captioned, both "person from picture 2 into the room from picture 1" and an outfit swap came
    out right, which neither FIBO nor MOSS managed.
  - **Not yet run with the real vision model** (Gemini 3.5 Flash). If it refuses or errors,
    `_editCaptionOrInstruction` sends the instruction as typed (`looksLikeRefusal` spots apology /
    "I can't" openings and short policy replies; a ■ Stop still stops). A *softened* caption isn't
    detectable; if that happens, the next step is BFL's local upsampler
    (`qwen3.5_9b_flux3_prompt_upsampler`, w4a8 6.7 GB, a `TextGenerate` node in Comfy's templates).
- **NSFW (tested on the PC 2026-10-26):** nothing blocks it (ComfyUI doesn't run BFL's reference
  NSFW classifier) and it doesn't cover up, but the training data was filtered: nude photos get faint
  nipples and a smoothed groin, anime gets neither. An undress edit on a fictional MOSS character
  worked first time. No FLUX.3 Klein NSFW LoRA exists yet (the "Klein NSFW" ones on HF are for
  FLUX.2 Klein 9B and won't load); for explicit work use MOSS (photo) or Illustrious (anime).
- **Reimagine** (reference route): a new pose and angle with face, outfit, tattoo and room kept,
  7.6 s against ~30 s for Qwen's two-stage workflow.
- **To finish (Joe):** Settings → Image API → Fetch models, add `local/flux3-klein`, tick "Natural-language prompts".
- **Not built:** bounding-box layout prompts (`Flux3LayoutPrompt`; needs a box UI).

## MOSS-Image edits + Bria FIBO 2.0 (`local/fibo-2`) — deployed 2026-10-26

From Joe's brief (`CardGenV2_new_image_models_brief.md`). ComfyUI on the PC is master `0b05cd8a`
(2026-10-26), which has the core MOSS edit node (#17296) and FIBO 2.0 (#17240). Tested on the PC by
running a scratch copy of the proxy against the local ComfyUI (real routes, real graphs); **not yet
through nginx/OCI, in the browser, or on the iPhone.**

- **To finish (Joe):** Settings → Image API → Fetch models, add `local/fibo-2` (tick
  "Natural-language prompts"), and on `local/moss-image` tick ✨ Edit by hand (its saved ticks
  override the new default). FIBO's 🔀 Combine starts ticked.
- **MOSS edit:** chinoll's edit LoRA in Comfy-Org's repack (`loras/moss_image_edit_lora_rank_64_bf16`)
  through core `TextEncodeMOSSImageEdit`, format `Moss-Image-Edit`, CFG 4, 30 steps, the full
  `flux2-vae` (its encoder makes the reference latents). The uncensored LoRA stays on top: on the
  same seed it kept a crop top and a tattoo that the edit LoRA alone lost. 18 s warm, ~1 MP.
  - Its autogrow inputs count from `images.image_0` (FIBO's from `image_1`), and `image_strength`
    is required.
  - References must be the output's size: 0.25 MP references under a 1 MP latent drew a new
    picture, not an edit.
  - **2-picture edits are off** (`combine: false`, `maxReferences: 1`): an outfit swap copied
    picture 2's pose and body and undressed the subject in 4/4 tries. The graph supports more.
- **FIBO 2.0:** one entry, two checkpoints, all from `Comfy-Org/Fibo-2.0` (INT8; bf16 is 16.5 GB
  and won't fit): Dev generates (30 steps, CFG 5, ~23 s at 1 MP), Edit Turbo edits (4 steps, CFG 1,
  **~6 s**). Text encoder `qwen3vl_4b_int8_convrot`, VAE `flux2-vae`. Settings from the test
  workflow in ComfyUI PR #17240; the gallery has no local template yet (its "Bria" ones are the
  paid API). **Licence CC BY-NC 4.0** (non-commercial); the repack isn't gated.
  - Single edits were the best of any local model tried: face, layout, lettering and tattoo kept,
    anime style held.
  - Combine: builds on the LAST picture and brings the subject from the other. "Character from
    Image 1 into the room from Image 2" worked (the outfit leaked); outfit swaps failed in either
    order. The proxy rewrites "Image 1" to FIBO's `<image_1>`.
  - Prose and Bria's JSON caption gave about equal results (sign text right in both), so the
    writer has no JSON format. The encoder accepts either.
- **Combine route:** `/api/image/combine` now sends local models to `handleLocalComfyImage`, with
  `input_references` as the pictures. `runLocalComfyImage` takes `image` or `input_references`.
- **Reimagine:** only Qwen uses the two-stage local workflow now; MOSS/FIBO go the "reference"
  route (an ordinary edit with the written prompt). Before, any local edit model was sent there
  and the proxy refused it.
- **Not built from the brief:** MOSS layout boxes and the colour/depth control LoRA
  (`moss_image_color_depth_control` exists in the repack) need UI the app doesn't have; FIBO masked
  edits need a mask tool.

## Local MOSS-Image (`local/moss-image`) — deployed 2026-10-18 (`d4be9b0`)

`buildMossGraph` in `proxy/server.js`, from Comfy's `image_moss_image_t2i` template flattened out of
its subgraph, without the LLM prompt-upsampler branch. 25 steps, CFG 2.5, `er_sde`/`simple`, the
official negative prompt minus "nsfw" (removed 2026-10-18 at the user's request: it pushed every
image towards covering up), skip-layer guidance off (the template's default). Text-to-image only.

- **PC side (done 2026-10-18):** ComfyUI moved to master `c06bf5f5`, because MOSS support
  (#17095) isn't in any release tag yet (v0.41.3 lacks it). Files on the PC:
  `moss_image_sft_int8_convrot`, `qwen3.5_9b_int8_convrot` (int8 instead of the template's w4a8),
  and `flux2-vae_small`. If Comfy Desktop is "updated" to a stable release before one includes
  MOSS, the model breaks with "rejected the workflow".
- **Tested:** the graph that `buildMossGraph` builds ran on the PC's ComfyUI directly (not through
  the tunnel/nginx) at 896×1152: 15 s, good prompt adherence. **Ran from the app through the
  deployed proxy 2026-10-23** (Playground 1 per model) and looked good.
- **To finish:** deploy, then Settings → Image API → Fetch models, add `local/moss-image`, tick
  🪄 Generate, set Prompt Length to **Detailed** and tick **Is Flux Model** (it wants natural-language
  prose, not tags).
- Sizes need multiples of 16; `localComfyDims` already rounds to 32. It is happiest at 1–2 MP.
- **Uncensored LoRA, always on (2026-10-23, user's choice over a separate NSFW entry):**
  `MOSS_NSFW_LORA` in `server.js`. axiomofmind's `MOSS-Image-NSFW-Uncensored-LoRA-ComfyUI`
  (74 MB, HF `axiomofmind/Moss-image-nsfw-uncensored-lora`, in the PC's `models\loras`) is applied
  through `LoraLoaderModelOnly` at 0.7, and its trigger `moss_xvstyle, ` leads every prompt.
  - The card's SHA-256 is one character short (a typo); the file matched HF's own LFS hash.
  - **Tested on the PC:** same seed with and without it. It takes effect on the int8 model, with no
    "lora key not loaded" in the log and no extra time (13.6 s warm). SFW prompts barely change:
    anime stays anime, and a photo gets a slightly smoother face.
  - **Deployed 2026-10-23 (`fabb7b3`):** the deployed builder ran from the proxy container through
    the gateway: LoRA node in, trigger leading, 22 s (cold after Qwen).
  - **Not tested:** NSFW output itself.
- **No MOSS edit model exists.** OpenMOSS released only Base and SFT, both text-to-image. Comfy's
  repack adds just a colour/depth *control* LoRA. Edits stay on Qwen-Image 2.1.

## Local Illustrious XL (`local/illustrious-xl`) — deployed 2026-10-21 (`ddbc691`), confirmed in the app 2026-10-23

`buildIllustriousGraph` in `proxy/server.js`: plain SDXL, checkpoint `vxpIllustrious20_beta2`
(a v-prediction merge from NoobAI-XL; ComfyUI spots the `v_pred` key and samples correctly on its
own). Euler/normal, CFG 5, 28 steps, the settings saved in the checkpoint's metadata. Fixed
negative prompt without "nsfw". Capped at 1.05 MP (`maxMegapixels` on the registry entry, which
`localComfyDims` now honours): SDXL doubles bodies above ~1 MP.

- **PC side (done):** the files live in Forge's `models\Stable-diffusion`, which Comfy Desktop
  doesn't scan. They're **hard-linked** into `J:\AI\WebForgeUI\webui\models\checkpoints` (no extra
  disk; deleting the link leaves Forge's copy). Also linked: `illustriousXL_v01` (the original
  v0.1 base, May 2024), which was noticeably flatter in a side-by-side test, so it isn't used.
- **Tested:** the real graph builder, run straight against the PC's ComfyUI at 896×1152: 8 s
  warm, ~30 s cold. After deploying, the deployed builder ran from the proxy container through
  the gateway: 9.3 s, 3:2 capped to 1280×864. **Confirmed from the app 2026-10-23:** Joe added it in Settings → Image API
  and generated with it; it all worked well.
- **NoobAI-XL V-Pred 1.0 tried as a replacement (2026-10-21), and lost.** It's the base that vxp is
  merged from, and is usually named the best for anatomy and NSFW. Same 3 prompts and seed, each
  model with its own recommended negative (NoobAI's needs `mammal, anthro, furry…` because it
  learned from e621): anatomy was about equal, but vxp was clearly more polished, and NoobAI was
  flatter, with sticker-like outlines. The file stays in `models\checkpoints`
  (`NoobAI-XL-Vpred-v1.0.safetensors`, 7.1 GB, from HF `Laxhar/noobai-XL-Vpred-1.0`; Civitai is
  region-blocked here) and can be deleted. NSFW wasn't compared.
- **Set up (done 2026-10-23):** Settings → Image API → Fetch models, add `local/illustrious-xl`,
  tick 🪄 Generate and leave **Natural-language prompts unticked**: the id contains
  "illustrious", so the writer produces tags and the tag bookends apply.
- **Anthro / furry characters (tested on the PC 2026-10-23, 12 images, 2 seeds):** "anthropomorphic
  cat, cat girl, cat ears" gives a human with ears and a tail (Danbooru's kemonomimi). What works:
  `furry female, anthro, (furry:1.2), cat, feline, (body fur:1.2), <colour> fur, snout, animal nose,
  whiskers`, plus `furry hands, fur on hands, pawpads, claws` (without them the hands stay human).
  **Never `muzzle`**: it draws a muzzle restraint. Adding `human, kemonomimi mode, human skin` to the
  negative changed almost nothing, so the fixed negative was left alone. One seed drew a stray extra
  tail. The tag writer now carries this as an ANTHRO / FURRY rule; not yet run with GLM.

## Image prompt fix — deployed 2026-10-18 (`66d9991`), since folded into the Prompt Builder writer

`generateImage` used to bookend every prompt with the style's opening and ~25 SD tags plus a mood
tail, and the prompt writer was also told to open with style words. The result, even for MOSS/Qwen:
"High-quality 2.5D semi-realistic anime illustration of A semi-realistic 2.5D anime illustration of
a woman…, masterpiece, melancholic mood…". Now (`src/scripts/api-image.js`):

- **Natural-language models** (the Settings tickbox formerly called "Is Flux Model"): no bookends.
  The prompt writer opens with one medium + subject sentence and closes by restating the style,
  using the style's tag list as prose cues (`_proseStyleDirective`, quality filler removed).
- **Tag models:** bookends unchanged, but the writer is told the app adds the opening, so it starts
  at the subject ("…illustration of a woman…").
- **Both:** framing/viewpoint asked for, no character names (they can render as text),
  visual-only, lighting concrete and varied instead of "ALWAYS volumetric/HDR".
- **Side effect:** for a natural-language model, changing the Style after a prompt is already in
  the box no longer restyles it. Regenerate the prompt.
- **Tested:** headlessly only, by loading the real file with stubbed config and comparing the
  final prompt before and after. No real text-model or image run yet.
- **To do in Settings:** tick "Natural-language prompts" for every modern model (all local ones,
  Flux, Nano Banana, Seedream, Qwen); leave it off for SDXL/Illustrious/Pony.

## ✨ Prompt Builder (branch `feat/prompt-builder`)

Design mockup: <https://claude.ai/artifact/27bQCmnhM3B4v7xJLSzTLk>. A prompt is a **subject** (an
idea, or a character card) plus a **look** (how it's shot or drawn).

- **One writer:** `writeImagePrompt(spec)` in `api-image.js` replaced `buildImagePromptInstruction`.
  It writes fragments / prose / tags at short / rich / max, optionally as N takes, streams, and is
  **resumable** (the old prompt call wasn't). `generateImagePrompt` keeps its signature and builds a
  spec, so Draft Prompt, Gen 4, Compare Models, batch and Inspire Me all use it.
- **Formats by model:** "Natural-language prompts" ticked → fragments; unticked with an SDXL-family
  name (Illustrious, Pony, SDXL…) → tags; any other unticked model → prose, so a modern model whose
  box was never ticked doesn't get tag soup.
- **Look catalogue:** `prompt-look.js` (10 sections, each group with ✨ AI decides). Starter looks,
  the old Style Presets as built-in looks, and saved looks (`api.image.looks`, an array).
- **Sheet:** `prompt-builder.js` + `.pb-*` styles in `main.css`. Full screen on phones, centred at
  ≥700px. Build, 🎲 Surprise me (bold choices, temperature 0.85), 🔀 3 variations, Match an image
  (`extractStyleFromImage`), save/delete looks, edit before use. State is kept per host in
  localStorage (`cardgen.promptBuilder.v1`). Closing mid-write lets it finish; a toast says when.
  ■ Stop only abandons the write, because `stopGeneration()` cancels every running job.
- **Playground host:** ✨ Build beside the Generate box (maxlength now 4000), ↩ Restore my idea.
- **"From your cards" looks** (18, `group: "cards"` in `STARTER_LOOKS`), one per distinct style among
  the user's favourite cards (account "zebede"). Skipped as near-duplicates: Avril Downing (= Analog
  cyberpunk photo), Adaeze Okonkwo (= Lumi), Sigrid Vinter (merged with Phan Thị Kiều). Some carry
  signature props as materials (Kurokawa's irezumi and red rope, Tzipporah's face runes, Lithia's
  chains), which do show up on any subject; remove the chip for style only.
- **First real-model test (2026-10-18):** writer instructions built by the real code, sent to GLM 5.3
  on nano-gpt (6 calls, ~5.6k tokens): fragments format, two blocks and every look choice honoured;
  `### TAKE` output parsed. Prompts drawn on MOSS via `buildMossGraph`: Kurokawa and Lithia transfer
  strongly; Tzipporah and Phan/Sigrid were tuned once (more contrast and stare; magenta kept to one
  accent) and then matched well.
- **🖼️ Match an image** opens a picker inside the sheet: 🧙 Characters (Library cards, portrait from
  `/api/storage/cards/thumbnail`) and 🧪 Library (Playground images), with a name filter, plus
  📁 Upload from this device. Lists load once per opening of the sheet. Only the picture's *style*
  is read (`extractStyleFromImage`) into `look.fromImage`.
- **Explainers:** `PromptLook.DESCRIPTIONS` has a one-liner for every built-in option (128) and for
  ✨ AI decides. Shown as a `title` on hover, and under the group for the last option tapped (phones
  have no hover). Add one whenever an option is added to the catalogue.
- **🔞 NSFW checkbox** (Output panel, remembered per host): `spec.nsfw` adds a MATURE CONTENT block to
  the writer — nudity and erotic imagery described plainly, `nsfw` as the first tag for tag models —
  with a fixed rule that every character is a clear adult (18+). Keep that rule if the block is
  ever reworded. The text model (GLM via nano-gpt) may still soften prompts.
- **🖼️ Generate all 3** on the takes screen draws one image per take. Playground: the take prompts
  go through `handleGeneratePlaygroundImage({ takes, model })` into its pick grid, badged with the
  take labels. Character Gen: `_generateCharacterTakes` shows them in Gen 4's pick-one modal (Keep
  current first, the rest go to history). A failed take is named and doesn't stop the others.
  Tested in the harness against a fake image API only.
- **Character Gen host:** 🎨 Look row above Prompt Guidance. The active look is
  `api.image.activeLook` (a JSON string; config is deep-merged on load) + `activeLookId`. It replaces
  Style Preset and Mood for Draft Prompt, Generate and Compare Models; **Gen 4 still uses its own
  style picks**; with no look everything works as before. Guidance doubles as the builder's
  "extra direction" and syncs both ways.
- **Also fixed:** Draft Prompt always sent card type "single"; it now sends the card's real type.
- **New-character portraits** (Generate, batch, Inspire Me; `generateNewCharacterImage`):
  - Card prompts with no framing picked ask for a portrait that shows the face clearly (group: every
    face visible; scenario: wide view). The first builder release had dropped that rule.
  - Generate and batch reset Mood along with Style (to none and "realistic"); Inspire Me resets
    neither, as before.
  - An active Look still applies to new characters, and the progress log says "🎨 Using Look: …".
  - The PC-off fallback reuses the prompt written for the local model. `generateImage` now adds
    Style Preset bookends according to how a prompt was *written* (`_rememberPromptFormat`), so a
    fragments prompt drawn by an unticked hosted model isn't given a doubled opening.
- **Tested headlessly only:** Node checks of the writer (instructions, parsing, bookends) and a
  browser harness running the real sheet + host code against a fake streaming text model (all
  flows, 320/375 px and desktop, light and dark). **Not yet run with the real text model, on a real
  iPhone, or in WebKit.** The lock-and-resume path is `api.js`'s, unchanged, not exercised here.
- **Format follows the model on reopen (fixed 2026-10-23):** reopening the sheet with the same idea
  resumes its state, and that used to keep the old Format, so building with Illustrious (tags)
  and then with MOSS gave MOSS tags. Now a model that wants a different format switches it; a
  model of the same kind keeps a Format picked by hand. In 1 per model, the builder writes for the
  **first ticked** model, so mixing Illustrious with natural-language models still gives one format
  for all.
- **Open ideas:** a "Build" in Playground's Edit tab for edit instructions; storing the Look on
  each card rather than globally.

## 🔍 Tap-to-zoom on the main images — deployed 2026-10-19

Tapping Character Gen's portrait (`#image-content`) or the Playground's working image
(`#playground-image-preview`) opens the existing lightbox (`openGallery` in `image-gallery.js`).
`_initImageZoomTriggers` delegates from the containers, because many code paths replace the image
via `innerHTML`. A 🔍 badge (CSS `::after`) marks both images.

- Character Gen opens in context `view`: just the portrait, no "Use This".
- Playground opens on the working image with every history version a swipe away, labelled, plus
  the prompt where one was recorded. **↩ Make Current** on another version selects it, as tapping
  its thumbnail does.
- The lightbox's gestures were reworked for the iPhone: pinch zooms around the fingers, double-tap
  (or double-click) zooms 2.5× on that spot and back, one finger pans when zoomed or swipes between
  images when not, wheel zooms at the cursor. Pan is clamped so the image always covers the
  screen, and scale never goes below 1. `touch-action: none` on the container keeps Safari's page
  zoom out of it. These apply everywhere the lightbox is used (library, gallery strip, chat scenes).
- **Tested:** WebKit at 390 px (synthetic touch events) and 1280 px: anchoring, clamp, swipe,
  Make Current, Esc. **Not yet tried on a real iPhone**, where real multi-touch is what matters.

## 🔄 Reimagine (Playground tab) — deployed 2026-10-19 (`d45068b`)

A new picture of the same character, scene and style: a new angle, pose or moment. Edit can't do
this: an edit model given "show her from the front" keeps the old composition.

**How it works:**
1. The vision model (`api.text.visionModel`, Gemini 3.5 Flash) looks at the pinned source and writes
   a full new-shot prompt ("A new shot of the same…"): the change, then the character in detail,
   the setting, then lighting and art style (`writeReimaginePrompt` in `api-image.js`; streams and
   is resumable).
2. The image model gets the prompt plus the picture (`reimagineImage`). Three routes, from
   `reimagineRoute(model)`:
   - **local edit model** (Qwen-Image 2.1): the proxy's `buildQwenReimagineGraph`, with
     `reimagine: close|balanced|loose`.
   - **hosted edit model** (Nano Banana, Seedream…): `editImage` with the written prompt.
   - **text-to-image model** (MOSS, Flux 2 Pro…): the prompt alone, written for no reference.

**The local workflow (measured on the PC, 2026-10-19):** Qwen's encoder takes the source two ways:
vision-language tokens (what is in it) and VAE reference latents (where every pixel is). The
latents are what pin the old layout. So a two-stage `KSamplerAdvanced` run:
- the first steps see only the VL tokens plus the prompt, so the composition is free;
- then the reference latents join, pulling the face, outfit and textures back to the source.

`REIMAGINE_REFERENCE_FROM`: close joins at 12% of steps (3 of 25), balanced at 24%, loose never.
Even joining at step 2 kept the new composition.

What didn't work:
- A long "keep everything" prompt *with* latents changes less than a short one.
- `ConditioningSetTimestepRange` + `ConditioningCombine` to mix the two crashes ("size of tensor a
  must match"): different token lengths.
- A smaller reference (0.3 MP) still copies.

**UI:**
- The source is pinned when the tab opens (↺ Use current re-pins it), so retries start from the
  same picture.
- A prompt still exactly as written is rewritten when the change, source or model kind changes; a
  hand-edited one is kept.
- How many 1/2/4: the first result becomes the working image, the rest go to the history strip
  (tap the picture to swipe through them). Shape "Same as source" sends the exact proportions to
  local models, and the nearest named ratio to hosted ones.

**Tested:**
- Three Likeness settings through the live proxy on the PC with a hand-written prompt: new
  front-on shots, ~30 s each.
- The UI in WebKit at 390 px against fake APIs.
- **Not yet run live:** the prompt writer (one Gemini vision call per write) and the hosted routes.

## Next work stream: image-to-image for Flux 2 and Krea 2

Joe's request (2026-10-19): Flux 2 (and probably Krea 2) can do image-to-image / reference
editing. Investigate support and whether new local workflows are needed. Get Qwen Reimagine working
really well first.

Starting points:
- Comfy's Flux 2 templates use `ReferenceLatent` nodes for multi-reference editing.
- The PC already has `flux2-vae_small` (from MOSS), but not a local Flux 2 diffusion model.
- Krea 2 Turbo is local, text-to-image only today (`buildKrea2TurboGraph`).
- Check what each model's official ComfyUI edit/reference template needs. The PC's nginx blocks
  `/object_info`, so do it from the PC, or probe by submitting graphs: `/prompt` validation errors
  name the missing inputs, and unknown inputs are ignored.
- Experiment harness used for Reimagine: submit graphs from inside the proxy container (it has the
  COMFYUI env), save as `cardgen/exp`, compare on a contact sheet.

## Roleplay Chat rebuilt for the iPhone (2026-10-23) — `plans/roleplay-chat-mobile-redesign.md`

The open chat was rebuilt as one layer, iPhone first; the plan's "Implementation notes" section
covers the details.
- **Shell:** a fixed shell sized to `visualViewport`, so the keyboard no longer pushes the header
  away. Fields are 16px, so Safari no longer zooms on tap.
- **Layout:** a slim header (Aa for text size, tap the names for the cards); a one-row composer,
  with ＋ for OOC / Impersonate / speaker. On a phone Return types a newline. Actions show when you
  tap a message; the latest reply always shows its own.
- **Editing:** a full-screen sheet.
- **Replies:** read from the top as they arrive, with the ↓ dot when text is below.
- **Resilience:** the chat now has a stall watchdog (45 s, with the backend pinging every 15 s)
  and recovers a dropped reply by fetching that one message. Waking no longer aborts a live reply.
- **Tested:** headless WebKit against a fake streaming backend. **First iPhone try (2026-10-23):** Joe ran
  through most of the checks below: "much improved", no problems found so far. Desktop not yet checked.
- **Try on the iPhone:**
  - The keyboard opening and closing.
  - Locking mid-reply, then coming back.
  - Editing a long message.
  - Rotating.
  - A group chat's speaker picker.

## DeepSeek V4 Pro tried as the text model (2026-11-02) — works; name parser fixed

`deepseek/deepseek-v4-pro-0813` ($0.66/$1.98 per M) was run against the real code with the user's
settings, nothing saved. **Roleplay Chat:** 4 real chats regenerated through the backend's own prompt
builder: native reasoning arrives in `delta.reasoning`, becomes the think block, no fallbacks fired, no
CJK, explicit scenes continued without softening; faster than GLM 5.3 on all four (Avril: 18 s vs 91 s).
**Character Gen:** 2 cards in headless WebKit on the live site: every field filled, ~50 s vs GLM's 66 s.
One card came back named `{{char}}`: DeepSeek applied the "{{char}} everywhere else" rule to the
`# Name's Profile` header too. `extractCharacterName` (character-generator.js) now skips a placeholder
header and reads the first sentence, and accepts apostrophes/hyphens/accents/particles. The old header
regex also failed on any apostrophe name (`# Deirdre O'Halloran's Profile` didn't match), on GLM too.
The user's model setting is still GLM 5.3; switching is a Settings → Text API change.

## Roleplay Chat: Stop cancels the server, no error text in history, token floor, rich-tag XSS — 2026-11-03

Four of the review findings below, fixed together. Backend (`chat.py`) and client (`chat-handler.js`):

- **Stop cancels the generation on the server.** `POST /chats/{id}/messages/{msg}/cancel` cancels the
  task in `_ACTIVE_GENERATIONS` (keyed by assistant message id), waits for it to save, and returns
  `{cancelled, deleted, content}`. `stopGeneration()` fires it before aborting the socket; the send and
  regen flows then await `_settleCancel()` and make the bubble match what the server kept (a reply that
  had nothing yet is deleted and its bubble removed). Before, the server finished and paid for the
  whole reply while the bubble showed a fragment, and Edit + Save overwrote the full text.
  Impersonate has no message id, so Stop there still only closes the socket.
- **Failed generations are no longer stored.** The error is sent to the browser only; the stored reply
  is whatever arrived. An empty placeholder is deleted (an empty assistant message means "still
  generating" to the browser's pending banner). A reply cut off inside its reasoning gets its
  `<think>` closed so history stripping removes it. `DELETE …/messages/{id}` on a missing message
  now returns `{success, missing}` instead of 404, so Regen and Delete on such a bubble still work.
- **Token floor and length cut.** Chat `max_tokens` is now at least `CHAT_MIN_MAX_TOKENS = 4096`
  (the proxy's floor; GLM 5.3 reasoning counts against it). A reply that still ends with
  `finish_reason == "length"` is trimmed to its last sentence end (`_trim_cut_reply`) and re-sent as
  `corrected_content`.
- **Rich-tag XSS closed.** `formatMessage` lifts `<text-message>`, `<task>`, `<stat-bar>`,
  `<scene-image>` and `<think>` out before escaping; now only a tag matching the renderer's own
  shape (`SAFE_RICH_TAG`) goes back raw, anything else is escaped as prose. Scene images render
  with the URL and prompt in `data-` attributes (scheme restricted to http(s), `/`, `data:image/`,
  `blob:`) and a delegated click listener on the timeline opens the lightbox; the inline `onclick`
  that spliced the URL into JavaScript is gone.
- **Tested:** Python helpers (`_trim_cut_reply`, `_close_open_think`) against the real module;
  `formatMessage` under Node with a stub DOM against the XSS payloads from the review and the normal
  rich tags. **Not tested:** the cancel round-trip end to end, nor any of it on the iPhone.
  Try: Stop mid-reply, then reload — the bubble and the reload should agree; Stop during the
  "thinking" phase should leave no empty bubble.

## Roleplay Chat variety (2026-11-03) — deployed, not yet run against a real model

Why: apart from the history, the prompt was identical every turn (same cards, examples, CoT,
post-history reminders) and Regenerate re-sent the very same prompt, so replies only varied through
sampling. Changes, all in the post-history system message (already per-turn, so prompt caching of
the system block and history is unaffected) — `chat.py`, `llm_service.py`, `schemas.py`,
`chat-handler.js`, Chat Settings modal in `index.html`:

- **Regenerate asks for a different take.** The client sends `regenerate: true` and
  `previous_reply` (think block and scene images stripped, 1500 chars). The backend adds a
  `[Regeneration]` line quoting the rejected reply's first sentence and ordering a different opening
  and beat. A regen always gets a nudge. Regen also now sends `enable_cot` (it used to omit it).
- **Variety nudges** (`VARIETY_NUDGES`, 12 beats + 3 blanks, `random.choice` per turn) as a
  `[This turn]` line, plus a `[Variety]` line listing the first 8 words of the last 5 replies as
  off-limits openings. Chat Settings → "Variety nudges" tickbox (`chat.varietyNudges`, default on).
- **Example messages fade** after `EXAMPLE_MESSAGES_FADE_AFTER = 8` real replies.
- **Presence Penalty** (`chat.presencePenalty`, default 0; `presence_penalty` sent only when
  non-zero) and **Reasoning Effort** (`chat.reasoningEffort`, default `high`, nano-gpt only) in
  Chat Settings. `frequency_penalty` is plumbed through the backend but has no UI.
  Untested whether nano-gpt honours `presence_penalty`; the proxy already forwards it for Character
  Gen, so it is expected to. `repetition_penalty` is a vLLM parameter nano-gpt may ignore.
- All three chat payloads (send, regen, impersonate) now come from `_chatGenOptions()`.
- **Tested:** headless Python tests of `build_chat_prompt` (fade, nudge rate, regen line, variety
  off) and of the `LLMService` payload per host (stubbed FastAPI/SQLAlchemy, since this PC has
  neither). No real generation; the Chat Settings modal not opened in a browser.
- **To try:** a regen on a real chat and look at the api log's post-history block; Presence 0.4 and
  Reasoning Effort medium side by side with the defaults.

## Code review 2026-11-03 — open findings (nothing below is fixed yet)

Roleplay Chat, in severity order. Client lines are in `chat-handler.js`, backend in `chat.py`.
(Fixed the same day, see the section above: rich-tag XSS, Stop not cancelling the server, error text
stored in history, the output-token cap.)
- **Cards reach the model with literal `{{char}}`/`{{user}}`** (only story mode and the first
  message substitute them), so `{{user}}` never becomes the persona name.
- Impersonate never sets `isGenerating` (overlapping streams share one abort controller); streams
  aren't pinned to the chat they started in; the watchdog resets `lastByteAt` on hidden ticks so
  `syncOnWake`'s fast check never fires; settings can't store 0 (`parseFloat(v) || default`); old
  chats keep the pre-August CoT wording in their stored system prompt so the native-reasoning swap
  never applies (plausible, DB-dependent); the summary grows without bound; the lorebook keyword
  scan reads `<think>` text; speaker routing matches "Ann" inside "Annabel".

Character Gen (`character-generator.js`, `api-character.js`, `main.js`):
- (Fixed 2026-11-19: "The …" names, scenario titles, and the non-resumable / non-streamed calls.)
- Example Messages textarea has no input listener, so edits are lost on Save.
- A failed generation collapses the inputs panel (blank phone screen); Stop between the prompt
  save and the card call still pays for a card; the name shortlist contradicts a typed name; Redo
  and Remaster use single-character field rules on group/scenario cards; every first-person card
  opens with the hard-coded "You want to know about me? Fine." line.

## Known open issues

- **Root cause of the 2026-10-18 stall is unknown.** The proxy finished the job and NPM sent the
  full 55 KB, but the desktop browser stopped receiving it partway through. The watchdog now
  recovers resumable streams. It hasn't been reproduced on a real stalled network.
- Story Writer (`/api/sw/*`) has no stall watchdog (Roleplay Chat has one since 2026-10-23,
  Adventure since 2026-11-08). It has its own reader.
- Recovered card **Avril Downing** (History, `h_1792307637233_joudne`) has no example messages,
  creator's notes, post-history instructions or portrait yet. Generate those in-app.
- Only new-character portraits fall back to a hosted model when the PC is off. Regenerate,
  Playground and Compare Models just show the "Local GPU is offline" error.
- nano-gpt's `/models` returns 200 even with a bogus key, so the status badge proves the API is
  reachable, not that the key works.
- `express-rate-limit` warns `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` because `trust proxy` is off
  behind NPM, so the auth rate limiter can't tell clients apart by IP.
- Main-card `max_tokens` is 16384 (`MAIN_CARD_MAX_TOKENS`). It's untested whether nano-gpt accepts
  that for GLM 5.3; if a card errors on limits, look there first.

## Things that bite

- Bump the `?v=` on a script's tag in `index.html` whenever you change that script, or iPhone
  Safari keeps the old file.
- `main.js` injects a dark-theme rule, `[data-theme="dark"] button:not(.btn-primary):not(…)…`, that
  repaints every other button's background, colour and border. Its `:not()` chain outranks ordinary
  class selectors, so any button with its own selected state (chips, toggles) must be styled under
  an id, as the Prompt Builder's are (`#prompt-builder .pb-chip…`). A test page without `main.js`
  won't show the problem; check in the real `index.html`.
- Never pass a third-party 401 through to the browser; `authFetch` logs the user out on any 401.
- Model ids contain dots and slashes. Never use `config.get("api.image.modelCapabilities." + id)`;
  read the map whole and index it.
- A headless session logged in as the real user used to fire a paid GLM test call at boot. That's
  gone since `768a86f`, but stub `/api/text` anyway when probing as a real user.
- Rebuilding the proxy wipes `docker logs` and drops in-flight jobs. NPM access logs persist.
