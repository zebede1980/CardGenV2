# Character Gen tests

These run the **real** `proxy/server.js` (a staged copy with its own data folder) against a fake
Python backend and a fake streaming model, with a static server in front doing nginx's job. The
browser tests drive the real `index.html` in headless WebKit at iPhone width.

Nothing here is installed by the project. You need, once, somewhere outside the repo:

```bash
mkdir -p ~/cardgen-test-deps && cd ~/cardgen-test-deps
npm init -y && npm i playwright-core
npx playwright-core install webkit
mkdir proxydeps && cp <repo>/proxy/package*.json proxydeps/ && (cd proxydeps && npm ci --omit=dev)
```

Then, from the repo root:

```bash
node tests/cardgen/parser.test.js
PLAYWRIGHT_CORE=~/cardgen-test-deps/node_modules/playwright-core \
PROXY_NODE_MODULES=~/cardgen-test-deps/proxydeps/node_modules \
node tests/cardgen/phase0.test.js
```

The same two variables run the rest:

| File | Browser? | What it covers |
|---|---|---|
| `parser.test.js` | no | the card parser |
| `runs.test.js` | no | the run engine through the real proxy: a whole card with nobody watching, stop, resume, a proxy restart mid-run, errors, limits |
| `phase0.test.js` | WebKit | History drafts, recovery after a discarded tab, streamed single calls (setting off) |
| `landing.test.js` | WebKit | a picture nobody collected is saved to History with its card: page gone, collected in time, confirmed, landed on request, two tabs; and a replaced page: the open card back (unsaved text too), its pictures offered to pick (finished, still drawing, Compare Models), closed early → History, another card's → History |
| `playground.test.js` | WebKit | Image Playground: every picture kept in Recent for 3 days (also when the tab closes mid-draw), expiry and the count cap, other users refused; prompt history in the presets dropdowns; Library's Saved/Recent views, 💾 Keep, 🗑️; 2 per model; tool tabs above the drop zone; 🔍 Describe |
| `extend.test.js` | both | Playground ⤢ Extend against a fake ComfyUI: the AnyPaint graph (two passes when there is room on both axes), canvas maths (shape, position, extra room, 1–1.5 MP, multiples of 16), refusals before the GPU or a paid call, failures, kept in Recent; then the page at 390 / 320 dark: the frame, drag, tap, 3×3 buttons, settings remembered, the big-extension warning and ✍️ Describe it, extend from the page, the tab closed mid-draw |
| `edit-modes.test.js` | WebKit | Playground ✨ Edit's two modes: ✏️ Change it and 🔄 New shot (the old Reimagine tab) — what each shows, angle buttons worded per mode, a model per mode, a New shot run (prompt written once, one picture with the source), a Change it run (no prompt call), the mode remembered, old links to Reimagine land on New shot; 390 and 320 dark |
| `paint.test.js` | both | ✨ Edit → 🖌️ Paint an area, against a fake ComfyUI (`fake-comfy.js`, shared with `extend.test.js`): the paste-back graph on Qwen and FIBO, refusals (hosted model, no mask, bad mask, can't edit) before any GPU or paid call; then the page at 390 / 320 dark: painting with a pointer and a finger, undo, erase, clear, brush sizes, the local-model rule, the mask sent (white where painted), the mask kept for a same-size result and cleared for another size, Stop painting, the tab closed mid-edit |
| `lightbox.test.js` | WebKit | the lightbox: full-screen picture area, pinch and pan from anywhere, max zoom from the picture's pixels, tap hides the toolbar, tap off closes, swipe; mouse at 1280 px |
| `story-setup.test.js` | WebKit | Story Writer's New story sheet: ✍️ Freeform (opening written at once, then Continue with a steer) and the planned lengths (an autowrite run); Story Writer's backend faked in the browser |
| `image-jobs.test.js` | no | an image request sent again under the same clientRef joins the job drawing it or gets the finished picture (one model call); a failed job starts afresh; `/api/jobs?clientRef=` puts done before running before failed |
| `home-browse.test.js` | both | Home's character browser: the light card list, text search and WebP thumbnails through the proxy; the 🏷️ tagging run (nobody watching, three at a time, Stop, a restart, five failures in a row, a refused key, another user); then the page at 390 / 320 dark / 1280: the grid growing as you scroll, the sticky bar, search ranking, 📝 Descriptions, tag and used filters, sorts remembered, the card sheet, tagging from the page with the page hidden |
| `persona.test.js` | both | 🎭 personas: a persona card saved and loaded with its type and extras (and an older page's save not undoing it), the light lists, a server run that writes a persona (no finishing fields, no cast) and one that rewrites a character as a persona; then the page: Character Gen's persona type, the shared persona picker (default, remembered per character, cast greyed, Just a name, ☆ default, ✨ New saved as typed or written on the server with the page hidden and with the tab discarded), Roleplay Chat and Messenger sending the persona card, Home's 🎭 chip and sheet |
| `runs-page.test.js` | WebKit | card runs from the page: hidden page, discarded tab, attach on reload, Stop, restart, two devices; and that the proxy's prompt host builds the same requests as the page |

`stack.js` is the shared stack: `model.hold(kind)` pauses a model reply mid-stream so a test can
close the page at that point (a discarded tab), then `release()` lets the proxy finish on its own.
What these cannot show is real iOS behaviour: a frozen page, a real lock, Safari's own discard.
