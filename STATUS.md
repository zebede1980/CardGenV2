# CardGenV2 — where things stand

Last updated 2026-10-18 (evening). Branch `ChatTest`, with MOSS-Image, the image-prompt fix and the
✨ Prompt Builder merged, pushed and deployed. Update this file when you ship something or find something worth remembering: it is the
hand-over between machines, since Claude's own memory does not travel between them.

## Shipped recently, not yet tried for real

All of these were tested only headlessly against fake APIs. No real paid generation or local-GPU
run was made.

| What | Commit | Try this |
|---|---|---|
| Playground Generate **Shape** picker (`api.image.generateAspectRatio`) | `279755b` | Generate a 16:9 and a 3:4 image and check the shape |
| Nano Banana 2.1 fix: tier models get `aspect_ratio` only, no pixels (they 400 on pixels) | `d15f16a`, `6f652c0` | Generate with Nano Banana 2.1 and qwen-image-3-pro |
| Image sizes follow nano-gpt's catalogue (`GET /api/image/catalog`, cached 6 h) | `6f652c0` | flux-2-pro at 4:3 should come back 1536×1024 (it lists no 4:3) |
| Text-stream stall fix: proxy `: ping` every 15 s, client watchdog after 45 s silence | `ef00936` | Nothing to do unless a card stalls again; if it does, check whether it resumed |
| Playground **1 per model** (How many → 1 per model; picks shared with ⚔️ Compare Models, max 4) | `bd06db7` | Run it with the PC on, across all local models |
| Status badge is free now (`checkTextApiReachable`, GET `/models`, cached 5 min) | `768a86f` | Badge still goes green; Settings → Test Connection still makes a real call |
| ⚔️ Compare Models in Character Gen | `eda75dd` | Never run against the real GPU |
| Combine tab (qwen-image-3-pro, reve/2.1/remix, grok-imagine edit) | — | Never confirmed against a real model |

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

## Local MOSS-Image (`local/moss-image`) — deployed 2026-10-18 (`d4be9b0`)

`buildMossGraph` in `proxy/server.js`, from Comfy's `image_moss_image_t2i` template flattened out of
its subgraph, without the LLM prompt-upsampler branch. 25 steps, CFG 2.5, `er_sde`/`simple`, the
official negative prompt, skip-layer guidance off (the template's default). Text-to-image only.

- **PC side (done 2026-10-18):** ComfyUI moved to master `c06bf5f5`, because MOSS support
  (#17095) isn't in any release tag yet (v0.41.3 lacks it). Files on the PC:
  `moss_image_sft_int8_convrot`, `qwen3.5_9b_int8_convrot` (int8 instead of the template's w4a8),
  and `flux2-vae_small`. If Comfy Desktop is "updated" to a stable release before one includes
  MOSS, the model breaks with "rejected the workflow".
- **Tested:** the graph that `buildMossGraph` builds ran on the PC's ComfyUI directly (not through
  the tunnel/nginx) at 896×1152: 15 s, good prompt adherence. Not yet run through the deployed
  proxy.
- **To finish:** deploy, then Settings → Image API → Fetch models, add `local/moss-image`, tick
  🪄 Generate, set Prompt Length to **Detailed** and tick **Is Flux Model** (it wants natural-language
  prose, not tags).
- Sizes need multiples of 16; `localComfyDims` already rounds to 32. It is happiest at 1–2 MP.

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
- **Character Gen host:** 🎨 Look row above Prompt Guidance. The active look is
  `api.image.activeLook` (a JSON string; config is deep-merged on load) + `activeLookId`. It replaces
  Style Preset and Mood for Draft Prompt, Generate and Compare Models; **Gen 4 still uses its own
  style picks**; with no look everything works as before. Guidance doubles as the builder's
  "extra direction" and syncs both ways.
- **Also fixed:** Draft Prompt always sent card type "single"; it now sends the card's real type.
- **Tested headlessly only:** Node checks of the writer (instructions, parsing, bookends) and a
  browser harness running the real sheet + host code against a fake streaming text model (all
  flows, 320/375 px and desktop, light and dark). **Not yet run with the real text model, on a real
  iPhone, or in WebKit.** The lock-and-resume path is `api.js`'s, unchanged, not exercised here.
- **Open ideas:** a "Build" in Playground's Edit tab for edit instructions; storing the Look on
  each card rather than globally.

## Known open issues

- **Root cause of the 2026-10-18 stall is unknown.** The proxy finished the job and NPM sent the
  full 55 KB, but the desktop browser stopped receiving it partway through. The watchdog now
  recovers resumable streams. It hasn't been reproduced on a real stalled network.
- Chat, Story Writer and Adventure (`/api/sw/*`) have no stall watchdog. They have their own
  readers.
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
- Never pass a third-party 401 through to the browser; `authFetch` logs the user out on any 401.
- Model ids contain dots and slashes. Never use `config.get("api.image.modelCapabilities." + id)`;
  read the map whole and index it.
- A headless session logged in as the real user used to fire a paid GLM test call at boot. That's
  gone since `768a86f`, but stub `/api/text` anyway when probing as a real user.
- Rebuilding the proxy wipes `docker logs` and drops in-flight jobs. NPM access logs persist.
