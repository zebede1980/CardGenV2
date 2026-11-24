// Home's character browser and 🏷️ Tag untagged. Two halves:
//  1. No browser: the proxy's light card list, text search and thumbnails, and
//     the tagging run (proxy/runs/tag-runs.js) through the real proxy: nobody
//     watching, stop, a proxy restart, failures, another user.
//  2. The real page in headless WebKit (390 light, 320 dark, 1280): the grid
//     growing as you scroll, the sticky bar, search, sort, filters, the card
//     sheet, and tagging from the page, including a hidden page.
// See README.md for the two environment variables.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { start, sleep } = require("./stack");

const repo = path.resolve(__dirname, "..", "..");
const sharp = require(path.join(process.env.PROXY_NODE_MODULES || path.join(repo, "proxy", "node_modules"), "sharp"));
let failed = 0, passed = 0;
const check = (name, ok, detail = "") => {
  if (ok) { passed++; console.log("ok   " + name); }
  else { failed++; console.log("FAIL " + name + (detail ? "\n     " + String(detail).slice(0, 500) : "")); }
};

async function waitFor(fn, ms = 15000, step = 50) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await sleep(step);
  }
}

/** A real picture in the proxy's card-images folder for this card. */
async function givePortrait(stack, userId, cardId, { width = 900, height = 1200, color = { r: 200, g: 80, b: 60 } } = {}) {
  const dir = path.join(stack.dataDir, "users", String(userId), "card-images");
  fs.mkdirSync(dir, { recursive: true });
  const png = await sharp({ create: { width, height, channels: 3, background: color } }).png({ compressionLevel: 0 }).toBuffer();
  fs.writeFileSync(path.join(dir, `${cardId}.img`), png);
  fs.writeFileSync(path.join(dir, `${cardId}.mime`), "image/png");
  return png;
}

async function rawGet(stack, p, token, headers = {}) {
  const res = await fetch(stack.url + p, { headers: { Authorization: `Bearer ${token}`, ...headers } });
  return { status: res.status, type: res.headers.get("content-type"), etag: res.headers.get("etag"), body: Buffer.from(await res.arrayBuffer()) };
}

const untagged = (stack, userId) => [...stack.backend.cards(userId).values()].filter((c) => !String(c.tags || "").trim());

