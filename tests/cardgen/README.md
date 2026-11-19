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

`stack.js` is the shared stack: `model.hold(kind)` pauses a model reply mid-stream so a test can
close the page at that point (a discarded tab), then `release()` lets the proxy finish on its own.
What these cannot show is real iOS behaviour: a frozen page, a real lock, Safari's own discard.
