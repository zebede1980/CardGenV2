# CardGenV2 — where things stand

Last updated 2026-10-18. Branch `ChatTest`, clean, pushed and deployed (head `768a86f` before this
file). Update this file when you ship something or find something worth remembering: it is the
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

## Next up: add the local `moss` model

ComfyUI models are wired in `proxy/server.js` only; the frontend picks them up automatically.

1. Load moss's official ComfyUI template on the PC and export it in **API format**.
2. Write `buildMossGraph({ prompt, seed, steps, width, height, sourceImage })` beside
   `buildZImageTurboGraph` / `buildKrea2TurboGraph`. Use the exact filenames from the PC's models
   folders, and keep the template's node ids so the two can be compared later.
3. The final `SaveImage` node **must** use id `LOCAL_COMFY_OUTPUT_NODE` (`"56"`), with
   `filename_prefix: "cardgen/moss"`. The result is read back from that node.
4. Add an entry to `LOCAL_COMFY_MODELS`, e.g.
   `"local/moss": { name: "Moss", capabilities: { generate: true, edit: false }, steps: {...}, buildGraph: buildMossGraph }`.
   Set `edit: true` only if the workflow takes a source image (see how the Qwen graph handles
   `sourceImage`).
5. The nginx on the PC only lets through `/system_stats`, `/prompt`, `/history/*`, `/view` and
   `/upload/image`. No change is needed there unless the workflow needs another endpoint.
6. Deploy (proxy rebuild; check nothing is generating first). Then Settings → Image API → Fetch
   models, add `local/moss`, and tick 🪄 Generate.
7. Sizes: `localComfyDims` caps local generations at `COMFYUI_MAX_MEGAPIXELS` (2 MP) and rounds to
   multiples of 32. If moss needs a different multiple or a fixed size list, handle it in the
   graph builder.
8. In Settings, give it a prompt-length preference (short/detailed). Compare Models groups by that.

The PC's ComfyUI can't be inspected from the cloud box (the nginx allow-list blocks
`/object_info` and the model listings), so this is easiest to do from the PC.

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
