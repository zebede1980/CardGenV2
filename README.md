# SillyTavern Character Generator (v2)

![SillyTavern Character Generator Interface](clean.png)
![SillyTavern Character Generator Interface - Generated Card](generated.png)

Web app for generating, editing, importing, revising, and exporting SillyTavern character cards (Spec V2 `.png` / `.json`).

Cards are designed as **concise AI-guidance** — clear behavioural direction and character description that an AI can use to portray the character, not prose fiction. The generation prompts, revision tools, and card-quality tools all enforce this principle.

---

## Features

### Character Generation
- Generate a full character card from a free-text concept description.
- Optional fixed character name, or let the AI generate one grounded in the character's background and time period.
- **First-person** (`I am...`) or **third-person** (`She is...`) POV templates.
- Optional lorebook (SillyTavern World Info JSON) uploaded as grounding context at generation time.
- Optional reference image upload — auto-described by a vision model if configured, or manually described.
- Streaming generation with stop support.
- Generated cards use short prose for backstory/scenario and direct bullet points for traits and behaviours — not padded narrative.

### Import & Edit
- Import existing cards (`.png` with embedded `chara_card_v2` data, or `.json`) and edit them in-place.
- **Import & Remaster** — import a card and immediately run an AI rewrite pass that fixes inconsistencies, tightens language, and brings the card in line with the conciseness standard.
- Per-field **Redo** buttons regenerate any single section with AI; an optional instruction box lets you guide the rewrite.
- Per-field **Reset** buttons revert a section back to the last generated or imported baseline, discarding manual edits.

### AI Revision Tools
- **Revise Card with AI** — apply a free-text instruction to rewrite the whole card (e.g. "make her more guarded and less verbose").
- **✂️ Reduce Bloat** — two-in-one tool:
  1. Scans the card with AI and presents a checklist of world-building content (locations, NPCs, factions, historical events) that belongs in the lorebook rather than the card body. You choose what to move.
  2. Strips all flowery prose and repetition from what remains, leaving only direct AI-guidance.
- **📚 Scan for Lorebook Content** — runs only the lorebook-elevation scan without the bloat-reduction pass. Useful when a card is already concise but you want to clean up embedded lore.
- **🔍 Check Consistency** — AI reviews the card for logical contradictions, tonal mismatches, or continuity errors and produces a written report.
- **✨ Auto-Fix** — automatically applies the fixes suggested by the last consistency report.

### Lorebook Manager
- Add, edit, and delete lorebook entries (keyword/trigger → content pairs).
- **Suggest Topics from Card** — AI analyses the character profile and suggests key nouns (locations, NPCs, factions, items) as lorebook candidates.
- **Generate with AI** — fills entry content for a topic, using the character card as context; an optional hint guides tone and focus.
- **Inject Keys into Card** — AI rewrites the Scenario to naturally include your lorebook keywords, ensuring they trigger reliably during roleplay.
- **Download Lorebook (.json)** — export the lorebook as a standalone SillyTavern World Info file.
- Lorebook is embedded in exported PNG/JSON as `character_book`.

### Alternate Greetings
- Add up to 5 alternate first messages per card.
- **Gen Random** — generates a completely different opening scenario with the same character.
- **Gen Continuation** — generates a new encounter set after the original scenario has concluded.
- Optional hint to guide AI generation.
- Alternate greetings are embedded in the exported card.

### Example Messages
- Generate dialogue examples in SillyTavern `<START>` format, embedded directly in the exported card.
- Adjustable count (1–5 examples).
- Optional instruction to set tone or speaking style (e.g. "angry", "whispering", "formal").
- Works with both generated and imported cards.

### Image Handling
- AI generates an image prompt from the character description (up to ~1000 characters), displayed in an editable box.
- Regenerate the prompt or the image independently.
- **Generate 4 (Models)** — generates one image per saved model simultaneously for a style comparison.
- **Generate 4 (Variations)** — generates four prompt variations from the active model.
- Upload your own image instead of AI-generating one.
- CORS-bypass proxy for fetching remote image URLs.

### Library (Server-Side Storage)
- Prompts and cards are auto-saved to the proxy server's `data/` directory after generation and revision.
- Manual **Save to Library** button also available.
- Load or delete saved prompts and cards from the UI.
- Data persists across restarts when using Docker volumes.

### Export
- **Download Character Card (PNG)** — SillyTavern-compatible PNG with embedded `chara_card_v2` metadata. Lorebook and alternate greetings are included.
- **Download as JSON** — raw `chara_card_v2` structure.

### Token Counter
- Live token-count display per field and a running total for the full card, helping you keep the card lean.

---

## Requirements

- Node.js 18+ (for local dev)
- OpenAI-compatible text API endpoint (required)
- OpenAI-compatible image API endpoint (optional)
- Vision-capable text model (optional — only needed for reference-image auto-description)

---

## Quick Start

### Local (Dev)

```bash
npm install
cd proxy && npm install && cd ..
npm run dev
```

- Frontend: `http://localhost:2427`
- Proxy API: `http://localhost:2426`

### Local (Non-dev)

```bash
npm start
```

### Docker Compose

```bash
cp docker-compose.example.yml docker-compose.yml
# Edit docker-compose.yml or create a .env file with your port preferences
docker compose up -d --build
```

