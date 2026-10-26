# CardGenV2 — where things stand

Last updated 2026-10-26. Branch `ChatTest`, with MOSS-Image, the image-prompt fix and the
✨ Prompt Builder merged, pushed and deployed. MOSS-Image editing, Bria FIBO 2.0 and FLUX.3
Klein deployed 2026-10-26 (`f837558`). Update this file when you ship something or find something worth remembering: it is the
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
  - **Not yet run with the real vision model** (Gemini 3.5 Flash). It may soften or refuse explicit
    edits; if it does, the fallback is BFL's local upsampler (`qwen3.5_9b_flux3_prompt_upsampler`,
    w4a8 6.7 GB, a `TextGenerate` node in Comfy's templates).
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

## Known open issues

- **Root cause of the 2026-10-18 stall is unknown.** The proxy finished the job and NPM sent the
  full 55 KB, but the desktop browser stopped receiving it partway through. The watchdog now
  recovers resumable streams. It hasn't been reproduced on a real stalled network.
- Story Writer and Adventure (`/api/sw/*`) have no stall watchdog (Roleplay Chat has one since
  2026-10-23). They have their own readers.
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