async function proxyHalf(stack) {
  const { api, token, userId, backend, model } = stack;

  // ── The light list ──
  const mira = backend.addCard(userId, { name: "Mira Okafor", description: "A lighthouse keeper with a blonde braid.", tags: "female,modern", uses: 3, last_used_at: "2026-11-20T10:00:00" });
  const jory = backend.addCard(userId, { name: "Jory Penrose", description: "An apprentice.", character_book: '{"entries":[1]}' });
  const original = await givePortrait(stack, userId, mira.id);
  const list = await api("GET", "/api/storage/cards/summary", undefined, token);
  const rows = Object.fromEntries((list.json || []).map((r) => [r.id, r]));
  check("summary: one light row per card", list.status === 200 && rows[mira.id] && rows[jory.id], list.text);
  check("summary: tags as a list, uses and last use carried", JSON.stringify(rows[mira.id]?.tags) === '["female","modern"]' && rows[mira.id]?.uses === 3 && rows[mira.id]?.lastUsedAt, JSON.stringify(rows[mira.id]));
  check("summary: hasImage from the picture on disk", rows[mira.id]?.hasImage === true && rows[jory.id]?.hasImage === false);
  check("summary: no card text beyond the blurb", !("description" in rows[mira.id]) && !("character" in rows[mira.id]) && rows[jory.id]?.hasLorebook === true);
  const other = await stack.register();
  const theirs = await api("GET", "/api/storage/cards/summary", undefined, other.token);
  check("summary: another user sees none of them", theirs.status === 200 && theirs.json.length === 0, theirs.text);

  const found = await api("GET", "/api/storage/cards/search?q=" + encodeURIComponent("blonde braid"), undefined, token);
  check("search: the text search finds the description words", JSON.stringify(found.json?.ids) === JSON.stringify([mira.id]), found.text);

  // ── Thumbnails ──
  const thumbPath = `/api/storage/cards/thumbnail?cardId=${mira.id}&w=320`;
  const small = await rawGet(stack, thumbPath, token);
  const meta = small.status === 200 ? await sharp(small.body).metadata() : {};
  check("thumbnail: ?w=320 is a 320 px WebP", small.status === 200 && small.type === "image/webp" && meta.width === 320 && meta.height === 427, `${small.status} ${small.type} ${meta.width}x${meta.height}`);
  check("thumbnail: much smaller than the portrait", small.body.length * 10 < original.length, `${small.body.length} vs ${original.length}`);
  const thumbFile = path.join(stack.dataDir, "users", String(userId), "card-thumbs", `${mira.id}-320.webp`);
  check("thumbnail: kept on disk", fs.existsSync(thumbFile));
  const again = await rawGet(stack, thumbPath, token, { "If-None-Match": small.etag });
  check("thumbnail: unchanged → 304 for the browser's copy", again.status === 304, again.status);
  const odd = await rawGet(stack, `/api/storage/cards/thumbnail?cardId=${mira.id}&w=200`, token);
  check("thumbnail: odd widths snap to a kept size (200 → 320)", (await sharp(odd.body).metadata()).width === 320);
  const full = await rawGet(stack, `/api/storage/cards/thumbnail?cardId=${mira.id}`, token);
  check("thumbnail: no ?w → the full portrait as before", full.status === 200 && full.type === "image/png" && full.body.equals(original));
  await sleep(20);
  await givePortrait(stack, userId, mira.id, { width: 600, height: 600, color: { r: 10, g: 200, b: 10 } });
  const redone = await rawGet(stack, thumbPath, token, { "If-None-Match": small.etag });
  const redoneMeta = redone.status === 200 ? await sharp(redone.body).metadata() : {};
  check("thumbnail: a new portrait makes a new thumbnail", redone.status === 200 && redoneMeta.height === 320 && redone.etag !== small.etag, `${redone.status} ${redoneMeta.width}x${redoneMeta.height}`);
  const stranger = await rawGet(stack, thumbPath, other.token);
  check("thumbnail: another user's request finds nothing", stranger.status === 404, stranger.status);
  const bad = await rawGet(stack, `/api/storage/cards/thumbnail?cardId=${encodeURIComponent("../x")}&w=320`, token);
  check("thumbnail: a path in the id is refused", bad.status === 404 || bad.status === 400, bad.status);
  const del = await api("DELETE", `/api/storage/cards/${mira.id}`, undefined, token);
  await sleep(100);
  check("delete: the card's thumbnails go with it", del.status === 200 && !fs.existsSync(thumbFile));
  backend.cards(userId).delete(String(jory.id));

  // ── The tagging run ──
  for (let i = 0; i < 9; i++) backend.addCard(userId, { name: `Untagged ${i}`, description: `Card number ${i}.` });
  const kept = backend.addCard(userId, { name: "Already Tagged", tags: "male,western" });
  const callsBefore = model.count("tags");
  let run = (await api("POST", "/api/card-tags/run", {}, token)).json;
  check("tag run: starts with the saved settings (none sent)", run?.status === "running", JSON.stringify(run));
  run = await waitFor(async () => { const r = (await api("GET", "/api/card-tags/run", undefined, token)).json; return r.status !== "running" && r; });
  check("tag run: done, every untagged card tagged", run.status === "done" && run.tagged === 9 && run.total === 9 && untagged(stack, userId).length === 0, JSON.stringify(run));
  check("tag run: one model call per card", model.count("tags") - callsBefore === 9, model.count("tags") - callsBefore);
  const tagged = backend.cards(userId).get(String(backend.nextCardId - 1));
  check("tag run: tags normalised by the page's parser", tagged.tags === "female,sci-fi,elf,knight,dominant,romance,nsfw,lighthouse keeper", tagged.tags);
  check("tag run: a card that had tags is left alone", backend.cards(userId).get(String(kept.id)).tags === "male,western");
  const tagCall = model.calls.filter((c) => c.kind === "tags").pop();
  check("tag run: the content context and the vocabulary are in the prompt", /CONTENT CONTEXT/.test(tagCall.body.messages[0].content) && /kemonomimi/.test(tagCall.body.messages[0].content));
  check("tag run: recent shows what was tagged", run.recent?.length && run.recent[0].tags?.length > 3, JSON.stringify(run.recent?.[0]));
  const nothing = (await api("POST", "/api/card-tags/run", {}, token)).json;
  const nothingDone = await waitFor(async () => { const r = (await api("GET", "/api/card-tags/run", undefined, token)).json; return r.status !== "running" && r; });
  check("tag run: again with nothing left: done, no calls", nothing && nothingDone.status === "done" && nothingDone.total === 0 && model.count("tags") - callsBefore === 9, JSON.stringify(nothingDone));
  const otherRun = (await api("GET", "/api/card-tags/run", undefined, other.token)).json;
  check("tag run: another user sees no run", otherRun.status === "idle", JSON.stringify(otherRun));

  // Three at a time; Stop leaves the rest untagged; starting again finishes them, none twice.
  for (let i = 0; i < 12; i++) backend.addCard(userId, { name: `Batch ${i}` });
  backend.tagPatches.length = 0;
  const hold = model.hold("tags", 1);
  const before2 = model.count("tags");
  await api("POST", "/api/card-tags/run", {}, token);
  await waitFor(() => model.count("tags") - before2 >= 3);
  await sleep(300);
  check("tag run: three cards at a time", model.count("tags") - before2 === 3, model.count("tags") - before2);
  const doubleTap = (await api("POST", "/api/card-tags/run", {}, token)).json;
  check("tag run: a second start while running is the same run", doubleTap.status === "running" && model.count("tags") - before2 === 3);
  await api("POST", "/api/card-tags/run/stop", {}, token);
  hold.release();
  run = await waitFor(async () => { const r = (await api("GET", "/api/card-tags/run", undefined, token)).json; return r.status !== "running" && r; });
  check("tag run: Stop stops it", run.status === "stopped" && untagged(stack, userId).length === 12, `${run.status} ${untagged(stack, userId).length}`);
  await api("POST", "/api/card-tags/run", {}, token);
  run = await waitFor(async () => { const r = (await api("GET", "/api/card-tags/run", undefined, token)).json; return r.status !== "running" && r; });
  const perCard = backend.tagPatches.reduce((m, p) => m.set(p.id, (m.get(p.id) || 0) + 1), new Map());
  check("tag run: started again, it finishes the rest", run.status === "done" && untagged(stack, userId).length === 0 && run.tagged === 12, JSON.stringify(run));
  check("tag run: no card saved twice", [...perCard.values()].every((n) => n === 1) && perCard.size === 12, JSON.stringify([...perCard]));

  // A proxy restart mid-run leaves it "interrupted"; starting again carries on.
  for (let i = 0; i < 6; i++) backend.addCard(userId, { name: `Restart ${i}` });
  const hold2 = model.hold("tags", 1);
  await api("POST", "/api/card-tags/run", {}, token);
  await waitFor(() => hold2.reached);
  await stack.restartProxy();
  hold2.release();
  run = (await api("GET", "/api/card-tags/run", undefined, token)).json;
  check("tag run: a restart leaves it interrupted, with a reason", run.status === "interrupted" && /restarted/.test(run.error || ""), JSON.stringify(run));
  await api("POST", "/api/card-tags/run", {}, token);
  run = await waitFor(async () => { const r = (await api("GET", "/api/card-tags/run", undefined, token)).json; return r.status !== "running" && r; });
  check("tag run: after the restart it tags the rest", run.status === "done" && untagged(stack, userId).length === 0, JSON.stringify(run));

  // Failing every time: stops after five in a row instead of paying for the lot.
  for (let i = 0; i < 20; i++) backend.addCard(userId, { name: `Failing ${i}` });
  model.failAll.tags = 500;
  const before3 = model.count("tags");
  await api("POST", "/api/card-tags/run", {}, token);
  run = await waitFor(async () => { const r = (await api("GET", "/api/card-tags/run", undefined, token)).json; return r.status !== "running" && r; }, 30000);
  const spent = model.count("tags") - before3;
  check("tag run: five failures in a row stop it", run.status === "failed" && /in a row/.test(run.error || "") && untagged(stack, userId).length >= 13, JSON.stringify({ status: run.status, error: run.error, left: untagged(stack, userId).length }));
  check("tag run: ...having tried each failed card twice, and no more than ~7 cards", spent >= 10 && spent <= 14, spent);
  model.failAll.tags = 401;
  const before4 = model.count("tags");
  await api("POST", "/api/card-tags/run", {}, token);
  run = await waitFor(async () => { const r = (await api("GET", "/api/card-tags/run", undefined, token)).json; return r.status !== "running" && r; }, 30000);
  // (each refused call is two requests: the proxy retries a 401 with the other auth header)
  check("tag run: a refused key stops it at once", run.status === "failed" && /key/.test(run.error || "") && model.count("tags") - before4 <= 6, JSON.stringify({ error: run.error, calls: model.count("tags") - before4 }));
  delete model.failAll.tags;
  await api("POST", "/api/card-tags/run", {}, token);
  run = await waitFor(async () => { const r = (await api("GET", "/api/card-tags/run", undefined, token)).json; return r.status !== "running" && r; });
  check("tag run: once the model works again, the rest get tagged", run.status === "done" && untagged(stack, userId).length === 0, JSON.stringify(run));

  // Clean slate for the page half.
  backend.cards(userId).clear();
}