- Frontend: `http://localhost:2427` (or the port set by `FRONTEND_PORT`)
- Proxy health: `http://localhost:2426/health` (or the port set by `PROXY_PORT`)

> **Library persistence:** The Docker Compose configuration maps `./proxy/data` to `/app/data` inside the proxy container, so saved cards and prompts survive container restarts.

---

## Configuration

### Environment Variables (`.env` / Docker)

| Variable | Default | Description |
|---|---|---|
| `FRONTEND_PORT` | `2427` | Host port mapped to the frontend container |
| `PROXY_PORT` | `2426` | Host port for the proxy server |
| `FRONTEND_URL` | `http://localhost:2427` | Used by the proxy for CORS and OpenRouter headers |

### In-App API Settings

| Setting | Notes |
|---|---|
| Text API Base URL | OpenAI-compatible endpoint (e.g. `https://api.openai.com/v1`) |
| Text API Key | Passed as `Authorization: Bearer` or `X-API-Key` header |
| Text Model | Model name for all generation and revision calls |
| Vision Model | Optional — used to auto-describe reference images |
| Image API Base URL | Optional — enables image generation |
| Image API Key | Optional |
| Image Model | Optional |
| Image Size | Optional (e.g. `1024x1024`) |
| Persist API keys | Off by default — keys are session-only unless toggled |
| Enable image generation | Toggle to show/hide image controls |

Settings are saved server-side (via `POST /api/config`) so they persist across page reloads.

---

## Usage

1. Open **API Settings** and configure your text API endpoint, key, and model.
2. Enter a **Character Concept** in the text box. Be as detailed or as brief as you like.
3. Optionally set a **Character Name** (or leave blank for the AI to generate one).
4. Choose **POV** — first-person or third-person.
5. Optionally upload a **Lorebook JSON** (World Info) as grounding context for generation.
6. Optionally upload a **Reference Image** — it will be auto-described if a vision model is set.
7. Click **Generate Character** and watch the card stream in.
8. Edit any field directly in the text areas. Use **Redo** to regenerate a single section, or **Reset** to revert to the last generated version.
9. Use the **Revision Tools** to refine the card:
   - **Reduce Bloat** to move lore to the lorebook and strip prose padding.
   - **Scan for Lorebook Content** to elevate lore without the bloat pass.
   - **Revise Card** for any specific change.
   - **Check Consistency** + **Auto-Fix** for logic and continuity issues.
10. Open the **Lorebook Manager** to add world-building entries, or let the AI suggest and generate them.
11. Open **Alternate Greetings** to add alternative opening scenes.
12. Generate **Example Messages** — they are embedded in the exported card automatically.
13. Click **Download Character Card (PNG)** to export.

---

## Card Design Philosophy

Character cards in SillyTavern are loaded into the AI's context on every message. Long, flowery cards inflate token costs and can reduce coherence. This tool generates cards that follow a clear standard:

- **Short prose** for backstory and scenario (factual, 2-3 paragraphs max).
- **Bullet points** for personality traits, behavioural patterns, speech style, goals, fears, and limits.
- **No padding** — every sentence must serve a direct descriptive or behavioural function.
- **Lorebook for lore** — world-building detail (locations, factions, history) should live in lorebook entries that inject only when triggered, not in the card body.

The **Reduce Bloat** and **Scan for Lorebook Content** tools help you bring imported or older cards in line with this standard.

---

## API Compatibility Notes

- The frontend calls only the local proxy (`/api/...`).
- The proxy forwards requests to your configured upstream API URL.
- Authentication: the proxy tries `Authorization: Bearer <key>` first, then retries with `X-API-Key` on a 401.
- OpenRouter is detected automatically and the required `HTTP-Referer` / `X-Title` headers are added.
- The proxy accepts payloads up to 50 MB to support base64-encoded vision requests.

---

## Project Structure

```
index.html                  — UI shell
src/
  scripts/
    main.js                 — App controller and event binding
    app-ui.js               — UI helpers (notifications, streaming, state buttons)
    character-generator.js  — Character prompt templates and response parsing
    character-display.js    — Field display, edit, reset, import, remaster
    revision-handler.js     — AI revision, reduce bloat, consistency check/auto-fix
    alt-greetings-handler.js — Alternate greetings CRUD and AI generation
    lorebook-handler.js     — Lorebook CRUD, AI topic/entry generation, lore elevation modal
    library-handler.js      — Save/load/delete prompts & cards from the library
    image-handler.js        — Image generate/upload, reference image, model fetch
    image-generator.js      — Image prompt generation logic
    lorebook-generator.js   — Lorebook AI generation (standalone module)
    png-encoder.js          — Embed chara_card_v2 metadata into PNG files
    api.js                  — APIHandler base (request, streaming, retry, abort)
    api-character.js        — Character generation, revision, and field-regeneration prompts
    api-image.js            — Image generation methods
    api-lorebook.js         — Lorebook/alt-greeting/consistency/card-scan API methods
    config.js               — Config management (localStorage + server sync)
    storage.js              — Server-side library storage (cards and prompts)
  styles/
    main.css                — Application styles
proxy/
  server.js                 — Express proxy (text, image, config, library, CORS)
  data/                     — Runtime data directory (gitignored)
    cards.json              — Saved card library (auto-created)
    prompts.json            — Saved prompt library (auto-created)
    config.json             — Persisted API settings (auto-created)
```

---

## License

MIT. See `LICENSE`.
