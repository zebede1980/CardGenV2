# SillyTavern Character Generator (v2)

<img width="1374" height="1104" alt="image" src="https://github.com/user-attachments/assets/dabf24ec-7b8b-459a-9cc9-63e122569f76" />

Web app for generating, editing, importing, revising, and exporting SillyTavern character cards (Spec V2 `.png` / `.json`).

Cards are designed as **concise AI-guidance** — clear behavioural direction and character description that an AI can use to portray the character, not prose fiction. The generation prompts, revision tools, and card-quality tools all enforce this principle.

---

## Table of Contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
  - [Docker Compose (Recommended)](#docker-compose-recommended)
  - [Local (Dev)](#local-dev)
  - [Local (Production-like)](#local-production-like)
- [Configuration](#configuration)
  - [Environment Variables](#environment-variables)
  - [In-App API Settings](#in-app-api-settings)
  - [Brave Search API Setup](#brave-search-api-setup-optional)
- [Usage](#usage)
  - [Basic Generation Workflow](#basic-generation-workflow)
  - [Web Search for Real/Fictional Characters](#web-search-for-realfictional-characters)
  - [SillyTavern Bridge Workflow](#sillytavern-bridge-workflow)
- [Card Design Philosophy](#card-design-philosophy)
- [API Compatibility Notes](#api-compatibility-notes)
- [Docker Notes](#docker-notes)
- [Project Structure](#project-structure)
- [License](#license)

---

## Features

### Character Generation
- Generate a full character card from a free-text concept description.
- Optional fixed character name, or let the AI generate one grounded in the character's background and time period.
- **First-person** (`I am...`) or **third-person** (`She is...`) POV templates.
- Optional lorebook (SillyTavern World Info JSON) uploaded as grounding context at generation time.
- Optional reference image upload — auto-described by a vision model if configured, or manually entered as text.
- Streaming generation with **Stop** support at any point.
- Generated cards use short prose for backstory/scenario and direct bullet points for traits and behaviours — not padded narrative.
- Tag field: add comma-separated tags that are preserved in the exported card and shown in the SillyTavern library.

### 🔍 Web Search for Real / Fictional Characters *(new)*
- Switch to **🔍 Web Search Mode** via the radio buttons at the top of the inputs section.
- Enter the character's name in the **"Search For"** field (e.g. `"Ellen Ripley from Alien"`, `"Beyonce"`, `"Tony Stark from Iron Man"`).
- Optionally describe a **"Scenario / Context"** — this is passed directly to the LLM without being searched, so you control the setup while the AI handles the character's canonical details.
- The proxy runs 5 targeted Brave Search queries (biography, personality, physical appearance, Wikipedia, fandom/person-profile) and feeds verified details into the LLM prompt as ground truth.
- Produces accurate character cards — the AI generates personality, appearance, and backstory from search results while using your scenario as the roleplay setup.
- Gracefully falls back to normal LLM-only generation if search is unavailable or returns no results.

### Import & Edit
- Import existing cards (`.png` with embedded `chara_card_v2` data, or `.json`) and edit them in-place.
- **Import & Remaster** — import a card and immediately run an AI rewrite pass that fixes inconsistencies, tightens language, and brings the card in line with the conciseness standard.
- Per-field **Redo** buttons regenerate any single section with AI; an optional instruction box lets you guide the rewrite.
- Per-field **Reset** buttons revert a section back to the last generated or imported baseline, discarding manual edits.
- All fields (name, description, personality, scenario, first message, example messages, tags) are directly editable in the text areas at any time.
- **🌐 Import from URL** — paste a JanitorAI or Chub.ai character page URL to scrape and convert to Spec V2.

### Batch Generation *(new)*
- Click **🎲 Generate 4** to create four character variants from one concept in parallel.
- Results are displayed in a side-by-side comparison grid.
- Click **⭐ Pick This** on any variant to load it into the editor.
- The first variant streams live; the other three generate silently in the background.

### AI Revision Tools
- **Revise Card with AI** — apply a free-text instruction to rewrite the whole card (e.g. "make her more guarded and less verbose").
- **✂️ Reduce Bloat** — two-in-one tool:
  1. Scans the card with AI and presents a checklist of world-building content (locations, NPCs, factions, historical events) that belongs in the lorebook rather than the card body. You choose what to move.
  2. Strips all flowery prose and repetition from what remains, leaving only direct AI-guidance.
- **📚 Scan for Lorebook Content** — runs only the lorebook-elevation scan without the bloat-reduction pass. Useful when a card is already concise but you want to clean up embedded lore.
- **🔍 Check Consistency** — AI reviews the card for logical contradictions, tonal mismatches, or continuity errors and produces a written report in a modal.
- **✨ Auto-Fix** — automatically applies the fixes suggested by the last consistency report without requiring manual editing.

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
- AI generates an image prompt from the character description (up to ~1000 characters), displayed in an editable text box.
- Regenerate the prompt or the image independently.
- **Generate 4 (Models)** — generates one image per saved model simultaneously for a side-by-side style comparison.
- **Generate 4 (Variations)** — generates four prompt variations from the active model.
- **Free image generation via Pollinations.ai** — generates images without any API key or account; uses the Flux model by default with configurable width, height, and random seed.
- Upload your own image instead of AI-generating one.
- **Image Gallery / Lightbox** *(new)* — click any generated image to view full-screen with zoom, previous/next navigation, and keyboard support.
- CORS-bypass proxy routes all image requests through the backend to avoid browser restrictions.
- Image prompt character count is displayed live to help you stay within model limits.

### Chat Tester
- Test your character in a live chat simulation before exporting.
- Adjustable temperature and top_p sliders to control creativity.
- Save and load chat transcripts.
- Persona selector to test how the character responds to different user personalities.
- Lorebook trigger highlighting shows which entries fired during the conversation.

### Story Writer & TTS Narration *(new)*
- A dedicated workspace to write continuous stories with your generated characters.
- Steer the story chunk-by-chunk with custom prompts, or let the AI continue naturally.
- **Text-to-Speech (TTS) Narration**: Read story segments aloud seamlessly.
- **Auto Mode**: Perfectly pipelined background generation automatically requests and narrates the next chunk of the story for a hands-free listening experience.
- **Multiple TTS Providers**:
  - **Local Coqui TTS**: Runs entirely locally via an optional Docker container (free, private).
  - **Google Cloud TTS**: Supports both Standard and Premium (Neural2 / WaveNet) voices via Google API key.
- **Mobile/iOS Native Support**: Integrates with the HTML5 Media Session API, allowing uninterrupted background audio playback and lock-screen controls (Pause, Skip, Stop) on mobile devices.

### Roleplay Chat (Multi-Character & Dynamic Memory) *(new)*
- **Immersive Multi-Character Sessions**: Create chat sessions containing one or multiple characters simultaneously.
- **Dialogue Auto-Routing**: In group chats, the AI automatically routes responses to the most appropriate character based on the conversation context, or you can manually select the next speaker using the dropdown.
- **Dynamic Context Window Management**:
  - **Auto-Summarization**: Older chat history is periodically compiled in the background into a running "Story Summary" to conserve context space and prevent memory drift.
  - **Auto-Fact Extraction (Memory Book)**: An AI background task scans history every 10 messages to maintain a checklist of permanent facts (items gained/lost, locations, relationship shifts), injecting them into future turns.
- **User Personas**: Choose to roleplay using a custom text-based persona or pick an existing character card from your library to represent yourself.
- **Steering & Impersonation**:
  - **OOC Notes**: Inline Out-of-Character director notes let you guide character actions, tone, or scene progression.
  - **Impersonate Mode**: Have the AI write a draft response for you, which streams directly into your input area for editing before sending.
- **Inline Scene Image Generation**: Generate visual scene illustrations directly in the chat. The system analyzes recent context and character cards to create prompts and displays generated images inline.
- **Rich UI Component Rendering**: Supports interactive graphical elements rendered beautifully in the timeline:
  - `<text-message>`: Styled smartphone/SMS messages.
  - `<stat-bar>`: Progress indicators, health bars, or states (e.g., Health: 80/100, Quest: Active).
  - `<task>`: Clear, styled quest or objective checklists.
- **Alternate Greeting Switcher**: In single-character chats, select and apply alternate greetings defined in the character card directly.
- **Modular System Prompts**: Global settings allow you to drag-and-drop, edit, and add custom prompt segments that are combined into a system prompt for new chat sessions.

### SillyTavern Bridge
- Configure a SillyTavern base URL in API Settings to connect directly to a running ST instance.
- **Test Connection** — verifies connectivity and reports how many characters are in ST.
- **Browse ST Library** — lists all characters in your ST instance with thumbnails, tags, date added, and a short description snippet. Sorted most-recent-first.
- **Load from ST** — pull any ST character card directly into the editor using the same import pipeline as a file drop. The source slot is remembered for push-back.
- **Push to ST** — send the current card to SillyTavern as a new character or as an update to the card it was loaded from. If the character name changed, a modal prompts you to choose between updating the original slot or creating a new one.
- CSRF token negotiation is handled automatically and cached per session (10-minute TTL with auto-invalidation on 403).

### Library & History
- **Server-side library** — prompts and cards are auto-saved to `proxy/data/` after every generation and revision. A manual **Save to Library** button is also available.
- **Snapshot to History** — save the current card state as a named history entry at any point (visible while a card is loaded); useful for tracking incremental changes.
- Load or delete any saved prompt or card from the Library tab in the UI.
- Concurrent writes are serialised with a per-file mutex to prevent data corruption.
- Data persists across restarts when using Docker volumes.

### Export
- **Download Character Card (PNG)** — SillyTavern-compatible PNG with embedded `chara_card_v2` metadata. Lorebook, alternate greetings, example messages, and tags are all included.
- **Download as JSON** — raw `chara_card_v2` structure without image embedding.

### Token Counter
- Live token-count estimate displayed per field (name, description, personality, scenario, first message, example messages).
- Lorebook and alternate greetings are included in the running **total** shown at the bottom of the card, helping you keep the full card lean.

---

## Requirements

- Node.js 18+ (for local dev; Docker image uses Node 18 Alpine)
- OpenAI-compatible text API endpoint (required)
- OpenAI-compatible image API endpoint (optional — or use the built-in Pollinations.ai free tier)
- Vision-capable text model (optional — only needed for reference-image auto-description)
- Brave Search API key (optional — only needed for the Web Search feature)

---

## Installation

### Docker Compose (Recommended)

The easiest way to run the full stack (frontend Nginx + proxy + story writer backend + PostgreSQL) with persistent data:

```bash
# 1. Clone or copy the project
cd CardGenV2

# 2. Create environment file
cp .env.example .env

# 3. Edit .env with your settings (see Configuration section below)
nano .env

# 4. Build and start all services
docker compose up -d --build

# 5. Check proxy is healthy
curl http://localhost:2426/health
```

**Access points:**
- Frontend: `http://localhost:2427` (or your `FRONTEND_PORT`)
- Proxy health: `http://localhost:2426/health` (or your `PROXY_PORT`)

**Stop / Restart:**
```bash
docker compose down          # Stop all containers
docker compose up -d         # Start existing containers
docker compose logs -f proxy # Watch proxy logs
```

### Local (Dev)

Use this when you want hot-reload and automatic browser open:

```bash
# 1. Install root dependencies (frontend dev server)
npm install

# 2. Install proxy dependencies
cd proxy && npm install && cd ..

# 3. Start both frontend and proxy in parallel
npm run dev
```

- Frontend: `http://localhost:2427` (opens automatically)
- Proxy API: `http://localhost:2426`

The dev frontend (`http-server`) proxies `/api/*` requests to the proxy server automatically.

### Local (Production-like)

Use this when you want the same static-file serving as Docker but without containers:

```bash
npm install
npm start
```

This starts both the proxy and the frontend via `concurrently`.

---

## Configuration

### Environment Variables

Create a `.env` file in the project root (next to `docker-compose.yml`) to override defaults without editing the compose file.

| Variable | Default | Description |
|---|---|---|
| `FRONTEND_PORT` | `2427` | Host port mapped to the Nginx frontend container |
| `PROXY_PORT` | `2426` | Host port for the Node.js proxy server |
| `FRONTEND_URL` | `http://localhost:2427` | Origin sent in CORS headers and OpenRouter `HTTP-Referer` |
| `JWT_SECRET` | *(insecure default)* | Secret for signing auth tokens. **Change this in production!** |
| `ALLOW_REGISTRATION` | `false` | Set to `true` to allow new user sign-ups |
| `STORY_APP_URL` | `http://storywriterbackend:8000` | Internal URL for the Story Writer backend |
| `STORY_APP_PUBLIC_URL` | *(empty)* | Public URL shown in the browser for Story Writer |
| `INTERNAL_API_SECRET` | *(insecure default)* | Shared secret between proxy and Story Writer backend. **Change this!** |
| `BRAVE_SEARCH_API_KEY` | *(empty)* | Your Brave Search API key — enables the Web Search feature |
| `BRAVE_SEARCH_ENABLED` | `true` | Set to `false` to disable search even if a key is configured |

**Example `.env`:**
```env
FRONTEND_PORT=2427
PROXY_PORT=2426
FRONTEND_URL=http://localhost:2427
JWT_SECRET=change-this-to-a-long-random-string
ALLOW_REGISTRATION=false
INTERNAL_API_SECRET=another-long-random-string
BRAVE_SEARCH_API_KEY=your-brave-search-api-key
```

### Authentication & Access Control

The application contains a built-in user authentication system. Each registered user has their own independent workspace, which includes:
- Personal API settings (`config.json`)
- Saved cards (`cards.json`) and prompts (`prompts.json`)
- Chat history, story history, and personas

#### 1. First-Time Setup (Creating Your Account)
On a fresh install, there are no users in the database, and registrations are disabled by default. Follow these steps to set up your first user:
1. In your `.env` file, set:
   ```env
   ALLOW_REGISTRATION=true
   ```
2. Restart the application to apply the environment configuration:
   ```bash
   docker compose up -d --build
   ```
3. Open the web interface, click **Sign Up** in the login window overlay, and create your account.

#### 2. Creating the Special "admin" Account
It is highly recommended that you register the username **`admin`** (case-insensitive) as your very first account.
- The `admin` username is treated specially by the proxy server.
- Only the `admin` user has administrative privileges to change other users' passwords in the app.
- When logged in as `admin`, the **Change Password** dialog (accessed from the user profile bar) will display an extra **Target Username (Admin Only)** input field. This allows you to reset or update any other user's password directly without knowing their current password.

#### 3. Disabling Public Registrations
Once your user account(s) have been successfully registered:
1. Edit your `.env` file and set registration back to `false`:
   ```env
   ALLOW_REGISTRATION=false
   ```
2. Restart the proxy service:
   ```bash
   docker compose restart proxy
   ```
   This will completely disable the registration endpoint and hide the **Sign Up** link, ensuring your instance is private and secure.

### In-App API Settings

All settings are saved server-side to `proxy/data/config.json` via `POST /api/config` and also mirrored to `localStorage`. They persist across page reloads and container restarts.

#### Text API

| Setting | Notes |
|---|---|
| Text API Base URL | OpenAI-compatible endpoint root (e.g. `https://api.openai.com/v1`, `https://openrouter.ai/api/v1`, or a local Ollama/LM Studio URL) |
| Text API Key | Sent as `Authorization: Bearer <key>`; falls back to `X-API-Key` on 401 |
| Text Model | Model identifier used for all generation, revision, and analysis calls |
| Vision Model | Optional separate model for auto-describing reference images; falls back to Text Model if blank |

#### Image API

| Setting | Notes |
|---|---|
| Image API Base URL | OpenAI-compatible images endpoint root. Leave blank to use the free Pollinations.ai tier |
| Image API Key | Optional; required if your image provider needs authentication |
| Image Models | Multi-select checklist — tick one or more models. All ticked models are used when you click **Generate 4 (Models)** |
| Image Size | e.g. `1024x1024`, `768x1024` — passed to the upstream API |
| Image Style | Optional style hint forwarded to the API (e.g. `vivid`, `natural`) |
| Enable Image Generation | Toggle to show/hide all image controls |

#### TTS Narration (Story Writer)

Configured directly within the **⚙️ Generation Settings** panel in the Story Writer tab. Settings are saved centrally to your profile.

| Setting | Notes |
|---|---|
| Provider | Choose between **Local Coqui TTS**, **Google Cloud (Standard)**, **Google Cloud (Premium)**, or **nano-gpt.com**. |
| Google API Key | Required only if a Google provider is selected. Ensure your key has the *Cloud Text-to-Speech API* enabled and a linked billing account (even for free tier limits). |
| **nano-gpt.com API Key** | **Required only if the nano-gpt.com provider is selected.** |
| Voice | Select from available voices. Automatically fetches the list from your active provider. For nano-gpt.com, this selects the underlying TTS model (e.g., `elevenlabs-multilingual-v2`, `kokoro-82m`). |

#### SillyTavern Bridge

| Setting | Notes |
|---|---|
| SillyTavern Base URL | Internal URL of your ST instance (e.g. `http://sillytavern:8000` for Docker-to-Docker, or `http://localhost:8000` for local). Must be reachable from the **proxy container**, not the browser |

#### Advanced / Debug

| Setting | Notes |
|---|---|
| Debug Mode | Toggles verbose `console.log` output in the browser and proxy. Off by default |

### Brave Search API Setup (Optional)

The **🔍 Search Web for Details** feature uses the Brave Search API to look up real people and fictional characters:

1. Sign up at https://brave.com/search/api/
2. Select the **"Search" Data-for-AI plan** (not "Answers")
3. The free tier gives you **1,000 queries/month** — enough for low usage
4. Copy your API key and add it to your `.env`:
   ```env
   BRAVE_SEARCH_API_KEY=BSxxxxxxxxxxxxxxxxxxxxxxxxx
   ```
5. Restart the proxy container:
   ```bash
   docker compose restart proxy
   ```
6. Proxy startup logs will show: `🔍 Character Web Search enabled (Brave Search API)`

> **Privacy note:** Search queries are performed server-side by the proxy. Your API key never reaches the browser.

---

## Usage

### Choosing a Mode

Use the **⏺ Classic Mode / 🔍 Web Search Mode** radio buttons at the top of the Character Generation Inputs section to switch between two workflows.

### Classic Mode

1. Open **API Settings** (gear icon) and configure your text API endpoint, key, and model.
2. Enter a **Character Concept** in the text box. Be as detailed or as brief as you like.
3. Optionally set a **Character Name** (or leave blank for the AI to generate one).
4. Choose **POV** — first-person or third-person.
5. Optionally upload a **Lorebook JSON** (World Info) as grounding context for generation.
6. Optionally upload a **Reference Image** — it will be auto-described if a vision model is set.
7. Click **✨ Generate 1** and watch the card stream in. Click **⏹ Stop** at any time to halt generation.
8. Or click **🎲 Generate 4** to create four variants and pick your favourite from the comparison grid.
9. Edit any field directly in the text areas. Use **Redo** to regenerate a single section with optional instruction, or **Reset** to revert to the last generated/imported baseline.
10. Use the **Revision Tools** to refine the card:
    - **Reduce Bloat** to move lore to the lorebook and strip prose padding.
    - **Scan for Lorebook Content** to elevate lore without the bloat pass.
    - **Revise Card** for any specific free-text change instruction.
    - **Check Consistency** + **Auto-Fix** for logic and continuity issues.
11. Open the **Lorebook Manager** to add world-building entries, or let the AI suggest and generate them.
12. Open **Alternate Greetings** to add alternative opening scenes.
13. Generate **Example Messages** — they are embedded in the exported card automatically.
14. Optionally click **Snapshot to History** to save the current state as a named checkpoint.
15. Click **Download Character Card (PNG)** to export, or use **Download as JSON** if you don't need an image.

### Web Search Mode

Use this when you want an accurate card based on a real person or an established fictional character:

1. Select **🔍 Web Search Mode** at the top of the inputs section.
2. Enter the character name in the **Search For** field — e.g. `"Ellen Ripley from Alien"`, `"Beyonce"`, `"Tony Stark from Iron Man"`.
3. Optionally enter a **Scenario / Context** — e.g. `"You meet her at a seedy spaceport bar"`. This is NOT web-searched; it's passed directly to the LLM as the roleplay setup.
4. Fill in any other optional fields (Character Name, Reference Image, Lorebook, POV, Card Type) as desired.
5. Click **✨ Generate 1** (or **🎲 Generate 4**).
6. The app runs 5 targeted Brave Search queries for biography, personality, physical appearance, and encyclopedia/fandom data.
7. Search results are injected into the LLM prompt as verified ground truth, while your scenario sets the roleplay context.
8. If the search fails or returns nothing, the app silently falls back to normal LLM-only generation using your scenario as a concept.

### SillyTavern Bridge Workflow

1. In **API Settings**, enter your SillyTavern instance URL and click **Test Connection**.
2. Open the **SillyTavern** tab in the Library panel to browse your ST character list.
3. Click **Load** on any card to pull it into the editor (it passes through the full import pipeline).
4. Edit, revise, or remaster the card as needed.
5. Click **Push to SillyTavern** to send it back — it will update the original slot (or create a new character if you choose).

### Roleplay Chat Workflow

1. Click the **💬 Roleplay Chat** tab at the top of the interface.
2. Click **➕ New Chat** to configure a new session.
3. In the setup modal:
   - Enter a **Title** for the session.
   - Click **Add Character** to select one or more character cards from your saved library.
   - Select your **User Persona**: choose **Manual** to fill in a quick name/age/gender/details description, or **Card** to select an existing card from your library to represent you.
   - (Optional) Customize the starting **System Prompt** (pre-loaded with your default segments).
   - Click **Create Chat**.
4. Single-character sessions will automatically start with the character's first message (or alternate greetings displayed as a system note).
5. In multi-character sessions, the AI will automatically route responses to the most logical speaker. You can override this or force a reply from a specific character using the **Speaker Select** dropdown next to the send button.
6. Use **Impersonate** (user-ghost icon) to draft a response from the user's perspective, or use **OOC** (Out-of-Character) notes to instruct the AI directly.
7. Click **Generate Image** (image icon) on any message to create a visual illustration of the scene.
8. Customize settings like Max Input/Output tokens, Temperature, Repetition Penalty, and reorder modular system prompt segments globally by clicking **⚙️ Settings** in the chat sidebar.

---

## Card Design Philosophy

Character cards in SillyTavern are loaded into the AI's context on every message. Long, flowery cards inflate token costs and can reduce coherence. This tool generates cards that follow a clear standard:

- **Short prose** for backstory and scenario (factual, 2–3 paragraphs max).
- **Bullet points** for personality traits, behavioural patterns, speech style, goals, fears, and limits.
- **No padding** — every sentence must serve a direct descriptive or behavioural function.
- **Lorebook for lore** — world-building detail (locations, factions, history) should live in lorebook entries that inject only when triggered, not in the card body.

The **Reduce Bloat** and **Scan for Lorebook Content** tools help you bring imported or older cards in line with this standard.

---

## API Compatibility Notes

- The browser talks only to the local proxy (`/api/...`). Your API keys are never sent from the browser directly to external services.
- The proxy forwards requests to your configured upstream URL, handles auth, and streams responses back.
- **Authentication:** the proxy tries `Authorization: Bearer <key>` first, then retries with `X-API-Key` on a 401.
- **OpenRouter:** detected automatically via the URL; required `HTTP-Referer` and `X-Title` headers are added.
- **Image APIs:** the full request body is forwarded as-is, so provider-specific fields (e.g. `n`, `response_format`, `steps`) work without any proxy changes.
- **Payload limit:** the proxy accepts up to 50 MB per request to accommodate base64-encoded vision payloads.
- **Free images:** the Pollinations.ai route (`/api/image/free`) requires no API key — the proxy fetches the image server-side and pipes it to the browser.

---

## Docker Notes

### Local TTS Service (Coqui)

If you want to use the **Local Coqui TTS** provider in the Story Writer, you need to run the optional `tts` Docker service alongside your proxy and frontend.
- Ensure your `docker-compose.yml` includes the `tts` service block (exposing port `8500`).
- The required TTS models are automatically downloaded on first run and stored in the `./tts-models` host volume.
- GPU acceleration (via NVIDIA Container Toolkit) is highly recommended for real-time local narration, though modern CPUs can also keep up with reading pace.
- Note: The Google Cloud TTS option routes through the proxy and does **not** require this container to be running.

### Networking with SillyTavern

If you run SillyTavern and this app in the same Docker Compose project or on the same Docker network, you can use the container name as the hostname in the ST Base URL field (e.g. `http://sillytavern:8000`). The proxy container makes the request — the browser never needs to reach ST directly.

To connect to an externally-managed ST container, add a shared external network to your `docker-compose.yml`:

```yaml
networks:
  app-network:
    external: true
    name: sillytavern_default   # replace with your ST network name
```

Then ensure the `app-network` entry is listed under both the `frontend` and `proxy` services.

### Data Persistence

The `./proxy/data` host directory contains three auto-created JSON files:

| File | Contents |
|---|---|
| `config.json` | API keys, model names, and all in-app settings |
| `cards.json` | Saved card library |
| `prompts.json` | Saved prompt library |

Back up this directory before upgrading or rebuilding containers.

### Nginx Logs

The frontend container writes Nginx access and error logs to `./logs/` on the host (mapped via the volume in `docker-compose.yml`). This directory is created automatically on first run.

---

## Project Structure

```
index.html                   — UI shell
src/
  scripts/
    main.js                  — App controller and event binding
    app-ui.js                — UI helpers (notifications, streaming, state buttons)
    api.js                   — APIHandler base (request, streaming, retry, abort)
    api-character.js         — Character generation, revision, and field-regeneration prompts
    api-image.js             — Image generation methods
    api-lorebook.js          — Lorebook/alt-greeting/consistency/card-scan API methods
    auth.js                  — Client-side authentication
    config.js                — Config management (localStorage + server sync)
    storage.js               — Server-side library storage (cards and prompts)
    character-generator.js   — Character prompt templates and response parsing
    character-search.js      — Web search orchestration (Brave Search API)
    character-display.js     — Field display, edit, reset, import, remaster, tags
    revision-handler.js      — AI revision, reduce bloat, consistency check/auto-fix
    alt-greetings-handler.js — Alternate greetings CRUD and AI generation
    lorebook-handler.js      — Lorebook CRUD, AI topic/entry generation, lore elevation modal
    lorebook-generator.js    — Lorebook AI generation (standalone module)
    library-handler.js       — Save/load/delete prompts & cards; snapshot to history
    image-handler.js         — Image generate/upload, reference image, model fetch
    image-generator.js       — Image prompt generation logic
    image-gallery.js         — Full-screen lightbox for generated images
    st-handler.js            — SillyTavern bridge (browse, load, push characters)
    chat-handler.js          — Roleplay Chat frontend controller and state manager (Multi-Character / settings / OOC / images)
    chat-settings.js         — Roleplay Chat configuration settings dialog helpers
    chat-tester.js           — Chat tester utility for single-character simulation with custom settings
    chat-ui.js               — Chat timeline rendering, message actions, and XML rich components
    rich-element-parser.js   — Parser for embedding graphical XML components like phone chats, task cards, and stat-bars
    png-encoder.js           — Embed Spec V2 character card metadata into PNG files
    batch-generator.js       — Parallel variant comparison grid (Generate 4 cards at once)
    url-import.js            — Scraping/importing characters from JanitorAI and Chub.ai URLs
    gallery-mode.js          — Controls character library gallery mode UI
    home-handler.js          — Handles homepage landing layout and character gallery preview
    inspire-me.js            — "Inspire Me" randomized character generator
    storywriter.js           — Full Story Writer UI workspace and client controller
    sanitize.js              — Security utility for sanitizing text inputs
 styles/
    main.css                 — Application styles
proxy/
  server.js                  — Express proxy (text, image, config, library, ST bridge, search, CORS)
  data/                      — Runtime data directory (gitignored)
    cards.json               — Saved card library (auto-created)
    prompts.json             — Saved prompt library (auto-created)
    config.json              — Persisted API settings (auto-created)
storywriterbackend/          — Integrated Story Writer backend (Python/FastAPI)
  app/
    routers/                 — FastAPI route handlers
    services/                — LLM service, context manager, card parser
```

---

## License

MIT. See `LICENSE`.