// ── The page ────────────────────────────────────────────────────────────────

const NAMES = ["Mira", "Miranda", "Amira", "Tamsin", "Jory", "Ann", "Bryn", "Cass", "Dora", "Elin", "Fenn", "Gwen", "Hal", "Isolde", "Jago", "Kerra", "Lowen", "Morwenna", "Nessa", "Oriel"];

async function seed(stack, userId, n) {
  const made = [];
  for (let i = 0; i < n; i++) {
    const base = NAMES[i % NAMES.length];
    const day = String(1 + (i % 28)).padStart(2, "0");
    const month = String(1 + Math.floor(i / 28)).padStart(2, "0");
    const card = stack.backend.addCard(userId, {
      name: i < NAMES.length ? base : `${base} ${i}`,
      description: i === 7 ? "Cass keeps bees on a rooftop in Leeds." : `Character number ${i}.`,
      tags: i % 3 === 0 ? "female,fantasy" : i % 3 === 1 ? "male,sci-fi" : "",
      created_at: `2026-${month}-${day}T12:00:00`,
      updated_at: `2026-${month}-${day}T12:00:00`,
      uses: i === 5 ? 9 : i % 4 === 0 ? 1 : 0,
      last_used_at: i === 5 ? "2026-11-23T09:00:00" : i % 4 === 0 ? "2026-10-01T09:00:00" : null,
    });
    if (i >= 100) await givePortrait(stack, userId, card.id, { width: 300, height: 400, color: { r: (i * 37) % 255, g: 90, b: 140 } });
    made.push(card);
  }
  return made;
}

