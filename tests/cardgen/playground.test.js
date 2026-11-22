// Image Playground: pictures kept in Recent for a few days without pressing 💾,
// prompt history in the presets dropdowns, "2 per model", and the tool tabs above
// the drop zone. Real proxy + real page in headless WebKit. See README.md.
const fs = require("fs");
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
  const stack = await start({
    repo,
    stageDir: path.join(os.tmpdir(), "cardgen-test-stage-playground"),
    env: { PLAYGROUND_RECENT_MAX: "6" },
  });
  const { api, token, userId, model } = stack;
  const models = ["fake-a", "fake-b", "fake-c"];
  const caps = Object.fromEntries(models.map((m) => [m, { generate: true, edit: true }]));
  await api("POST", "/api/config", {
    ...stack.config,
    api: {
      ...stack.config.api,
      image: stack.imageSettings({ models, model: "fake-a", editModel: "fake-a", modelCapabilities: caps, compareModels: ["fake-a", "fake-b"] }),
    },
    app: { ...stack.config.app, enableImageGeneration: true },
  }, token);
  const recent = async (t = token) => (await api("GET", "/api/storage/playground-recent", undefined, t)).json;
  const recentDir = path.join(stack.dataDir, "users", String(userId), "playground-recent");

  // ── A. The proxy on its own ───────────────────────────────────────────────
  const imageHeaders = { "X-API-Key": "fake-image-key", "X-API-URL": stack.modelUrl };
  const draw = (body) => api("POST", "/api/image/generations", { model: "fake-a", prompt: "p", n: 1, resumable: true, ...body }, token, imageHeaders);

  let r = await draw({ prompt: "a red fox", __keep: { tool: "generate", prompt: "a red fox" } });
  check("a kept generation succeeds", r.status === 200, r.text);
  const lastCall = model.calls.filter((c) => c.kind === "image").pop();
  check("__keep never reaches the image provider", lastCall && !("__keep" in lastCall.body) && !("__landing" in lastCall.body), JSON.stringify(lastCall?.body));
  let list = await until(async () => { const l = await recent(); return l?.items?.length === 1 && l; }, { what: "kept picture" });
  check("the picture is in Recent with tool, model and prompt", list.items[0].tool === "generate" && list.items[0].model === "fake-a" && list.items[0].prompt === "a red fox", JSON.stringify(list.items[0]));
  check("Recent reports 3 days by default", list.keepDays === 3, list.keepDays);
  r = await fetch(stack.url + list.items[0].url + "?token=" + encodeURIComponent(token));
  check("the picture is served as an image", r.status === 200 && /^image\//.test(r.headers.get("content-type")), r.status);

  await draw({ prompt: "unkept" });
  await sleep(300);
  check("a request without __keep is not kept", (await recent()).items.length === 1);
  await draw({ prompt: "x", __keep: { tool: "bogus", prompt: "x" } });
  await sleep(300);
  check("an unknown tool is not kept", (await recent()).items.length === 1);

  model.failNext.image = 500;
  await draw({ prompt: "fails", __keep: { tool: "generate", prompt: "fails" } });
  await sleep(300);
  check("a failed generation keeps nothing", (await recent()).items.length === 1);

  const other = await stack.register();
  r = await fetch(stack.url + list.items[0].url + "?token=" + encodeURIComponent(other.token));
  check("another user can't fetch the picture", r.status === 404, r.status);
  check("another user's Recent is empty", (await recent(other.token)).items.length === 0);
  r = await api("DELETE", `/api/storage/playground-recent/${list.items[0].id}`, undefined, other.token);
  check("another user's delete leaves it alone", (await recent()).items.length === 1);
  r = await api("GET", "/api/storage/playground-recent/..%2F..%2Fusers.json/image", undefined, token);
  check("a path-like id is refused", r.status === 400 || r.status === 404, r.status);

  // Expiry: an entry dated 4 days ago goes, with its file.
  const indexFile = path.join(recentDir, "index.json");
  const stored = JSON.parse(fs.readFileSync(indexFile, "utf8"));
  const oldId = `r_${Date.now() - 4 * 86400000}_old0001`;
  fs.writeFileSync(path.join(recentDir, `${oldId}.img`), Buffer.from("x"));
  fs.writeFileSync(path.join(recentDir, "r_1700000000000_orphan1.img"), Buffer.from("x"));
  fs.writeFileSync(indexFile, JSON.stringify([...stored, { id: oldId, createdAt: Date.now() - 4 * 86400000, tool: "edit", model: "m", prompt: "old", mime: "image/png" }]));
  list = await recent();
  check("an entry older than 3 days is dropped", list.items.length === 1 && !list.items.some((i) => i.id === oldId), list.items.map((i) => i.id));
  check("its file is deleted, and an unlisted file too", !fs.existsSync(path.join(recentDir, `${oldId}.img`)) && !fs.existsSync(path.join(recentDir, "r_1700000000000_orphan1.img")));

  // Count cap (6 in this stack), newest kept; several finishing together lose none.
  await Promise.all(Array.from({ length: 7 }, (_, i) => draw({ prompt: `n${i}`, __keep: { tool: "edit", prompt: `n${i}` } })));
  list = await until(async () => { const l = await recent(); return l.items.length === 6 && l; }, { what: "cap" });
  const files = fs.readdirSync(recentDir).filter((f) => f.endsWith(".img"));
  check("the cap keeps the newest 6, files match the index", list.items.length === 6 && files.length === 6 && !list.items.some((i) => i.prompt === "a red fox"), `${list.items.length} items, ${files.length} files`);
  check("newest first", list.items.every((item, i, all) => i === 0 || all[i - 1].createdAt >= item.createdAt));

  // Prompt history.
  r = await api("POST", "/api/storage/playground-prompts", { tool: "generate", text: "first" }, token);
  r = await api("POST", "/api/storage/playground-prompts", { tool: "generate", text: "second" }, token);
  r = await api("POST", "/api/storage/playground-prompts", { tool: "generate", text: "first" }, token);
  check("a repeated prompt moves to the top, once", r.json.generate.map((e) => e.text).join(",") === "first,second", JSON.stringify(r.json.generate));
  for (let i = 0; i < 35; i++) await api("POST", "/api/storage/playground-prompts", { tool: "edit", text: `e${i}` }, token);
  r = await api("GET", "/api/storage/playground-prompts", undefined, token);
  check("history keeps 30, newest first", r.json.edit.length === 30 && r.json.edit[0].text === "e34" && r.json.edit[29].text === "e5", r.json.edit.length);
  r = await api("POST", "/api/storage/playground-prompts", { tool: "reimagine", text: "x" }, token);
  check("an unknown tool is refused", r.status === 400, r.status);
  r = await api("GET", "/api/storage/playground-prompts", undefined, other.token);
  check("another user's history is separate", r.json.generate.length === 0);

  // Clean slate for the page.
  for (const item of (await recent()).items) await api("DELETE", `/api/storage/playground-recent/${item.id}`, undefined, token);
  check("delete empties Recent", (await recent()).items.length === 0);

  // ── B. The real page ──────────────────────────────────────────────────────
  const browser = await webkit.launch();
  const pageErrors = [];
  const open = async (context) => {
    const page = await context.newPage();
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.goto(stack.url + "/", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!window.app && window.app.storageReady === true, null, { timeout: 20000 });
    await page.evaluate(() => document.getElementById("tab-playground")?.click());
    await page.waitForSelector("#view-playground", { state: "visible" });
    return page;
  };
  const idle = (page) => page.waitForFunction(() => !document.getElementById("generate-playground-image-btn").disabled, null, { timeout: 20000 });
  const recentOptions = (page, tool) => page.evaluate((t) =>
    [...document.querySelectorAll(`#playground-${t}-preset optgroup[label="Recent"] option`)].map((o) => o.textContent), tool);

  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await context.addInitScript((t) => { try { localStorage.setItem("cardgen_auth_token", t); } catch (_) {} }, token);
  let page = await open(context);

  // Layout: tabs above the drop zone.
  const h2 = await page.locator("#view-playground h2").boundingBox();
  const tabs = await page.locator("#playground-tool-tabs").boundingBox();
  const drop = await page.locator("#playground-drop-zone").boundingBox();
  check("tool tabs sit under the heading, above the drop zone", h2 && tabs && drop && tabs.y > h2.y && tabs.y + tabs.height <= drop.y, JSON.stringify({ h2, tabs, drop }));

  check("existing history shows as Recent in the Generate dropdown", (await until(() => recentOptions(page, "generate").then((o) => o.length === 2 && o))).join("|") === "first|second");

  // Generate from the page: kept, prompt remembered.
  await page.fill("#playground-generate-prompt", "a lighthouse at dusk");
  await page.click("#generate-playground-image-btn");
  await idle(page);
  list = await until(async () => { const l = await recent(); return l.items.length === 1 && l; }, { what: "page generation kept" });
  check("a Playground generation lands in Recent", list.items[0].tool === "generate" && list.items[0].prompt === "a lighthouse at dusk", JSON.stringify(list.items[0]));
  check("its prompt tops the Recent dropdown group", (await until(() => recentOptions(page, "generate").then((o) => o[0] === "a lighthouse at dusk" && o)))[0] === "a lighthouse at dusk");
  await page.fill("#playground-generate-prompt", "");
  const firstValue = await page.evaluate(() => document.querySelector('#playground-generate-preset optgroup[label="Recent"] option').value);
  await page.selectOption("#playground-generate-preset", firstValue);
  check("picking a Recent prompt fills the box", (await page.inputValue("#playground-generate-prompt")) === "a lighthouse at dusk");
  check("a Recent prompt can't be deleted as a preset", !(await page.locator("#playground-generate-preset-delete").isVisible()));

  // 2 per model: two each, both kept.
  await page.selectOption("#playground-generate-count", "models2");
  const before = model.calls.length;
  await page.click("#generate-playground-image-btn");
  await idle(page);
  const sent = model.calls.slice(before).filter((c) => c.kind === "image").map((c) => c.body.model).sort();
  check("2 per model sends two per ticked model", sent.join(",") === "fake-a,fake-a,fake-b,fake-b", sent.join(","));
  check("all four are kept", (await until(async () => (await recent()).items.length === 5)) === true);

  // Edit: kept as an edit, instruction remembered (not the generate prompt).
  await page.click("#pg-tab-edit");
  await page.fill("#playground-edit-instruction", "make it night time");
  await page.click("#edit-playground-image-btn");
  await page.waitForFunction(() => !document.getElementById("edit-playground-image-btn").disabled, null, { timeout: 20000 });
  list = await until(async () => { const l = await recent(); return l.items.length === 6 && l; }, { what: "edit kept" });
  check("an edit lands in Recent as an edit", list.items[0].tool === "edit" && list.items[0].prompt === "make it night time", JSON.stringify(list.items[0]));
  check("the edit instruction tops Edit's Recent group", (await until(() => recentOptions(page, "edit").then((o) => o[0] === "make it night time" && o)))[0] === "make it night time");

  // 🔍 Describe the working image.
  const DESCRIBED = require("./stack").REPLIES.describe;
  const describeIdle = () => page.waitForFunction(() => !document.getElementById("describe-playground-image-btn").disabled, null, { timeout: 20000 });
  const setHidden = (hidden) => page.evaluate((h) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (h ? "hidden" : "visible") });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
  check("🔍 Describe shows beside 💾 Save", await page.locator("#describe-playground-image-btn").isVisible());
  check("the description box starts hidden", !(await page.locator("#playground-describe-box").isVisible()));
  const describeHold = model.hold("describe", 1);
  const describesBefore = model.count("describe");
  await page.click("#describe-playground-image-btn");
  await until(() => describeHold.reached, { what: "describe held mid-stream" });
  check("the box opens while it writes, button disabled", await page.locator("#playground-describe-box").isVisible()
    && await page.locator("#describe-playground-image-btn").isDisabled());
  await until(async () => (await page.inputValue("#playground-describe-text")).length > 0, { what: "first chunk shown" });
  check("text streams into the box", DESCRIBED.startsWith(await page.inputValue("#playground-describe-text")));
  await setHidden(true);
  describeHold.release();
  await sleep(500);
  await setHidden(false);
  await describeIdle();
  check("the full description lands after a hide mid-stream", (await page.inputValue("#playground-describe-text")) === DESCRIBED, await page.inputValue("#playground-describe-text"));
  check("…from one model call", model.count("describe") === describesBefore + 1, model.count("describe") - describesBefore);
  const describeCall = model.calls.filter((c) => c.kind === "describe").pop();
  check("the call streams and sends the working image", describeCall.stream
    && JSON.stringify(describeCall.body.messages).includes("image_url"));

  const describeLabel = () => page.textContent("#describe-playground-image-btn").then((t) => t.trim());
  const describeShown = () => page.locator("#playground-describe-box").isVisible();
  check("while shown, the button offers to hide it", (await describeLabel()) === "🔍 Hide description", await describeLabel());
  await page.click("#describe-playground-image-btn");
  check("tapping it again hides the description", !(await describeShown()));
  check("…and offers it back", (await describeLabel()) === "🔍 Show description", await describeLabel());
  await page.click("#describe-playground-image-btn");
  check("showing it again costs no model call", await describeShown()
    && (await page.inputValue("#playground-describe-text")) === DESCRIBED
    && model.count("describe") === describesBefore + 1);
  model.failNext.describe = 500;
  await page.click("#playground-describe-again-btn");
  await describeIdle();
  check("a failed 🔄 Describe again keeps the description it was replacing", await describeShown()
    && (await page.inputValue("#playground-describe-text")) === DESCRIBED);
  const againBefore = model.count("describe");
  await page.click("#playground-describe-again-btn");
  await describeIdle();
  check("🔄 Describe again asks the model afresh", model.count("describe") > againBefore
    && (await page.inputValue("#playground-describe-text")) === DESCRIBED);
  const describeScroll = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check("description box: no sideways scroll at 390px", describeScroll <= 0, describeScroll);
  await page.locator("#playground-describe-box").screenshot({ path: path.join(os.tmpdir(), "playground-describe-390.png") });
  await page.click("#playground-describe-use-btn");
  check("🪄 Use to generate fills the Generate box", (await page.inputValue("#playground-generate-prompt")) === DESCRIBED);
  check("…and opens the Generate tab", await page.locator("#pg-panel-generate").isVisible());
  check("the description stays up for the same picture", await page.locator("#playground-describe-box").isVisible());
  await page.evaluate((url) => { window.app.playgroundImageUrl = url + "#other"; window.app.updatePlaygroundImagePreview(url + "#other"); }, PNG);
  check("a new working image hides the description", !(await page.locator("#playground-describe-box").isVisible()));
  check("…and the button describes afresh", (await describeLabel()) === "🔍 Describe", await describeLabel());

  model.failNext.describe = 500;
  await page.click("#describe-playground-image-btn");
  await describeIdle();
  check("a failed describe leaves no box and frees the button", !(await page.locator("#playground-describe-box").isVisible()));

  // Library → Recent.
  await page.click("#pg-tab-library");
  check("Library opens on Saved", (await page.getAttribute("#pg-library-view-saved", "aria-pressed")) === "true");
  await page.click("#pg-library-view-recent");
  await page.waitForFunction(() => document.querySelectorAll("#playground-library-grid > div").length === 6, null, { timeout: 10000 });
  const firstTile = page.locator("#playground-library-grid > div").first();
  check("Recent tiles are labelled by tool and model", /Edited \(fake-a\)/.test(await firstTile.textContent()), await firstTile.textContent());
  await page.waitForFunction(() => [...document.querySelectorAll("#playground-library-grid img")].every((img) => img.complete && img.naturalWidth > 0), null, { timeout: 10000 });
  check("Recent thumbnails load", true);
  await firstTile.locator("[data-pg-keep]").click();
  await until(async () => (await firstTile.locator("[data-pg-keep]").textContent()).includes("Kept"), { what: "kept" });
  r = await api("GET", "/api/storage/playground-images", undefined, token);
  check("💾 Keep copies it into Saved with its prompt", r.json.length === 1 && r.json[0].prompt === "make it night time" && /Edited/.test(r.json[0].label), JSON.stringify(r.json));
  check("…and it stays in Recent", (await recent()).items.length === 6);

  await page.click("#pg-library-view-saved");
  await page.waitForFunction(() => document.querySelectorAll("#playground-library-grid > div").length === 1, null, { timeout: 10000 });
  check("Saved shows the kept one, without a Keep button", (await page.locator("#playground-library-grid [data-pg-keep]").count()) === 0);
  await page.click("#pg-library-view-recent");
  await page.waitForFunction(() => document.querySelectorAll("#playground-library-grid > div").length === 6, null, { timeout: 10000 });
  page.once("dialog", (d) => d.accept());
  await page.locator("#playground-library-grid > div").first().locator("[data-pg-delete]").click();
  await page.waitForFunction(() => document.querySelectorAll("#playground-library-grid > div").length === 5, null, { timeout: 10000 });
  check("🗑️ removes it from Recent only", (await recent()).items.length === 5 && (await api("GET", "/api/storage/playground-images", undefined, token)).json.length === 1);
  const scrollW = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check("Recent view: no sideways scroll at 390px", scrollW <= 0, scrollW);
  await page.screenshot({ path: path.join(os.tmpdir(), "playground-recent-390.png") });

  // The iPhone case: the tab goes away mid-draw; the picture is kept anyway.
  await page.click("#pg-tab-generate");
  await page.selectOption("#playground-generate-count", "1");
  await page.fill("#playground-generate-prompt", "drawn while the tab was gone");
  const hold = model.hold("image");
  await page.click("#generate-playground-image-btn");
  await until(() => hold.reached, { what: "image request held" });
  await page.close();
  hold.release();
  list = await until(async () => { const l = await recent(); return l.items[0]?.prompt === "drawn while the tab was gone" && l; }, { what: "kept after the tab closed" });
  check("a picture finished after the tab closed is in Recent", true);
  await context.close();

  // Phone widths, dark.
  for (const width of [320, 430]) {
    const ctx = await browser.newContext({ viewport: { width, height: 800 }, colorScheme: "dark" });
    await ctx.addInitScript((t) => { try { localStorage.setItem("cardgen_auth_token", t); localStorage.setItem("theme", "dark"); } catch (_) {} }, token);
    const p = await open(ctx);
    await p.click("#pg-tab-library");
    await p.click("#pg-library-view-recent");
    await p.waitForFunction(() => document.querySelectorAll("#playground-library-grid > div").length > 0, null, { timeout: 10000 });
    const sw = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(`Recent view: no sideways scroll at ${width}px dark`, sw <= 0, sw);
    if (width === 320) await p.screenshot({ path: path.join(os.tmpdir(), "playground-recent-320-dark.png") });
    await ctx.close();
  }

  check("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
  await browser.close();
  await stack.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
