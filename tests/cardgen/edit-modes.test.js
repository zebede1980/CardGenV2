// Image Playground ✨ Edit with its two modes: ✏️ Change it (an edit model
// keeps the picture) and 🔄 New shot (the old Reimagine tab). Real proxy +
// real page in headless WebKit against the fake model. See README.md.
const os = require("os");
const path = require("path");
const { webkit } = require(process.env.PLAYWRIGHT_CORE || "playwright-core");
const { start, sleep, REPLIES } = require("./stack");

const repo = path.resolve(__dirname, "..", "..");
let failed = 0, passed = 0;
const check = (name, ok, detail = "") => {
  if (ok) { passed++; console.log("ok   " + name); }
  else { failed++; console.log("FAIL " + name + (detail ? "\n     " + String(detail).slice(0, 400) : "")); }
};

(async () => {
  const stack = await start({ repo, stageDir: path.join(os.tmpdir(), "cardgen-test-stage-edit-modes") });
  const { api, token, model } = stack;
  const caps = { "fake-a": { generate: true, edit: true }, "fake-b": { generate: true, edit: false } };
  await api("POST", "/api/config", {
    ...stack.config,
    api: {
      ...stack.config.api,
      image: stack.imageSettings({ models: ["fake-a", "fake-b"], model: "fake-a", editModel: "fake-a", reimagineModel: "fake-a", modelCapabilities: caps }),
    },
    app: { ...stack.config.app, enableImageGeneration: true },
  }, token);

  const browser = await webkit.launch();
  const pageErrors = [];
  const open = async (context) => {
    const page = await context.newPage();
    page.on("pageerror", (e) => pageErrors.push(e.message));
    if (process.env.SHOW_CONSOLE) page.on("console", (m) => { if (/error|fail/i.test(m.text())) console.log("  [console]", m.text().slice(0, 300)); });
    await page.goto(stack.url + "/", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!window.app && window.app.storageReady === true, null, { timeout: 20000 });
    await page.evaluate(() => document.getElementById("tab-playground")?.click());
    await page.waitForSelector("#view-playground", { state: "visible" });
    return page;
  };
  const setPicture = (page) => page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 600; c.height = 800;
    const x = c.getContext("2d");
    x.fillStyle = "#7b9fd6"; x.fillRect(0, 0, 600, 800);
    x.fillStyle = "#2d2240"; x.beginPath(); x.arc(300, 360, 150, 0, Math.PI * 2); x.fill();
    const url = c.toDataURL("image/png");
    window.app.playgroundImageUrl = url;
    window.app.updatePlaygroundImagePreview(url);
    return url;
  });
  const visible = (page, sel) => page.locator(sel).isVisible();
  const value = (page) => page.inputValue("#playground-edit-instruction");
  const idle = (page, id) => page.waitForFunction((i) => !document.getElementById(i).disabled, id, { timeout: 20000 });

  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await context.addInitScript((t) => { try { localStorage.setItem("cardgen_auth_token", t); } catch (_) {} }, token);
  let page = await open(context);

  const tabs = await page.evaluate(() => [...document.querySelectorAll("#playground-tool-tabs button")].map((b) => b.id.replace("pg-tab-", "")).join(","));
  check("there's no Reimagine tab any more", tabs === "generate,crop,edit,extend,enhance,combine,library", tabs);

  // A uniform picture reads as a safety-filter blank on the edit path, so the
  // fake model returns one with something in it.
  model.imageDataUrl = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 64; c.height = 64;
    const x = c.getContext("2d");
    const g = x.createLinearGradient(0, 0, 64, 64);
    g.addColorStop(0, "#102040"); g.addColorStop(1, "#f0c080");
    x.fillStyle = g; x.fillRect(0, 0, 64, 64);
    return c.toDataURL("image/png");
  });
  const source = await setPicture(page);
  await page.click("#pg-tab-edit");
  check("Edit opens in ✏️ Change it", await page.getAttribute("#pg-edit-mode-change", "aria-pressed") === "true"
    && /Keeps your picture/.test(await page.textContent("#pg-edit-mode-note")));
  check("Change it shows the presets, the edit model and Edit Image", await visible(page, "#playground-edit-preset")
    && await visible(page, "#playground-edit-model") && await visible(page, "#edit-playground-image-btn"));
  check("…and none of New shot's controls", !(await visible(page, "#playground-reimagine-model"))
    && !(await visible(page, "#playground-reimagine-likeness-wrap")) && !(await visible(page, "#playground-reimagine-prompt"))
    && !(await visible(page, "#reimagine-playground-image-btn")) && !(await visible(page, "#playground-reimagine-source")));

  await page.click('.pg-angle-row[data-angle-mode="auto"] .pg-angle-btn:has-text("From behind")');
  check("an angle in Change it is an edit instruction", (await value(page)) === "Show the same person from this camera position: back view, eye-level shot. Keep everything else the same.", await value(page));

  await page.click("#pg-edit-mode-newshot");
  check("🔄 New shot: the angle is reworded for a new shot", (await value(page)) === "seen from behind", await value(page));
  check("…the box is relabelled", (await page.textContent("#playground-edit-instruction-label")).trim() === "What should the new picture show?");
  check("…the presets and Edit Image go", !(await visible(page, "#playground-edit-preset")) && !(await visible(page, "#edit-playground-image-btn")));
  check("…New shot's controls and the pinned source show", await visible(page, "#playground-reimagine-model")
    && await visible(page, "#playground-reimagine-prompt") && await visible(page, "#reimagine-playground-image-btn")
    && await visible(page, "#playground-reimagine-source"));
  await page.click('.pg-angle-row[data-angle-mode="auto"] .pg-angle-btn:has-text("Close-up")');
  check("an angle in New shot is a phrase", (await value(page)) === "a close-up of the face", await value(page));

  // Each mode keeps its own model.
  await page.selectOption("#playground-reimagine-model", "fake-b");
  await page.click("#pg-edit-mode-change");
  check("a typed instruction stays put across modes", (await value(page)) === "Show the same person from this camera position: front view, eye-level shot close-up. Keep everything else the same.", await value(page));
  check("Change it keeps its own model", (await page.inputValue("#playground-edit-model")) === "fake-a");
  await page.click("#pg-edit-mode-newshot");
  check("New shot keeps its own model", (await page.inputValue("#playground-reimagine-model")) === "fake-b");
  await page.selectOption("#playground-reimagine-model", "fake-a");

  // A New shot run: the prompt is written, then one picture drawn with the source.
  await page.fill("#playground-edit-instruction", "from the front, facing us");
  const promptsBefore = model.count("image-prompt");
  const imagesBefore = model.count("image");
  await page.click("#reimagine-playground-image-btn");
  await idle(page, "reimagine-playground-image-btn");
  const promptCall = model.calls.filter((c) => c.kind === "image-prompt").pop();
  check("New shot writes the prompt from the box's text, once", model.count("image-prompt") === promptsBefore + 1
    && JSON.stringify(promptCall.body.messages).includes("from the front, facing us"));
  check("…shows the written prompt", (await page.inputValue("#playground-reimagine-prompt")) === REPLIES["image-prompt"]);
  const drawn = model.calls.filter((c) => c.kind === "image").pop();
  check("…and draws one picture with the source and that prompt", model.count("image") === imagesBefore + 1
    && drawn.body.model === "fake-a" && drawn.body.image === source && drawn.body.prompt === REPLIES["image-prompt"], JSON.stringify(drawn?.body).slice(0, 300));
  const after = await page.evaluate(() => ({ url: window.app.playgroundImageUrl.slice(0, 60), labels: (window.app.playgroundHistory || []).map((e) => e.label) }));
  check("…which becomes the working image, labelled Reimagined", after.url !== source.slice(0, 60)
    && after.labels.some((l) => /^Reimagined/.test(l)), JSON.stringify(after));

  // A Change it run sends the instruction as typed.
  await page.click("#pg-edit-mode-change");
  await page.fill("#playground-edit-instruction", "make it night time");
  await page.click("#edit-playground-image-btn");
  await idle(page, "edit-playground-image-btn");
  const edited = model.calls.filter((c) => c.kind === "image").pop();
  check("Change it sends the picture and the instruction as typed", edited.body.prompt === "make it night time" && edited.body.model === "fake-a" && !!edited.body.image);
  check("…with no prompt-writing call", model.count("image-prompt") === promptsBefore + 1);

  // The mode is remembered.
  await page.click("#pg-edit-mode-newshot");
  await sleep(600);
  await page.close();
  page = await open(context);
  await page.click("#pg-tab-edit");
  check("the mode is remembered on reload", await page.getAttribute("#pg-edit-mode-newshot", "aria-pressed") === "true"
    && await visible(page, "#reimagine-playground-image-btn"));

  // Anything that used to open the Reimagine tab opens New shot.
  await page.click("#pg-edit-mode-change");
  await page.evaluate(() => window.app._setPlaygroundToolTab("reimagine"));
  check("opening 'reimagine' lands on Edit in New shot", await visible(page, "#pg-panel-edit")
    && await page.getAttribute("#pg-edit-mode-newshot", "aria-pressed") === "true");

  const sw = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check("no sideways scroll at 390px", sw <= 0, sw);
  await setPicture(page);
  await page.locator("#pg-panel-edit").screenshot({ path: path.join(os.tmpdir(), "edit-newshot-390.png") });
  await page.click("#pg-edit-mode-change");
  await page.locator("#pg-panel-edit").screenshot({ path: path.join(os.tmpdir(), "edit-change-390.png") });
  await context.close();

  const dark = await browser.newContext({ viewport: { width: 320, height: 640 }, colorScheme: "dark" });
  await dark.addInitScript((t) => { try { localStorage.setItem("cardgen_auth_token", t); localStorage.setItem("theme", "dark"); } catch (_) {} }, token);
  page = await open(dark);
  await setPicture(page);
  await page.click("#pg-tab-edit");
  await page.click("#pg-edit-mode-newshot");
  const on = await page.evaluate(() => getComputedStyle(document.getElementById("pg-edit-mode-newshot")).backgroundColor);
  const off = await page.evaluate(() => getComputedStyle(document.getElementById("pg-edit-mode-change")).backgroundColor);
  check("320 dark: the chosen mode stands out", on !== off, `${on} vs ${off}`);
  const sw2 = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check("320 dark: no sideways scroll", sw2 <= 0, sw2);
  await page.locator("#pg-panel-edit").screenshot({ path: path.join(os.tmpdir(), "edit-newshot-320-dark.png") });
  await dark.close();

  check("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
  await browser.close();
  await stack.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