async function pageHalf(browser, stack, { width, height, dark }) {
  const tag = `${width}${dark ? " dark" : ""}`;
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, hasTouch: width < 800, serviceWorkers: "block", colorScheme: dark ? "dark" : "light" });
  await ctx.addInitScript(([t, dark]) => {
    try {
      localStorage.setItem("cardgen_auth_token", t);
      if (!sessionStorage.getItem("hb-kept")) localStorage.removeItem("cardgen.homeBrowse.v1");
      if (dark) localStorage.setItem("theme", "dark");
    } catch (_) {}
  }, [stack.token, dark]);
  const page = await ctx.newPage();
  if (process.env.HB_DEBUG) {
    await page.exposeFunction("dbg", (s) => console.log(`[${tag}]`, s));
    await page.addInitScript(() => {
      const O = window.IntersectionObserver;
      window.IntersectionObserver = class extends O { constructor(cb, o) { super((en, ob) => { window.dbg("IO " + en.map((e) => e.isIntersecting + "@" + Math.round(e.boundingClientRect.top)).join(",") + " n=" + document.querySelectorAll("#home-grid .hc-tile").length); cb(en, ob); }, o); } };
    });
  }
  const requests = [];
  page.on("request", (r) => requests.push({ url: r.url(), at: Date.now() }));
  page.on("dialog", (d) => d.accept());
  await page.goto(stack.url + "/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelectorAll("#home-grid .hc-tile").length > 0, null, { timeout: 20000 });
  const rendered = await page.evaluate(() => { const r = document.getElementById("home-grid").getBoundingClientRect(); return r.width > 100 && getComputedStyle(document.getElementById("app-root")).display !== "none"; });
  check(`${tag}: the app rendered with the grid (not a blank page)`, rendered);

  const count = () => page.$$eval("#home-grid .hc-tile", (els) => els.length);
  const first = await count();
  check(`${tag}: whole batches of 48 to fill the screen, not all 130`, first >= 48 && first < 130 && first % 48 === 0, first);
  check(`${tag}: the grid came from the light list`, requests.some((r) => /\/api\/storage\/cards\/summary$/.test(r.url)));
  const imgs = await page.$$eval("#home-grid .hc-tile img", (els) => els.map((e) => e.getAttribute("src")));
  check(`${tag}: tiles load 320 px thumbnails, lazily`, imgs.length > 0 && imgs.every((s) => /thumbnail\?cardId=\d+&w=320/.test(s)) && await page.$eval("#home-grid .hc-tile img", (e) => e.loading === "lazy"), imgs[0]);
  check(`${tag}: cards without a picture show an initial, no request`, await page.$$eval("#home-grid .hc-pic.hc-noimg", (els) => els.length) > 0);

  const cols = await page.$$eval("#home-grid .hc-tile", (els) => new Set(els.slice(0, 8).map((e) => Math.round(e.getBoundingClientRect().top))).size && els.filter((e) => Math.round(e.getBoundingClientRect().top) === Math.round(els[0].getBoundingClientRect().top)).length);
  const wantCols = width >= 800 ? (c) => c >= 6 : width >= 375 ? (c) => c === 3 : (c) => c === 2;
  check(`${tag}: ${width >= 800 ? "6+" : width >= 375 ? "3" : "2"} tiles a row`, wantCols(cols), cols);
  const sideways = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth - window.innerWidth, chips: document.getElementById("home-chip-row").scrollWidth > document.getElementById("home-chip-row").clientWidth }));
  check(`${tag}: no sideways page scroll`, sideways.doc <= 0, JSON.stringify(sideways));

  // Scrolling down grows the grid; the bar sticks to the top.
  for (let i = 0; i < 40 && (await count()) < 130; i++) {
    await page.evaluate(() => window.scrollBy(0, 1500));
    await sleep(60);
  }
  check(`${tag}: scrolling down shows all 130`, (await count()) === 130, JSON.stringify(await page.evaluate(() => ({ n: document.querySelectorAll("#home-grid .hc-tile").length, more: document.getElementById("home-grid-more").getBoundingClientRect().top, ih: window.innerHeight, y: window.scrollY, h: document.documentElement.scrollHeight }))));
  const bar = await page.evaluate(() => { const r = document.getElementById("home-chars-bar").getBoundingClientRect(); return { top: r.top, h: r.height, y: window.scrollY }; });
  check(`${tag}: the search bar sticks to the top`, Math.abs(bar.top) <= 1 && bar.h > 40 && bar.y > 2000, JSON.stringify(bar));
  await page.screenshot({ path: path.join(os.tmpdir(), `home-browse-${width}${dark ? "-dark" : ""}-scrolled.png`) });

  // A filter while scrolled deep: the grid comes back to just under the bar, no jump to the page top.
  await page.click('[data-chip="tag"][data-value="fantasy"]');
  const place = await page.evaluate(() => ({ grid: document.getElementById("home-grid").getBoundingClientRect().top, bar: document.getElementById("home-chars-bar").getBoundingClientRect().bottom, y: window.scrollY }));
  check(`${tag}: a filter brings the results under the bar, not to the page top`, place.grid - place.bar >= -2 && place.grid - place.bar <= 60 && place.y > 200, JSON.stringify(place));
  const fantasy = await count();
  check(`${tag}: tag filter: the 44 fantasy cards`, fantasy === 44, fantasy);
  check(`${tag}: picked tag shown first and pressed`, await page.$eval('#home-chip-row [data-chip="tag"]', (e) => e.dataset.value === "fantasy" && e.getAttribute("aria-pressed") === "true"));
  check(`${tag}: summary counts the matches`, /^44 of 130 characters/.test(await page.$eval("#home-chars-summary", (e) => e.textContent)), await page.$eval("#home-chars-summary", (e) => e.textContent));
  await page.click('[data-chip="clear"]');
  check(`${tag}: ✕ Clear shows them all again`, (await page.$eval("#home-chars-summary", (e) => e.textContent)).startsWith("130 characters"));

  // Search: names first, starts-with before contains; not descriptions unless asked.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.fill("#home-search", "mir");
  await page.waitForFunction(() => /^21 of 130/.test(document.getElementById("home-chars-summary").textContent), null, { timeout: 3000 }).catch(() => {});
  const names = await page.$$eval("#home-grid .hc-name", (els) => els.map((e) => e.textContent));
  const firstAmira = names.findIndex((n) => n.startsWith("Amira"));
  check(`${tag}: search "mir": names starting with it first, then containing it`, firstAmira > 0 && names.slice(0, firstAmira).every((n) => n.startsWith("Mir")) && names.slice(firstAmira).every((n) => n.startsWith("Amira")) && names.length === 21, names.join(", "));
  await page.fill("#home-search", "bees");
  await sleep(300);
  check(`${tag}: a description word isn't matched by default`, (await count()) === 0 && await page.isVisible("#home-grid .hc-note"));
  await page.click('[data-chip="desc"]');
  await page.waitForFunction(() => document.querySelectorAll("#home-grid .hc-tile").length === 1, null, { timeout: 5000 }).catch(() => {});
  check(`${tag}: 📝 Descriptions finds it through the server search`, (await count()) === 1 && (await page.$eval("#home-grid .hc-name", (e) => e.textContent)) === "Cass", await count());
  check(`${tag}: ...asked the proxy, not the full list`, requests.some((r) => /\/api\/storage\/cards\/search\?q=bees/.test(r.url)));
  await page.click('[data-chip="desc"]');
  await page.fill("#home-search", "sci");
  await page.waitForFunction(() => /^43 of 130/.test(document.getElementById("home-chars-summary").textContent), null, { timeout: 3000 }).catch(() => {});
  check(`${tag}: tags are searched too`, (await count()) === 43, await page.textContent("#home-chars-summary"));
  await page.click("#home-search-clear");

  // Sorts, remembered.
  await page.selectOption("#home-sort", "az");
  const az = await page.$$eval("#home-grid .hc-name", (els) => els.slice(0, 10).map((e) => e.textContent));
  check(`${tag}: A–Z`, JSON.stringify(az) === JSON.stringify([...az].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))) && az[0] === "Amira", az.join(", "));
  await page.selectOption("#home-sort", "most");
  check(`${tag}: Most used: the 9-use card first`, (await page.$eval("#home-grid .hc-name", (e) => e.textContent)) === "Ann");
  check(`${tag}: its tile says how used`, /💬 9/.test(await page.$eval("#home-grid .hc-meta", (e) => e.textContent)));
  await page.click('[data-chip="used"][data-value="unused"]');
  check(`${tag}: 🌱 Never used`, (await page.textContent("#home-chars-summary")).startsWith(`${130 - 1 - 33} of 130`), await page.textContent("#home-chars-summary"));
  await page.evaluate(() => sessionStorage.setItem("hb-kept", "1"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelectorAll("#home-grid .hc-tile").length > 0, null, { timeout: 20000 });
  check(`${tag}: sort and the used filter are remembered`, (await page.$eval("#home-sort", (e) => e.value)) === "most" && await page.$eval('[data-chip="used"][data-value="unused"]', (e) => e.getAttribute("aria-pressed") === "true"));
  await page.click('[data-chip="clear"]');
  await page.selectOption("#home-sort", "newest");
  await page.evaluate(() => sessionStorage.removeItem("hb-kept"));

  // The card sheet.
  await page.click("#home-grid .hc-tile");
  await page.waitForSelector("#home-card-sheet:not([hidden])");
  const sheet = await page.evaluate(() => {
    const s = document.querySelector("#home-card-sheet .hcs-sheet").getBoundingClientRect();
    return { name: document.querySelector(".hcs-name").textContent, actions: [...document.querySelectorAll(".hcs-actions [data-act]")].map((b) => b.dataset.act), w: s.width, bottom: s.bottom, vh: window.innerHeight, tags: [...document.querySelectorAll(".hcs-tags [data-tag]")].map((b) => b.dataset.tag) };
  });
  check(`${tag}: tap a tile → its sheet with every action`, sheet.name && ["chat", "story", "text", "edit", "details", "delete"].every((a) => sheet.actions.includes(a)), JSON.stringify(sheet));
  if (width < 800) check(`${tag}: a bottom sheet on the phone`, Math.abs(sheet.bottom - sheet.vh) <= 1 && sheet.w >= width - 1, JSON.stringify(sheet));
  await page.screenshot({ path: path.join(os.tmpdir(), `home-browse-${width}${dark ? "-dark" : ""}-sheet.png`) });
  if (sheet.tags.length) {
    await page.click(`.hcs-tags [data-tag="${sheet.tags[0]}"]`);
    check(`${tag}: a tag in the sheet filters by it`, await page.isHidden("#home-card-sheet") && await page.$eval(`#home-chip-row [data-chip="tag"][data-value="${sheet.tags[0]}"]`, (e) => e.getAttribute("aria-pressed") === "true"));
    await page.click('[data-chip="clear"]');
  }
  await page.click("#home-grid .hc-tile");
  await page.keyboard.press("Escape");
  check(`${tag}: Escape closes the sheet`, await page.isHidden("#home-card-sheet"));
  await page.click("#home-grid .hc-tile >> nth=1");
  await page.click('#home-card-sheet [data-act="details"]');
  await page.waitForFunction(() => document.getElementById("card-gallery-info-modal")?.style.display === "flex", null, { timeout: 5000 }).catch(() => {});
  check(`${tag}: 📄 Full card fetches that card and shows it`, await page.evaluate(() => document.getElementById("card-gallery-info-modal").style.display === "flex" && /Character number/.test(document.getElementById("gallery-info-content").textContent)));
  await page.evaluate(() => document.getElementById("card-gallery-info-close").click());

  await page.screenshot({ path: path.join(os.tmpdir(), `home-browse-${width}${dark ? "-dark" : ""}.png`) });
  await ctx.close();
}

