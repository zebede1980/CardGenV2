// "Landing": a picture drawn for a card whose page never came back for it is
// saved as a History copy of that card. Real proxy; the last part drives the
// real page in headless WebKit. See README.md for how to run.
const os = require("os");
const path = require("path");
const { webkit } = require(process.env.PLAYWRIGHT_CORE || "playwright-core");
const { start, sleep } = require("./stack");

const repo = path.resolve(__dirname, "..", "..");
let failed = 0, passed = 0;
const check = (name, ok, detail = "") => {
  if (ok) { passed++; console.log("ok   " + name); }
  else { failed++; console.log("FAIL " + name + (detail ? "\n     " + String(detail).slice(0, 500) : "")); }
};
const until = async (fn, { timeout = 15000, step = 40, what = "condition" } = {}) => {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting for " + what);
    await sleep(step);
  }
};
const CARD = { name: "Mira Okafor", description: "# Mira Okafor's Profile\n\nA lighthouse keeper.", personality: "Patient.", scenario: "A storm.", firstMessage: "Come in.", cardType: "single" };

(async () => {
  // ── Part 1: the proxy, with a short grace period ───────────────────────────
  const GRACE = 1200;
  let stack = await start({ repo, stageDir: path.join(os.tmpdir(), "cardgen-test-stage"), env: { JOB_LAND_AFTER_MS: String(GRACE) } });
  let { api, token, userId, backend, model } = stack;
  let history = () => backend.history(userId);
  const clearHistory = async () => { for (const h of history()) await api("DELETE", `/api/storage/cards/${h.id}`, undefined, token); await until(() => history().length === 0, { what: "history cleared" }); };
  let n = 0;
  // An image request as the page sends it. Returns { ref, response (a promise), abort }.
  const draw = (extra = {}, who = token) => {
    const ref = `ref-${Date.now()}-${n++}`;
    const controller = new AbortController();
    const response = fetch(stack.url + "/api/image/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${who}`, "X-API-Key": "fake-image-key", "X-API-URL": stack.modelUrl },
      body: JSON.stringify({ model: "fake-image", prompt: "a portrait", n: 1, response_format: "url", resumable: true, clientRef: ref, __jobLabel: "Character image", __landing: { card: CARD }, ...extra }),
      signal: controller.signal,
    }).then((r) => r.json().then((json) => ({ status: r.status, json }))).catch((error) => ({ error }));
    return { ref, response, abort: () => controller.abort() };
  };
  const gone = async (extra) => {           // a draw whose page disappears while it is being drawn
    const hold = model.hold("image");
    const d = draw(extra);
    await until(() => hold.reached, { what: "image call held" });
    d.abort();
    await sleep(150);
    return { ...d, release: hold.release };
  };

  // 1. Delivered to a waiting page: nothing is saved.
  let d = draw();
  let r = await d.response;
  check("a waiting page gets its picture", r.status === 200 && String(r.json?.data?.[0]?.url || "").startsWith("data:image/"), JSON.stringify(r).slice(0, 200));
  const sent = model.calls.filter((c) => c.kind === "image").pop().body;
  check("the card and the job label are never sent to the image provider", !("__landing" in sent) && !("__jobLabel" in sent) && !("resumable" in sent) && sent.prompt === "a portrait", Object.keys(sent).join(","));
  r = await api("POST", "/api/jobs/collected", { clientRefs: [d.ref] }, token);
  check("the page confirms it has the picture", r.status === 200 && r.json.collected === 1, r.text);
  await sleep(GRACE + 500);
  check("a picture the page confirmed is not saved to History", history().length === 0, history().length);

  // 1b. Delivered as far as the proxy can tell, but never confirmed (a dead
  //     connection that still looked open): it lands. Better saved twice than lost.
  d = draw();
  await d.response;
  await until(() => history().length === 1, { what: "unconfirmed picture landed", timeout: GRACE + 4000 });
  check("a picture nobody confirmed lands, even though a response was written", history()[0].data.character.name === "Mira Okafor");
  const stranger = await stack.register();
  d = draw();
  await d.response;
  r = await api("POST", "/api/jobs/collected", { clientRefs: [d.ref] }, stranger.token);
  check("another user cannot confirm it away", r.json.collected === 0);
  await until(() => history().length === 2, { what: "second unconfirmed picture landed", timeout: GRACE + 4000 });
  await clearHistory();

  // 2. The page is gone: after the grace period the picture is in History with its card.
  let g = await gone();
  g.release();
  await sleep(300);
  check("nothing is saved before the grace period is up", history().length === 0);
  await until(() => history().length === 1, { what: "landing", timeout: GRACE + 4000 });
  check("an uncollected picture lands as a History copy of its card", history()[0].data.character.name === "Mira Okafor" && history()[0].data.character.scenario === "A storm.");
  r = await api("GET", `/api/storage/cards/${history()[0].id}`, undefined, token);
  check("the History copy has the picture as its portrait", String(r.json?.imageBase64 || "").startsWith("data:image/png"));
  await sleep(GRACE + 400);
  check("it lands once", history().length === 1);

  // 3. The page comes back in time and collects: nothing is saved.
  await clearHistory();
  g = await gone();
  g.release();
  const jobId = await until(async () => { const j = await api("GET", `/api/jobs?clientRef=${g.ref}`, undefined, token); const job = j.json?.jobs?.[0]; return job && job.status === "done" ? job.id : null; }, { what: "job done" });
  r = await api("GET", `/api/jobs/${jobId}/result`, undefined, token);
  check("a page that comes back collects the picture", r.status === 200 && r.json.status === "done" && !!r.json.result?.data?.[0]?.url);
  await sleep(GRACE + 600);
  check("a collected picture is not saved to History", history().length === 0, history().length);

  // 4. Landed on request, without waiting.
  g = await gone();
  g.release();
  await until(async () => (await api("GET", `/api/jobs?clientRef=${g.ref}`, undefined, token)).json?.jobs?.[0]?.status === "done", { what: "job done" });
  const before = Date.now();
  r = await api("POST", "/api/jobs/land", { clientRefs: [g.ref, "no-such-ref"] }, token);
  check("a page that has given up can ask for it to be saved now", r.status === 200 && r.json.landed.length === 1 && r.json.landed[0].name === "Mira Okafor" && Date.now() - before < GRACE && history().length === 1, r.text);
  await sleep(GRACE + 400);
  check("asked for and timed: still saved once", history().length === 1);
  r = await api("POST", "/api/jobs/land", { clientRefs: [g.ref] }, token);
  check("asking twice saves nothing more", r.json.landed.length === 0 && history().length === 1);

  // 5. Asked for while it is still being drawn: saved the moment it finishes.
  await clearHistory();
  g = await gone();
  r = await api("POST", "/api/jobs/land", { clientRefs: [g.ref] }, token);
  check("a picture still being drawn is noted", r.json.pending === 1 && r.json.landed.length === 0 && history().length === 0, r.text);
  g.release();
  await until(() => history().length === 1, { what: "landed at finish", timeout: 3000 });
  check("and saved as soon as it is finished", true);

  // 6. A new card's portrait completes its draft instead of adding a second item.
  await clearHistory();
  r = await api("POST", "/api/storage/cards", { isPermanent: false, draft: true, characterName: CARD.name, character: CARD }, token);
  const draftId = r.json.id;
  g = await gone({ __landing: { card: { ...CARD, creatorNotes: "now complete" }, replaceHistoryId: draftId } });
  g.release();
  await until(async () => { const c = await api("GET", `/api/storage/cards/${draftId}`, undefined, token); return String(c.json?.imageBase64 || "").startsWith("data:image/"); }, { what: "draft completed", timeout: GRACE + 4000 });
  check("a draft named in the request is completed, not duplicated", history().length === 1 && history()[0].id === draftId && history()[0].data.character.creatorNotes === "now complete" && !history()[0].data.draft);

  // 7. No card, no landing; and nobody can land someone else's.
  await clearHistory();
  g = await gone({ __landing: undefined });
  g.release();
  await sleep(GRACE + 600);
  check("a picture sent without a card is never saved", history().length === 0);
  g = await gone();
  g.release();
  const other = await stack.register();
  r = await api("POST", "/api/jobs/land", { clientRefs: [g.ref] }, other.token);
  check("another user cannot land it", r.json.landed.length === 0 && backend.history(other.userId).length === 0);
  await until(() => history().length === 1, { what: "landing", timeout: GRACE + 4000 });

  // 8. A failed draw lands nothing.
  await clearHistory();
  model.failAll.image = 500;
  d = draw();
  r = await d.response;
  delete model.failAll.image;
  await sleep(GRACE + 500);
  check("a failed draw is not saved", r.status === 500 && history().length === 0, r.status);
  await stack.stop();

  // ── Part 2: the page, with the real grace period out of the way ────────────
  stack = await start({ repo, stageDir: path.join(os.tmpdir(), "cardgen-test-stage"), env: { JOB_LAND_AFTER_MS: "600000" } });
  ({ api, token, userId, backend, model } = stack);
  history = () => backend.history(userId);
  await api("POST", "/api/config", { ...stack.config, api: { ...stack.config.api, image: stack.imageSettings() }, app: { ...stack.config.app, enableImageGeneration: true, serverRuns: false } }, token);
  const browser = await webkit.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await context.addInitScript((t) => { try { localStorage.setItem("cardgen_auth_token", t); } catch (_) {} }, token);
  const pageErrors = [];
  const open = async () => {
    const page = await context.newPage();
    page.on("pageerror", (e) => pageErrors.push(e.message));
    page.__bodies = [];
    page.__confirms = 0;
    page.on("request", (req) => {
      if (req.method() === "POST" && req.url().includes("/api/image/")) page.__bodies.push(req.postData() || "");
      if (req.method() === "POST" && req.url().endsWith("/api/jobs/collected")) page.__confirms++;
    });
    await page.goto(stack.url + "/", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!window.app && window.app.storageReady === true, null, { timeout: 20000 });
    await page.evaluate(() => document.getElementById("tab-cardgen")?.click());
    return page;
  };
  let page = await open();
  await page.evaluate(() => {
    document.getElementById("character-concept").value = "a lighthouse keeper";
    window.app.handleGenerate();
  });
  await page.waitForFunction(() => window.app.isGenerating === false, null, { timeout: 30000 });
  await until(() => history().length === 1 && !history()[0].data.draft, { what: "card saved" });
  const cardId = history()[0].id;
  const portraitBody = JSON.parse(page.__bodies[0] || "{}");
  check("page: a new card's portrait request names the card and its draft", portraitBody.__landing?.card?.name === "Mira Okafor" && portraitBody.__landing?.replaceHistoryId === cardId, JSON.stringify(portraitBody.__landing)?.slice(0, 200));
  check("page: a picture that arrives is confirmed to the proxy", page.__confirms === 1, page.__confirms);
  check("page: no landing outside Character Gen", await page.evaluate(() => { document.getElementById("tab-playground").click(); const off = window.apiHandler.imageLanding(); document.getElementById("tab-cardgen").click(); return off === null && window.apiHandler.imageLanding() !== null; }));

  // P1. Regenerate, then the tab is closed while the picture is being drawn.
  let hold = model.hold("image");
  await page.evaluate(() => {
    document.getElementById("custom-image-prompt").value = "a second portrait, by the harbour";
    window.app.handleRegenerateImage();
  });
  await until(() => hold.reached, { what: "regenerate image held" });
  const regenBody = JSON.parse(page.__bodies[page.__bodies.length - 1]);
  check("page: Regenerate sends the card, and no draft to replace", regenBody.__landing?.card?.name === "Mira Okafor" && !regenBody.__landing.replaceHistoryId);
  // Age the pending job as if the app had been closed for a while.
  await page.evaluate(() => {
    const jobs = JSON.parse(localStorage.getItem("cardgen.pendingJobs") || "[]");
    for (const job of jobs) job.startedAt -= 5 * 60 * 1000;
    localStorage.setItem("cardgen.pendingJobs", JSON.stringify(jobs));
  });
  await page.close({ runBeforeUnload: false });
  hold.release();
  await sleep(600);
  check("page gone mid-draw: nothing saved yet (the grace period is long)", history().length === 1);

  // P2. The app is reopened: the picture is saved to History at once, and it says so.
  page = await open();
  await until(() => history().length === 2, { what: "orphaned picture landed on reload" });
  const landedItem = history().find((h) => h.id !== cardId);
  r = await api("GET", `/api/storage/cards/${landedItem.id}`, undefined, token);
  check("reopened: the picture is in History with its card", landedItem.data.character.name === "Mira Okafor" && String(r.json?.imageBase64 || "").startsWith("data:image/"));
  check("reopened: the page says so", await until(async () => page.evaluate(() => [...document.querySelectorAll(".notification")].some((el) => /A picture drawn while the app was closed is in History with Mira Okafor/.test(el.textContent))), { what: "notification", timeout: 4000 }).catch(() => false));
  check("reopened: the pending job entry is cleared", await page.evaluate(() => JSON.parse(localStorage.getItem("cardgen.pendingJobs") || "[]").length === 0));

  // P3. With a second tab open, a reload leaves that tab's pending picture alone.
  hold = model.hold("image");
  await page.evaluate(async () => {
    await window.app.loadCardIntoEditor(window.app.currentCardId || (await window.app.storage.listCards())[0].id, { quiet: true });
    document.getElementById("custom-image-prompt").value = "a third portrait";
    window.app.handleRegenerateImage();
  });
  await until(() => hold.reached, { what: "image held" });
  await page.evaluate(() => {
    const jobs = JSON.parse(localStorage.getItem("cardgen.pendingJobs") || "[]");
    for (const job of jobs) job.startedAt -= 5 * 60 * 1000;
    localStorage.setItem("cardgen.pendingJobs", JSON.stringify(jobs));
  });
  const second = await open();
  await sleep(1500);
  check("two tabs: the new tab does not land a picture the first is waiting for", history().length === 2 && await second.evaluate(() => JSON.parse(localStorage.getItem("cardgen.pendingJobs") || "[]").length === 1));
  await second.close();
  hold.release();
  await until(async () => page.evaluate(() => !!document.querySelector("#image-options-grid img")), { what: "first tab got its picture" });
  check("two tabs: the first tab gets its picture as usual", true);

  check("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
  await browser.close();
  await stack.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
