// Card runs from the page's side, in headless WebKit at iPhone width, plus the
// check that the proxy's prompt host builds the very prompts the page does.
// See README.md for how to run.
const os = require("os");
const path = require("path");
const { webkit } = require(process.env.PLAYWRIGHT_CORE || "playwright-core");
const { start, sleep, replyKind, REPLIES } = require("./stack");

const repo = path.resolve(__dirname, "..", "..");
const { createPromptHost } = require(path.join(repo, "proxy", "runs", "prompt-host.js"));

let failed = 0, passed = 0;
const check = (name, ok, detail = "") => {
  if (ok) { passed++; console.log("ok   " + name); }
  else { failed++; console.log("FAIL " + name + (detail ? "\n     " + String(detail).slice(0, 600) : "")); }
};
const until = async (fn, { timeout = 20000, step = 50, what = "condition" } = {}) => {
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
  const clearHistory = async () => { for (const h of history()) await api("DELETE", `/api/storage/cards/${h.id}`, undefined, token); await until(() => history().length === 0, { what: "history cleared" }); };
  const setConfig = (app = {}, image = {}) => api("POST", "/api/config", { ...stack.config, api: { ...stack.config.api, image: { ...stack.config.api.image, ...image } }, app: { ...stack.config.app, ...app } }, token);
  const browser = await webkit.launch();
  const pageErrors = [];

  const newContext = async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    await context.addInitScript((t) => { try { localStorage.setItem("cardgen_auth_token", t); } catch (_) {} }, token);
    return context;
  };
  const open = async (context) => {
    const page = await context.newPage();
    page.on("pageerror", (e) => pageErrors.push(e.message));
    page.__requests = [];
    page.on("request", (req) => page.__requests.push(`${req.method()} ${new URL(req.url()).pathname}${new URL(req.url()).search}`));
    await page.goto(stack.url + "/", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!window.app && window.app.storageReady === true, null, { timeout: 20000 });
    await page.evaluate(() => document.getElementById("tab-cardgen")?.click());
    return page;
  };
  const generate = (page, { concept = "a lighthouse keeper", name = "", pov = "third", cardType = "single" } = {}) => page.evaluate((o) => {
    document.getElementById("input-section-details").open = true;
    document.getElementById("character-concept").value = o.concept;
    document.getElementById("character-name").value = o.name;
    document.getElementById("pov-select").value = o.pov;
    const type = document.getElementById("card-type-select");
    if (type.value !== o.cardType) { type.value = o.cardType; type.dispatchEvent(new Event("change")); }
    document.getElementById("pov-select").value = o.cardType === "single" ? o.pov : document.getElementById("pov-select").value;
    window.app.handleGenerate();
  }, { concept, name, pov, cardType });
  const idle = (page) => page.waitForFunction(() => window.app.isGenerating === false, null, { timeout: 30000 });
  const nameOnScreen = (page) => page.evaluate(() => document.getElementById("character-generated-name")?.value || "");
  const fieldOnScreen = (page, id) => page.evaluate((i) => { const el = document.getElementById(i); return el ? (el.value || el.textContent || "") : ""; }, id);
  const streamText = (page) => page.evaluate(() => document.getElementById("stream-content").textContent);
  const marker = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("cardgen.newCard.v1") || "null"));
  const runStatus = async (id) => (await api("GET", `/api/card-runs/${id}`, undefined, token)).json;
  const textCalls = (page) => page.__requests.filter((r) => r.startsWith("POST /api/text/")).length;
  const polls = (page) => page.__requests.filter((r) => /^GET \/api\/card-runs\/[a-f0-9-]{36}/.test(r)).length;

  // ── G. The prompt host builds what the page builds ─────────────────────────
  // Same settings, same inputs, same random sequence from the moment the card
  // prompt is built: the requests must match message for message.
  const SEED_PAGE = () => {
    let seed = 1;
    Math.random = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    const proto = window.apiHandler.constructor.prototype;
    const original = proto.buildCharacterPrompt;
    proto.buildCharacterPrompt = function (...args) { seed = 12345; return original.apply(this, args); };
  };
  const cases = [
    { label: "single, third person", concept: "a lighthouse keeper on the Cornish coast", name: "", pov: "third", cardType: "single" },
    { label: "single, first person, named", concept: "a smuggler who talks too much", name: "Silas Vane", pov: "first", cardType: "single" },
    { label: "group", concept: "a street gang that runs the docks", name: "", pov: "third", cardType: "group" },
    { label: "scenario", concept: "a derelict lighthouse where the lamp still turns", name: "", pov: "third", cardType: "scenario" },
  ];
  await setConfig({ serverRuns: false });
  for (const c of cases) {
    await clearHistory();
    const context = await newContext();
    const page = await open(context);
    await page.evaluate(SEED_PAGE);
    const pageSettings = await page.evaluate(() => JSON.parse(JSON.stringify(window.config.config)));
    const from = model.calls.length;
    await generate(page, c);
    await idle(page);
    const pageCalls = model.calls.slice(from).filter((x) => x.kind.startsWith("card") || x.kind === "finishing");
    await context.close();

    let seed = 1;
    const hostCalls = [];
    const host = createPromptHost({
      settings: pageSettings,
      random: () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296,
      strict: true,
      callText: async (body, { onContent } = {}) => {
        hostCalls.push(body);
        const content = REPLIES[replyKind(body)] ?? REPLIES.other;
        if (onContent) onContent(content);
        return { content, finishReason: "stop", reasoningChars: 0, usage: null };
      },
    });
    const original = host.api.buildCharacterPrompt;
    host.api.buildCharacterPrompt = function (...args) { seed = 12345; return original.apply(this, args); };
    const card = await host.characterGenerator.generateCharacter(c.concept, c.name, () => {}, c.cardType === "single" ? c.pov : "third", null, c.cardType);
    card.cardType = c.cardType;
    await host.api.fillFinishingFields(card, { count: 3, pov: c.cardType === "single" ? c.pov : "third", brief: c.concept, exampleStyle: "", lorebookEntries: [] });

    const shape = (body) => JSON.stringify({ model: body.model, temperature: body.temperature, max_tokens: Math.max(body.max_tokens, 4096), messages: body.messages });
    const same = pageCalls.length === hostCalls.length && pageCalls.length >= 2 && pageCalls.every((p, i) => shape(p.body) === shape(hostCalls[i]));
    let detail = `${pageCalls.length} page calls vs ${hostCalls.length} host calls`;
    if (!same && pageCalls.length === hostCalls.length) {
      const i = pageCalls.findIndex((p, k) => shape(p.body) !== shape(hostCalls[k]));
      const a = shape(pageCalls[i].body), b = shape(hostCalls[i]);
      let at = 0;
      while (at < a.length && a[at] === b[at]) at++;
      detail = `call ${i} differs at char ${at}: page …${a.slice(Math.max(0, at - 60), at + 80)}…  host …${b.slice(Math.max(0, at - 60), at + 80)}…`;
    }
    check(`prompt host matches the page: ${c.label}`, same, detail);
    check(`prompt host never reached for the page: ${c.label}`, host.pageAccess().length === 0, host.pageAccess().join(", "));
  }

  // ── R. Runs, as the page sees them ─────────────────────────────────────────
  await setConfig({ serverRuns: true });
  await clearHistory();
  let context = await newContext();
  let page = await open(context);
  check("page rendered at 390px with the setting on", await page.evaluate(() => !!document.getElementById("generate-btn") && window.app.serverRunsEnabled() === true && document.getElementById("server-runs").checked === true));

  // R1. An ordinary generate, page watching throughout.
  let cardCalls = model.count("card"), finCalls = model.count("finishing");
  await generate(page);
  await idle(page);
  await until(() => history().length === 1 && !history()[0].data.draft, { what: "final save" });
  check("server run: the card is on screen with its finishing fields", (await nameOnScreen(page)) === "Mira Okafor" && (await fieldOnScreen(page, "creator-notes")).includes("slow-burn") && (await fieldOnScreen(page, "example-messages-output")).includes("Always"));
  check("server run: the page made no text request of its own", textCalls(page) === 0, page.__requests.filter((r) => r.includes("/api/text")).join(", "));
  check("server run: one card call and one finishing call", model.count("card") === cardCalls + 1 && model.count("finishing") === finCalls + 1);
  check("server run: the page's final save replaced the run's History item", history().length === 1 && !history()[0].data.draft && !!history()[0].data.character.creatorNotes);
  check("server run: the card text streamed into the output box", (await streamText(page)).includes("# Mira Okafor's Profile") && (await streamText(page)).includes("Character generation complete"));
  check("server run: marker cleared at the end", (await marker(page)) === null);

  // R2. Hidden: no polling, the run finishes anyway, and the page catches up on return.
  await clearHistory();
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => window.__vis || "visible" });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => (window.__vis || "visible") !== "visible" });
    window.__setVis = (v) => { window.__vis = v; document.dispatchEvent(new Event("visibilitychange")); };
  });
  let hold = model.hold("finishing", 1);
  await page.evaluate(() => window.app.handleClearNew());
  await generate(page);
  await until(() => hold.reached, { what: "finishing step" });
  const runId2 = (await until(async () => (await marker(page))?.runId, { what: "run id in marker" }));
  await page.evaluate(() => window.__setVis("hidden"));
  await sleep(400);
  const pollsBefore = polls(page);
  hold.release();
  await until(async () => (await runStatus(runId2)).status === "done", { what: "run done while hidden" });
  await sleep(2500);
  check("hidden page: the run finished on the server", (await runStatus(runId2)).status === "done");
  check("hidden page: no polling while hidden", polls(page) === pollsBefore, `${polls(page) - pollsBefore} polls`);
  check("hidden page: still 'generating' as far as the page knows", await page.evaluate(() => window.app.isGenerating === true));
  await page.evaluate(() => window.__setVis("visible"));
  await idle(page);
  check("hidden page: catches up when shown again", (await nameOnScreen(page)) === "Mira Okafor" && (await fieldOnScreen(page, "creator-notes")).includes("slow-burn"));
  await until(() => history().length === 1 && !history()[0].data.draft, { what: "final save" });

  // R3. Tab discarded mid-run; reopened after the run finished.
  await clearHistory();
  cardCalls = model.count("card"); finCalls = model.count("finishing");
  hold = model.hold("finishing", 1);
  await page.evaluate(() => window.app.handleClearNew());
  await generate(page);
  await until(() => hold.reached, { what: "finishing step" });
  const runId3 = await until(async () => (await marker(page))?.runId, { what: "run id" });
  await page.close({ runBeforeUnload: false });
  hold.release();
  await until(async () => (await runStatus(runId3)).status === "done", { what: "run done with no page" });
  check("discarded tab: the run finished with nobody watching", history().length === 1 && history()[0].data.character.creatorNotes.includes("slow-burn"));
  page = await open(context);
  await until(async () => (await nameOnScreen(page)) === "Mira Okafor", { what: "finished card shown on reload" });
  check("discarded tab: the finished card is on screen after reopening", (await fieldOnScreen(page, "creator-notes")).includes("slow-burn") && (await fieldOnScreen(page, "example-messages-output")).includes("Always"));
  check("discarded tab: says the server finished it", /was finished by the server while the app was closed/.test(await streamText(page)));
  check("discarded tab: nothing was generated twice", model.count("card") === cardCalls + 1 && model.count("finishing") === finCalls + 1 && textCalls(page) === 0);
  check("discarded tab: marker cleared", (await marker(page)) === null);
  check("discarded tab: one done report was sent for the run", backend.pushes.some((p) => p.items[0].ok && p.items[0].label === "New character"));

  // R4. Tab discarded mid-run; reopened while it is STILL running: attach and finish.
  await clearHistory();
  cardCalls = model.count("card"); finCalls = model.count("finishing");
  hold = model.hold("card", 2);
  await page.evaluate(() => window.app.handleClearNew());
  await generate(page);
  await until(() => hold.reached, { what: "card step" });
  await until(async () => (await marker(page))?.runId, { what: "run id" });
  await page.close({ runBeforeUnload: false });
  page = await open(context);
  await until(async () => page.evaluate(() => window.app.isGenerating === true), { what: "attached to the run" });
  check("reopened mid-run: the page attaches and shows it as generating", /being made on the server/.test(await streamText(page)));
  hold.release();
  await idle(page);
  check("reopened mid-run: the card arrives", (await nameOnScreen(page)) === "Mira Okafor" && (await fieldOnScreen(page, "creator-notes")).includes("slow-burn"));
  check("reopened mid-run: the text written before the reload is shown too", (await streamText(page)).includes("# Mira Okafor's Profile"));
  check("reopened mid-run: nothing was generated twice", model.count("card") === cardCalls + 1 && model.count("finishing") === finCalls + 1 && textCalls(page) === 0);
  check("reopened mid-run: one History item", history().length === 1);
  check("reopened mid-run: marker cleared at the end", (await marker(page)) === null);

  // R5. Stop reaches the server.
  await clearHistory();
  hold = model.hold("finishing", 1);
  await page.evaluate(() => window.app.handleClearNew());
  await generate(page);
  await until(() => hold.reached, { what: "finishing step" });
  const runId5 = await until(async () => (await marker(page))?.runId, { what: "run id" });
  await page.evaluate(() => window.app.handleStop());
  await until(async () => (await runStatus(runId5)).status === "stopped", { what: "run stopped on the server" });
  hold.release();
  await idle(page);
  check("Stop: the run stopped on the server", (await runStatus(runId5)).status === "stopped");
  await sleep(300);
  check("Stop: the page says stopped and is idle", /Generation stopped/.test(await streamText(page)) && (await marker(page)) === null, `marker=${JSON.stringify(await marker(page))} stream=${(await streamText(page)).slice(-300)}`);
  check("Stop: the card written so far stays in History", history().length === 1 && history()[0].data.draft === true);

  // R5b. Generate again immediately after Stop: the stopped pipeline's cleanup
  //      must not reset the new one.
  await clearHistory();
  hold = model.hold("finishing", 1);
  await page.evaluate(() => window.app.handleClearNew());
  await generate(page);
  await until(() => hold.reached, { what: "finishing step" });
  hold.release();
  const holdNext = model.hold("finishing", 1);
  await page.evaluate(() => { window.app.handleStop(); window.app.handleClearNew(); });
  await generate(page, { concept: "a second lighthouse keeper" });
  await until(() => holdNext.reached, { what: "second run's finishing step" });
  await sleep(400);
  check("Generate straight after Stop: the new run is still 'generating' and keeps its marker", await page.evaluate(() => window.app.isGenerating === true) && !!(await marker(page))?.runId, JSON.stringify(await marker(page)));
  holdNext.release();
  await idle(page);
  check("Generate straight after Stop: the new run finishes normally", (await nameOnScreen(page)) === "Mira Okafor" && (await marker(page)) === null);

  // R6. The proxy restarts mid-run while the page is watching.
  await clearHistory();
  cardCalls = model.count("card");
  hold = model.hold("finishing", 1);
  await page.evaluate(() => window.app.handleClearNew());
  await generate(page);
  await until(() => hold.reached && history().length === 1, { what: "mid-run" });
  await stack.restartProxy();
  hold.release();
  await idle(page);
  check("proxy restart: the page resumes the run by itself and finishes", (await nameOnScreen(page)) === "Mira Okafor" && (await fieldOnScreen(page, "creator-notes")).includes("slow-burn"), await streamText(page));
  check("proxy restart: the card was not written again", model.count("card") === cardCalls + 1);
  check("proxy restart: the page said what happened", /The server restarted/.test(await streamText(page)), (await streamText(page)).slice(-500));

  // R6b. Gateway errors while polling (nginx answering for a proxy that is
  //      restarting) are waited out, not treated as the run failing. Its own
  //      context with service workers blocked: Playwright cannot intercept a
  //      WebKit page's requests once the app's service worker is registered.
  await clearHistory();
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
    await ctx.addInitScript((t) => { try { localStorage.setItem("cardgen_auth_token", t); } catch (_) {} }, token);
    const pg = await open(ctx);
    const held = model.hold("finishing", 1);
    await generate(pg);
    await until(() => held.reached, { what: "finishing step" });
    let gateway = 0;
    await pg.route(/\/api\/card-runs\/[a-f0-9-]{36}\?/, (route) => {
      if (gateway++ < 3) return route.fulfill({ status: 502, contentType: "text/html", body: "<html>Bad Gateway</html>" });
      return route.continue();
    });
    await until(() => gateway >= 2, { what: "gateway errors served" });
    check("gateway errors: the page keeps waiting", await pg.evaluate(() => window.app.isGenerating === true), `gateway=${gateway}`);
    held.release();
    await idle(pg);
    check("gateway errors: the card arrives once the server answers", (await nameOnScreen(pg)) === "Mira Okafor" && (await fieldOnScreen(pg, "creator-notes")).includes("slow-burn") && gateway >= 3, `gateway=${gateway} stream=${(await streamText(pg)).slice(-200)}`);
    await until(() => history().length === 1 && !history()[0].data.draft, { what: "final save" });
    await ctx.close();
  }

  // R7. The portrait is drawn by the run, once. The page that started it shows
  //     it; a second device that attaches looks on. Neither page draws anything.
  await setConfig({ serverRuns: true, enableImageGeneration: true }, stack.imageSettings());
  await clearHistory();
  await page.close();
  page = await open(context);
  let imageCalls = model.count("image");
  hold = model.hold("finishing", 1);
  await generate(page);
  await until(() => hold.reached, { what: "finishing step" });
  const context2 = await newContext();           // another device: its own storage, same account
  const page2 = await open(context2);
  await until(async () => page2.evaluate(() => window.app.isGenerating === true), { what: "second device attached" });
  hold.release();
  await idle(page);
  await idle(page2);
  const portraitShown = (p) => p.evaluate(() => { const img = document.querySelector("#image-content img.generated-image"); return !!img && img.naturalWidth > 0; });
  await until(async () => portraitShown(page), { what: "portrait on the first page" });
  check("server portrait: both devices show the card", (await nameOnScreen(page)) === "Mira Okafor" && (await nameOnScreen(page2)) === "Mira Okafor");
  check("server portrait: the image API was called once, by the run", model.count("image") === imageCalls + 1, model.count("image") - imageCalls);
  check("server portrait: neither page made an image or text request", [page, page2].every((p) => !p.__requests.some((r) => r.startsWith("POST /api/image/") || r.startsWith("POST /api/text/"))), page.__requests.concat(page2.__requests).filter((r) => r.includes("/api/image/g") || r.includes("/api/text")).join(", "));
  check("server portrait: the page that started it shows the portrait", await portraitShown(page));
  check("server portrait: the onlooker shows it too, loaded from History", await until(async () => portraitShown(page2), { what: "portrait on the second page" }));
  check("server portrait: the prompt that was used is in the prompt box", /lighthouse keeper/.test(await fieldOnScreen(page, "custom-image-prompt")), await fieldOnScreen(page, "custom-image-prompt"));
  await until(() => history().length === 1 && !history()[0].data.draft, { what: "final save" });
  const stored = await api("GET", `/api/storage/cards/${history()[0].id}`, undefined, token);
  check("server portrait: one History item, with the portrait, after the page's final save", history().length === 1 && String(stored.json?.imageBase64 || "").startsWith("data:image/"));
  await context2.close();

  // R7a. The run could not draw it: the page says so and does not try again itself.
  await clearHistory();
  model.failAll.image = 500;
  imageCalls = model.count("image");
  await page.evaluate(() => window.app.handleClearNew());
  await generate(page);
  await idle(page);
  delete model.failAll.image;
  check("failed server portrait: the card is shown and the failure is reported", (await nameOnScreen(page)) === "Mira Okafor" && /Image generation failed/.test(await streamText(page)) && /Image generation failed/.test(await page.evaluate(() => document.getElementById("image-content").textContent)));
  check("failed server portrait: the page did not draw one itself", !page.__requests.some((r) => r.startsWith("POST /api/image/")));

  // R7d. Auto-cast is a step of the run: the page shows it and does not repeat it,
  //      and the entries end up in the Lorebook Manager and in every later save.
  await setConfig({ serverRuns: true });
  await clearHistory();
  await page.close();
  page = await open(context);
  let castLists = model.count("cast-list");
  await page.evaluate(() => { document.getElementById("auto-generate-cast").checked = true; });
  await generate(page);
  await idle(page);
  await page.evaluate(() => { document.getElementById("auto-generate-cast").checked = false; });
  await until(() => history().length === 1 && !history()[0].data.draft, { what: "final save" });
  check("server cast: done once, by the run", model.count("cast-list") === castLists + 1 && textCalls(page) === 0, `${model.count("cast-list") - castLists} lists, ${textCalls(page)} page text calls`);
  check("server cast: the Lorebook Manager has both entries", await page.evaluate(() => window.app.lorebookEntries.length === 2 && window.app.lorebookEntries[0].keys[0] === "Tamsin Hale"));
  check("server cast: the card on screen names them", /Tamsin Hale/.test(await fieldOnScreen(page, "character-scenario")));
  check("server cast: the page's final save kept the lorebook", history()[0].data.character.character_book?.entries?.length === 2, JSON.stringify(history()[0].data.character.character_book)?.slice(0, 200));
  check("server cast: its progress is shown once", ((await streamText(page)).match(/Auto-generating supporting cast/g) || []).length === 1);

  // R7e. The same with the setting off: the page's own cast step, through the shared code.
  await setConfig({ serverRuns: false });
  await clearHistory();
  await page.close();
  page = await open(context);
  castLists = model.count("cast-list");
  await page.evaluate(() => { document.getElementById("auto-generate-cast").checked = true; });
  await generate(page);
  await idle(page);
  await page.evaluate(() => { document.getElementById("auto-generate-cast").checked = false; });
  await until(() => history().length === 1 && !history()[0].data.draft, { what: "final save" });
  check("page cast (setting off): still works, through the shared code", model.count("cast-list") === castLists + 1 && history()[0].data.character.character_book?.entries?.length === 2 && /Tamsin Hale/.test(history()[0].data.character.scenario) && /Supporting cast generated and injected/.test(await streamText(page)), await streamText(page));

  // R7b. 4 ideas and Inspire Me hand the picked idea to a run as well.
  await setConfig({ serverRuns: true });
  await clearHistory();
  await page.close();
  page = await open(context);
  cardCalls = model.count("card");
  await page.evaluate(() => {
    document.getElementById("character-concept").value = "a lighthouse keeper";
    window.app._batchIdeas = [{ name: "The Keeper", description: "A keeper who never sleeps." }];
    window.app.handleBatchPick(0);
  });
  await until(async () => page.evaluate(() => window.app.isGenerating === true), { what: "ideas pick started" });
  await idle(page);
  await until(() => history().length === 1 && !history()[0].data.draft, { what: "final save" });
  const ideasCall = model.calls.filter((c) => c.kind === "card").pop();
  check("4 ideas: the picked idea is written by a run", page.__requests.some((r) => r.startsWith("POST /api/card-runs")) && textCalls(page) === 0 && model.count("card") === cardCalls + 1 && (await nameOnScreen(page)) === "Mira Okafor");
  check("4 ideas: the brief and the chosen direction both reach the model", /PLAYER'S BRIEF[\s\S]*a lighthouse keeper[\s\S]*CHOSEN DIRECTION[\s\S]*The Keeper/.test(JSON.stringify(ideasCall.body.messages)));

  // R7c. The portrait request is the same whichever side makes it: the page
  //      (setting off) and the run (setting on) must write the same prompt
  //      request and send the same image request, bar the random seed.
  const portraitCalls = async (serverRuns) => {
    await setConfig({ serverRuns, enableImageGeneration: true }, stack.imageSettings());
    await clearHistory();
    const ctx = await newContext();
    const pg = await open(ctx);
    const from = model.calls.length;
    await generate(pg, { concept: "a lighthouse keeper on the Cornish coast" });
    await idle(pg);
    await until(() => model.calls.slice(from).some((c) => c.kind === "image"), { what: "image call" });
    await until(() => history().length === 1 && !history()[0].data.draft, { what: "final save" });
    await ctx.close();
    const calls = model.calls.slice(from);
    const strip = ({ seed, ...rest }) => rest;
    return {
      prompt: JSON.stringify(calls.find((c) => c.kind === "image-prompt")?.body.messages),
      image: JSON.stringify(strip(calls.find((c) => c.kind === "image").body)),
      temperature: calls.find((c) => c.kind === "image-prompt")?.body.temperature,
    };
  };
  const byPage = await portraitCalls(false);
  const byRun = await portraitCalls(true);
  const firstDiff = (a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return `at ${i}: page …${a.slice(Math.max(0, i - 80), i + 120)}…  run …${b.slice(Math.max(0, i - 80), i + 120)}…`; };
  check("portrait: the run writes the same prompt request as the page", !!byPage.prompt && byPage.prompt === byRun.prompt && byPage.temperature === byRun.temperature, firstDiff(byPage.prompt || "", byRun.prompt || ""));
  check("portrait: the run sends the same image request as the page", byPage.image === byRun.image, firstDiff(byPage.image, byRun.image));

  // ── V. Revise, Remaster and friends ────────────────────────────────────────
  const setField = (pg, id, value) => pg.evaluate(([i, v]) => { const el = document.getElementById(i); el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); }, [id, value]);
  const startRevise = (pg, instruction = "Make her warmer.") => pg.evaluate((text) => { document.getElementById("revision-instruction").value = text; window.app.handleReviseCharacter(); }, instruction);
  const diffOpen = (pg) => pg.evaluate(() => { const m = document.getElementById("card-diff-modal"); return !!m && (m.classList.contains("show") || getComputedStyle(m).display !== "none") && !!document.getElementById("card-diff-accept-btn"); });
  const answerDiff = (pg, accept) => pg.evaluate((yes) => document.getElementById(yes ? "card-diff-accept-btn" : "card-diff-reject-btn").click(), accept);
  const revising = (pg) => pg.evaluate(() => window.app.isRevising === true);
  const notRevising = (pg) => pg.waitForFunction(() => window.app.isRevising === false, null, { timeout: 30000 });
  const freshCard = async (serverRuns) => {
    await setConfig({ serverRuns });
    await clearHistory();
    await page.close();
    page = await open(context);
    await generate(page);
    await idle(page);
    await until(() => history().length === 1 && !history()[0].data.draft, { what: "card saved" });
    return history()[0].id;
  };

  // V1. Setting on, accepted.
  let originalId = await freshCard(true);
  let reviseCalls = model.count("revise");
  await startRevise(page);
  await until(() => diffOpen(page), { what: "diff dialog" });
  check("server revise: the proxy wrote it, not the page", model.count("revise") === reviseCalls + 1 && !page.__requests.some((r) => r.startsWith("POST /api/text/")));
  check("server revise: the revised copy is already in History, the original untouched", history().length === 2 && history().some((h) => h.id === originalId && !/REVISED/.test(h.data.character.description)));
  check("server revise: nothing on screen changes before the diff is accepted", !/REVISED/.test(await fieldOnScreen(page, "character-description")));
  await answerDiff(page, true);
  await notRevising(page);
  await until(() => history().length === 2 && history().every((h) => !h.data.draft), { what: "accepted save" });
  check("server revise accepted: the card on screen is the revised one, with its finishing fields", /REVISED to be warmer/.test(await fieldOnScreen(page, "character-description")) && (await fieldOnScreen(page, "creator-notes")).includes("slow-burn"));
  check("server revise accepted: the save replaced the run's copy rather than adding a third", history().length === 2);

  // V2. Setting on, discarded: the run's copy goes.
  await startRevise(page, "Now make her colder.");
  await until(() => diffOpen(page), { what: "diff dialog" });
  await until(() => history().length === 3, { what: "proposal in history" });
  await answerDiff(page, false);
  await notRevising(page);
  await until(() => history().length === 2, { what: "proposal removed" });
  check("server revise discarded: its History copy is removed", history().length === 2);

  // V3. Typing while it runs: what was typed wins, the AI's version stays in History.
  originalId = await freshCard(true);
  hold = model.hold("revise", 0);
  await startRevise(page);
  await until(() => hold.reached, { what: "rewrite held" });
  await setField(page, "character-scenario", "MY OWN SCENARIO, typed while the rewrite was running.");
  hold.release();
  await until(() => diffOpen(page), { what: "diff dialog" });
  await answerDiff(page, true);
  await notRevising(page);
  await until(() => history().length === 3, { what: "accepted save as its own item" });
  check("typed meanwhile: my text is what ends up on the card", (await fieldOnScreen(page, "character-scenario")).startsWith("MY OWN SCENARIO") && /REVISED to be warmer/.test(await fieldOnScreen(page, "character-description")));
  check("typed meanwhile: the AI's whole version is still in History", history().some((h) => /REVISED: the storm has passed/.test(h.data.character.scenario)) && history().some((h) => /MY OWN SCENARIO/.test(h.data.character.scenario)), history().map((h) => h.data.character.scenario.slice(0, 40)).join(" | "));
  check("typed meanwhile: the page says what it kept", await page.evaluate(() => [...document.querySelectorAll(".notification")].some((n) => /Kept what you typed in Scenario/.test(n.textContent))));

  // V4. Tab discarded mid-revision: the run finishes, and the reload shows the revised card.
  originalId = await freshCard(true);
  reviseCalls = model.count("revise");
  hold = model.hold("revise", 0);
  await startRevise(page);
  await until(() => hold.reached, { what: "rewrite held" });
  const reviseRunId = await until(async () => (await marker(page))?.runId, { what: "revise run id" });
  await page.close({ runBeforeUnload: false });
  hold.release();
  await until(async () => (await runStatus(reviseRunId)).status === "done", { what: "revision finished with no page" });
  check("discarded tab mid-revision: the proxy finished it and saved it", history().length === 2 && history().some((h) => /REVISED/.test(h.data.character.description)));
  page = await open(context);
  await until(async () => /REVISED to be warmer/.test(await fieldOnScreen(page, "character-description")), { what: "revised card on reload" });
  check("discarded tab mid-revision: the revised card is on screen after reopening", (await nameOnScreen(page)) === "Mira Okafor" && model.count("revise") === reviseCalls + 1);
  check("discarded tab mid-revision: the card before it is still there", history().some((h) => h.id === originalId && !/REVISED/.test(h.data.character.description)));
  check("discarded tab mid-revision: marker cleared", (await marker(page)) === null);

  // V5. Remaster applies without a diff; Stop reaches the server.
  originalId = await freshCard(true);
  await page.evaluate(() => { window.app.handleRemasterCurrentCard(); });
  await until(async () => /REVISED to be warmer/.test(await fieldOnScreen(page, "character-description")), { what: "remaster applied" });
  await notRevising(page);
  check("server remaster: applied straight to the card", /REVISED to be warmer/.test(await fieldOnScreen(page, "character-description")));
  hold = model.hold("revise", 0);
  await startRevise(page);
  await until(() => hold.reached, { what: "rewrite held" });
  const stopRunId = await until(async () => (await marker(page))?.runId, { what: "revise run id" });
  await page.evaluate(() => window.app.handleStopRevision());
  await until(async () => (await runStatus(stopRunId)).status === "stopped", { what: "revision stopped on the server" });
  hold.release();
  check("server revise: Stop reaches the server", (await runStatus(stopRunId)).status === "stopped" && !(await diffOpen(page)));

  // V6. Setting off: the page's own rewrite, same handlers, same keep-my-edits rule.
  originalId = await freshCard(false);
  reviseCalls = model.count("revise");
  hold = model.hold("revise", 0);
  await startRevise(page);
  await until(() => hold.reached, { what: "rewrite held" });
  await setField(page, "character-first-message", "MY OWN OPENING LINE.");
  hold.release();
  await until(() => diffOpen(page), { what: "diff dialog" });
  await answerDiff(page, true);
  await notRevising(page);
  check("page revise (setting off): works through the same handler", model.count("revise") === reviseCalls + 1 && page.__requests.some((r) => r.startsWith("POST /api/text/")) && !page.__requests.some((r) => r.startsWith("POST /api/card-runs")) && /REVISED to be warmer/.test(await fieldOnScreen(page, "character-description")));
  check("page revise (setting off): typed text wins and the AI's version goes to History", (await fieldOnScreen(page, "character-first-message")) === "MY OWN OPENING LINE." && history().some((h) => /REVISED: The door opens wide/.test(h.data.character.firstMessage)));

  // R8. With the setting off, nothing goes near the run routes.
  await setConfig({ serverRuns: false });
  await clearHistory();
  await page.close();
  page = await open(context);
  await generate(page);
  await idle(page);
  check("setting off: the page conducts the pipeline itself, as before", textCalls(page) >= 2 && !page.__requests.some((r) => r.startsWith("POST /api/card-runs")) && (await nameOnScreen(page)) === "Mira Okafor", page.__requests.filter((r) => r.includes("card-runs")).join(", "));

  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await page.evaluate(() => { document.getElementById("settings-btn")?.click(); });
    await sleep(150);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(`no sideways scroll at ${width}px with settings open`, overflow <= 1, overflow);
  }
  check("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));

  await browser.close();
  await stack.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