async function taggingFromThePage(browser, stack) {
  const tag = "390 tagging";
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: "block" });
  await ctx.addInitScript((t) => { try { localStorage.setItem("cardgen_auth_token", t); } catch (_) {} }, stack.token);
  const page = await ctx.newPage();
  const polls = [];
  page.on("request", (r) => { if (/\/api\/card-tags\/run$/.test(r.url()) && r.method() === "GET") polls.push(Date.now()); });
  page.on("dialog", (d) => d.accept());
  await page.goto(stack.url + "/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelectorAll("#home-grid .hc-tile").length > 0, null, { timeout: 20000 });
  const n = untagged(stack, stack.userId).length;
  check(`${tag}: 🏷️ button offers the ${n} untagged`, (await page.textContent("#home-tag-btn")) === `🏷️ Tag ${n} untagged` && await page.isVisible("#home-tag-btn"), await page.textContent("#home-tag-btn"));

  stack.model.chunkDelayMs = 40;
  stack.backend.tagPatches.length = 0;
  await page.click("#home-tag-btn");
  await page.waitForSelector("#home-tag-status:not([hidden])");
  check(`${tag}: progress panel with Stop, button hidden`, await page.isVisible('#home-tag-status [data-act="stop"]') && await page.isHidden("#home-tag-btn"));

  // The page goes away (a locked phone): polling stops; the run carries on.
  await waitFor(() => stack.backend.tagPatches.length > 2);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await sleep(4000);
  const pollsWhenHidden = polls.length;
  await sleep(4000);
  check(`${tag}: no polling while the page is hidden`, polls.length === pollsWhenHidden, `${pollsWhenHidden} → ${polls.length}`);
  check(`${tag}: ...but the run carried on`, stack.backend.tagPatches.length > 6, stack.backend.tagPatches.length);
  stack.model.chunkDelayMs = 5;
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForFunction(() => /finished/.test(document.querySelector("#home-tag-status .hc-tag-title")?.textContent || ""), null, { timeout: 60000 }).catch(() => {});
  check(`${tag}: back on the page it picks up and shows it finished`, /finished/.test(await page.textContent("#home-tag-status")) && polls.length > pollsWhenHidden);
  await page.waitForFunction(() => document.querySelector('#home-chip-row [data-value="elf"]'), null, { timeout: 5000 }).catch(() => {});
  check(`${tag}: the new tags are filter chips`, await page.isVisible('#home-chip-row [data-chip="tag"][data-value="elf"]'));
  check(`${tag}: nothing left to tag: button hidden`, await page.isHidden("#home-tag-btn") && untagged(stack, stack.userId).length === 0);
  await page.click('#home-tag-status [data-act="dismiss"]');
  check(`${tag}: ✕ dismisses the panel`, await page.isHidden("#home-tag-status"));
  await page.screenshot({ path: path.join(os.tmpdir(), "home-browse-tagged.png") });
  await ctx.close();
}

(async () => {
  const stack = await start({ repo, stageDir: path.join(os.tmpdir(), "cardgen-home-browse") });
  let browser;
  try {
    await proxyHalf(stack);
    const { webkit } = require(process.env.PLAYWRIGHT_CORE || "playwright-core");
    browser = await webkit.launch();
    await seed(stack, stack.userId, 130);
    await pageHalf(browser, stack, { width: 390, height: 844, dark: false });
    await pageHalf(browser, stack, { width: 320, height: 640, dark: true });
    await pageHalf(browser, stack, { width: 1280, height: 900, dark: false });
    await taggingFromThePage(browser, stack);
  } catch (error) {
    failed++;
    console.log("FAIL crashed: " + (error.stack || error));
  } finally {
    if (browser) await browser.close();
    await stack.stop();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
