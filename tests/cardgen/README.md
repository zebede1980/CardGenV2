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
| `lightbox.test.js` | WebKit | the lightbox: full-screen picture area, pinch and pan from anywhere, max zoom from the picture's pixels, tap hides the toolbar, tap off closes, swipe; mouse at 1280 px |
| `story-setup.test.js` | WebKit | Story Writer's New story sheet: ✍️ Freeform (opening written at once, then Continue with a steer) and the planned lengths (an autowrite run); Story Writer's backend faked in the browser |
| `image-jobs.test.js` | no | an image request sent again under the same clientRef joins the job drawing it or gets the finished picture (one model call); a failed job starts afresh; `/api/jobs?clientRef=` puts done before running before failed |
| `home-browse.test.js` | both | Home's character browser: the light card list, text search and WebP thumbnails through the proxy; the 🏷️ tagging run (nobody watching, three at a time, Stop, a restart, five failures in a row, a refused key, another user); then the page at 390 / 320 dark / 1280: the grid growing as you scroll, the sticky bar, search ranking, 📝 Descriptions, tag and used filters, sorts remembered, the card sheet, tagging from the page with the page hidden |
| `runs-page.test.js` | WebKit | card runs from the page: hidden page, discarded tab, attach on reload, Stop, restart, two devices; and that the proxy's prompt host builds the same requests as the page |

`stack.js` is the shared stack: `model.hold(kind)` pauses a model reply mid-stream so a test can
close the page at that point (a discarded tab), then `release()` lets the proxy finish on its own.
What these cannot show is real iOS behaviour: a frozen page, a real lock, Safari's own discard.
