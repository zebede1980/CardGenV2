// Phase 0 of plans/character-gen-backend-driven.md: History drafts, recovery
// after a discarded tab, streamed single calls. Real proxy + real page in
// headless WebKit at iPhone width. See README.md for how to run.
const os = require("os");
const path = require("path");
const { webkit } = require(process.env.PLAYWRIGHT_CORE || "playwright-core");
const { start, sleep } = require("./stack");

const repo = path.resolve(__dirname, "..", "..");
let failed = 0, passed = 0;
const check = (name, ok, detail = "") => {
  if (ok) { passed++; console.log("ok   " + name); }
  else { failed++; console.log("FAIL " + name + (detail ? "\n     " + String(detail).slice(0, 400) : "")); }
};
const until = async (fn, { timeout = 15000, step = 50, what = "condition" } = {}) => {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting for " + what);
    await sleep(step);
  }
};
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

(async () => {
  const stack = await start({ repo, stageDir: path.join(os.tmpdir(), "cardgen-test-stage") });
  const { api, token, userId, backend, model } = stack;
  const history = () => backend.history(userId);

  // ── A. History saves through the real proxy ───────────────────────────────
  let r = await api("POST", "/api/storage/cards", { isPermanent: false, draft: true, characterName: "A", character: { name: "A", description: "v1" } }, token);
  const draftId = r.json?.id;
  check("draft save returns a history id", r.status === 200 && /^h_/.test(draftId || ""), r.text);
  check("draft is stored and flagged", history().length === 1 && history()[0].data.draft === true);
  const createdAt = history()[0].data.createdAt;

  await sleep(15);
  r = await api("POST", "/api/storage/cards", { isPermanent: false, replaceHistoryId: draftId, characterName: "A", character: { name: "A", description: "v2" }, imageBase64: PNG }, token);
  check("replace keeps the same id", r.json?.id === draftId, r.text);
  check("replace does not add an item", history().length === 1, history().length);
  check("replace updates the card and clears the draft flag", history()[0].data.character.description === "v2" && !history()[0].data.draft);
  check("replace keeps createdAt", history()[0].data.createdAt === createdAt);
  r = await api("GET", `/api/storage/cards/${draftId}`, undefined, token);
  check("replaced card reads back with its portrait", r.json?.character?.description === "v2" && String(r.json?.imageBase64 || "").startsWith("data:image/png"), Object.keys(r.json || {}));

  r = await api("POST", "/api/storage/cards", { isPermanent: false, replaceHistoryId: draftId, characterName: "A", character: { name: "A", description: "v3" } }, token);
  r = await api("GET", `/api/storage/cards/${draftId}`, undefined, token);
  check("an update with no portrait keeps the stored one", String(r.json?.imageBase64 || "").startsWith("data:image/png") && r.json.character.description === "v3");

  r = await api("POST", "/api/storage/cards", { isPermanent: false, replaceHistoryId: "h_does_not_exist", character: { name: "B" } }, token);
  check("unknown replace id saves a new item", history().length === 2 && r.json.id !== "h_does_not_exist");
  r = await api("POST", "/api/storage/cards", { isPermanent: false, replaceHistoryId: "../../etc/passwd", character: { name: "C" } }, token);
  check("a path-like replace id is ignored", r.status === 200 && /^h_\d+_/.test(r.json.id) && history().length === 3);

  backend.failHistoryWrites = true;
  r = await api("POST", "/api/storage/cards", { isPermanent: false, character: { name: "X" } }, token);
  check("a failed write is reported, not swallowed", r.status >= 500 && history().length === 3, r.status);
  backend.failHistoryWrites = false;

  backend.failHistoryReads = true;
  r = await api("POST", "/api/storage/cards", { isPermanent: false, character: { name: "D" } }, token);
  backend.failHistoryReads = false;
  check("a failed read still saves and deletes nothing", r.status === 200 && history().length === 4, history().length);

  for (let i = 0; i < 30; i++) {
    await api("POST", "/api/storage/cards", { isPermanent: false, character: { name: `N${i}` } }, token);
  }
  const names = history().map((h) => h.data.character.name);
  check("history is capped at 30", history().length === 30, history().length);
  check("the oldest were evicted, the newest kept", !names.includes("A") && !names.includes("B") && names.includes("N29") && names.includes("N0"), names.join(","));
  // start the browser part from a clean History
  for (const h of history()) await api("DELETE", `/api/storage/cards/${h.id}`, undefined, token);
  await until(() => history().length === 0, { what: "history cleared" });

  // ── B. The real page ──────────────────────────────────────────────────────
  const browser = await webkit.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await context.addInitScript((t) => { try { localStorage.setItem("cardgen_auth_token", t); } catch (_) {} }, token);
  const pageErrors = [];
  const open = async () => {
    const page = await context.newPage();
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.goto(stack.url + "/", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!window.app && window.app.storageReady === true, null, { timeout: 20000 });
    await page.evaluate(() => document.getElementById("tab-cardgen")?.click());
    return page;
  };
  const marker = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("cardgen.newCard.v1") || "null"));
  const pendingJobs = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("cardgen.pendingJobs") || "[]"));
  const startGenerate = async (page, concept = "a lighthouse keeper") => {
    await page.evaluate((c) => {
      const details = document.getElementById("input-section-details");
      if (details) details.open = true;
      document.getElementById("character-concept").value = c;
    }, concept);
    await page.evaluate(() => { window.app.handleGenerate(); });
  };
  const nameOnScreen = (page) => page.evaluate(() => document.getElementById("character-generated-name")?.value || "");
  const idle = (page) => page.waitForFunction(() => window.app.isGenerating === false, null, { timeout: 20000 });

  let page = await open();
  check("page rendered at 390px (generate button present)", await page.evaluate(() => !!document.getElementById("generate-btn") && document.getElementById("view-cardgen").style.display !== "none"));
  check("nothing to recover on a clean load", (await marker(page)) === null && (await nameOnScreen(page)) === "");

  // B1. A normal run: draft appears mid-pipeline, final save replaces it.
  let hold = model.hold("finishing", 1);
  await startGenerate(page);
  await until(() => hold.reached, { what: "finishing call to start" });
  await until(() => history().length === 1, { what: "draft in history" });
  check("card is in History while the later steps are still running", history()[0].data.draft === true && history()[0].data.character.name === "Mira Okafor", JSON.stringify(history()[0]?.data?.character?.name));
  const m1 = await until(async () => { const m = await marker(page); return m?.historyId ? m : null; }, { what: "marker with history id" });
  check("marker records the draft's id", m1.historyId === history()[0].id && m1.cardType === "single");
  const firstId = history()[0].id;
  hold.release();
  await idle(page);
  await until(() => history().length === 1 && !history()[0].data.draft, { what: "final save" });
  check("final save replaced the draft (one History item, same id)", history().length === 1 && history()[0].id === firstId && !!history()[0].data.character.mesExample, JSON.stringify(history().map((h) => [h.id, !!h.data.draft])));
  check("marker cleared when the pipeline finished", (await marker(page)) === null);
  check("card shown", (await nameOnScreen(page)) === "Mira Okafor");
  check("one card call and one finishing call", model.count("card") === 1 && model.count("finishing") === 1, `${model.count("card")}/${model.count("finishing")}`);
  check("every model call was streamed", model.calls.every((c) => c.stream), model.calls.filter((c) => !c.stream).map((c) => c.kind).join(","));

  // B2. Single-field calls are resumable streams now.
  const before = model.calls.length;
  await page.evaluate(() => window.app.handleRegenerateCreatorNotes());
  await until(async () => (await page.evaluate(() => document.getElementById("creator-notes").value)) === "Notes written on their own.", { what: "notes redo" });
  const notesCall = model.calls.slice(before).find((c) => c.kind === "notes");
  check("creator's notes Redo is streamed", !!notesCall && notesCall.stream === true);
  check("no pending job left behind after a finished call", (await pendingJobs(page)).length === 0, JSON.stringify(await pendingJobs(page)));

  // B3. Tab discarded while the finishing fields are being written.
  for (const h of history()) await api("DELETE", `/api/storage/cards/${h.id}`, undefined, token);
  await until(() => history().length === 0, { what: "history cleared" });
  let cardCalls = model.count("card"), finCalls = model.count("finishing");
  hold = model.hold("finishing", 1);
  await startGenerate(page);
  await until(() => hold.reached && history().length === 1, { what: "draft + held finishing call" });
  await until(async () => (await marker(page))?.historyId, { what: "marker id" });
  await page.close({ runBeforeUnload: false });          // the tab is gone
  hold.release();                                          // the proxy finishes the job on its own
  await sleep(400);
  page = await open();
  await until(async () => (await nameOnScreen(page)) === "Mira Okafor", { what: "recovered card on screen" });
  check("discard during finishing: card is back on screen", true);
  await until(async () => (await page.evaluate(() => (document.getElementById("example-messages-output").value || document.getElementById("example-messages-output").textContent || ""))).includes("Always"), { what: "recovered example messages" });
  check("discard during finishing: the held finishing reply was applied", true);
  await until(() => history().length === 1 && !history()[0].data.draft && !!history()[0].data.character.creatorNotes, { what: "history updated after recovery" });
  check("discard during finishing: History has one complete item", history().length === 1);
  check("discard during finishing: nothing was generated twice", model.count("card") === cardCalls + 1 && model.count("finishing") === finCalls + 1, `${model.count("card") - cardCalls}/${model.count("finishing") - finCalls}`);
  check("marker cleared after recovery", (await marker(page)) === null);
  check("recovery says so", await page.evaluate(() => [...document.querySelectorAll(".notification")].some((n) => /Recovered Mira Okafor/.test(n.textContent))));

  // B4. Tab discarded while the card itself is being written; reopened after it finished.
  for (const h of history()) await api("DELETE", `/api/storage/cards/${h.id}`, undefined, token);
  await until(() => history().length === 0, { what: "history cleared" });
  cardCalls = model.count("card"); finCalls = model.count("finishing");
  hold = model.hold("card", 2);
  await page.evaluate(() => { window.app.handleClearNew?.(); });
  await startGenerate(page);
  await until(() => hold.reached, { what: "card call held" });
  await until(async () => (await pendingJobs(page)).some((j) => j.label === "Character card"), { what: "pending card job recorded" });
  check("no draft yet while the card is still being written", history().length === 0);
  await page.close({ runBeforeUnload: false });
  hold.release();
  await sleep(600);
  page = await open();
  await until(async () => (await nameOnScreen(page)) === "Mira Okafor", { what: "card recovered from the held job" });
  check("discard during the card: recovered from the proxy's job", true);
  await until(() => history().length === 1, { what: "recovered card saved" });
  check("discard during the card: saved to History once", history().length === 1 && history()[0].data.character.name === "Mira Okafor" && !history()[0].data.draft);
  check("discard during the card: no second card call, no paid calls by recovery", model.count("card") === cardCalls + 1 && model.count("finishing") === finCalls, `${model.count("card") - cardCalls}/${model.count("finishing") - finCalls}`);
  check("recovery lists what is still missing", await page.evaluate(() => /Still to generate: example messages, creator's notes, post-history instructions, portrait/.test(document.getElementById("stream-content").textContent)));
  check("pending job entry removed", !(await pendingJobs(page)).some((j) => j.label === "Character card"));

  // B5. Same, but the page is reopened while the card is STILL being written.
  for (const h of history()) await api("DELETE", `/api/storage/cards/${h.id}`, undefined, token);
  await until(() => history().length === 0, { what: "history cleared" });
  cardCalls = model.count("card");
  hold = model.hold("card", 2);
  await page.evaluate(() => { window.app.handleClearNew?.(); });
  await startGenerate(page);
  await until(() => hold.reached, { what: "card call held" });
  await until(async () => (await pendingJobs(page)).some((j) => j.label === "Character card"), { what: "pending card job recorded" });
  await page.close({ runBeforeUnload: false });
  page = await open();
  await sleep(1200);
  check("reopened mid-write: nothing shown yet, still waiting", (await nameOnScreen(page)) === "");
  hold.release();
  await until(async () => (await nameOnScreen(page)) === "Mira Okafor", { what: "card recovered once the job finished", timeout: 20000 });
  check("reopened mid-write: card appears when the job finishes", model.count("card") === cardCalls + 1);
  await until(() => history().length === 1, { what: "recovered card saved" });
  await sleep(300);

  // B6. A second tab opened while the first is generating must not "recover" it.
  for (const h of history()) await api("DELETE", `/api/storage/cards/${h.id}`, undefined, token);
  await until(() => history().length === 0, { what: "history cleared" });
  hold = model.hold("finishing", 1);
  await page.evaluate(() => { window.app.handleClearNew?.(); });
  await startGenerate(page);
  await until(() => hold.reached && history().length === 1, { what: "first tab mid-pipeline" });
  const page2 = await open();
  await sleep(1200);
  check("second tab leaves the first tab's card alone", (await nameOnScreen(page2)) === "" && (await marker(page)) !== null);
  await page2.close();
  hold.release();
  await idle(page);
  await until(() => history().length === 1 && !history()[0].data.draft, { what: "first tab finished" });
  check("first tab finished normally with one History item", history().length === 1);

  // B7. Stop after the text step: the card stays in History as a draft, and the
  //     next unrelated save must not overwrite it.
  for (const h of history()) await api("DELETE", `/api/storage/cards/${h.id}`, undefined, token);
  await until(() => history().length === 0, { what: "history cleared" });
  hold = model.hold("finishing", 1);
  await page.evaluate(() => { window.app.handleClearNew?.(); });
  await startGenerate(page);
  await until(() => hold.reached && history().length === 1, { what: "mid-pipeline" });
  await page.evaluate(() => window.app.handleStop());
  hold.release();
  await idle(page);
  await sleep(300);
  check("Stop keeps the draft in History", history().length === 1 && history()[0].data.draft === true);
  check("Stop clears the marker", (await marker(page)) === null);
  const draftKept = history()[0].id;
  await page.evaluate(async () => {
    window.app.currentCharacter = { name: "Someone Else", description: "x", personality: "", scenario: "", firstMessage: "" };
    await window.app.saveCardToLibrary();
  });
  await until(() => history().length === 2, { what: "second save" });
  check("a later save adds a new item instead of replacing the stopped draft", history().some((h) => h.id === draftKept && h.data.draft) && history().some((h) => h.data.character.name === "Someone Else"));

  // B8. Reload after a clean finish: nothing is "recovered".
  await page.close();
  page = await open();
  await sleep(800);
  check("clean reload recovers nothing", (await nameOnScreen(page)) === "" && (await marker(page)) === null);

  // B9. Layout: no sideways scroll at 390 and 320.
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 800 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(`no sideways scroll at ${width}px`, overflow <= 1, overflow);
  }

  check("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));

  await browser.close();
  await stack.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
