// Image Playground ✨ Edit → 🖌️ Paint an area: an edit on a local model where
// only the painted part changes. The real proxy against a fake ComfyUI (the
// paste-back graph, refusals), then the real page in headless WebKit (painting
// with a pointer, undo, erase, clear, the mask sent, the local-model rule, the
// tab closed mid-edit). See README.md.
const os = require("os");
const path = require("path");
const { webkit } = require(process.env.PLAYWRIGHT_CORE || "playwright-core");
const { start, sleep } = require("./stack");
const { startComfy, PNG_B64 } = require("./fake-comfy");

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
const node = (graph, type) => Object.values(graph).find((n) => n.class_type === type);
const nodes = (graph, type) => Object.values(graph).filter((n) => n.class_type === type);

(async () => {
  const comfy = await startComfy();
  const stack = await start({
    repo,
    stageDir: path.join(os.tmpdir(), "cardgen-test-stage-paint"),
    env: { COMFYUI_URL: `http://127.0.0.1:${comfy.port}`, COMFYUI_API_KEY: comfy.apiKey },
  });
  const { api, token, model } = stack;
  const LOCAL = "local/qwen-image-2.1-lightning";
  const caps = { "fake-a": { generate: true, edit: true }, [LOCAL]: { generate: true, edit: true } };
  await api("POST", "/api/config", {
    ...stack.config,
    api: { ...stack.config.api, image: stack.imageSettings({ models: ["fake-a", LOCAL], model: "fake-a", editModel: LOCAL, modelCapabilities: caps }) },
    app: { ...stack.config.app, enableImageGeneration: true },
  }, token);
  const recent = async () => (await api("GET", "/api/storage/playground-recent", undefined, token)).json;
  const SRC = `data:image/png;base64,${PNG_B64}`;
  const lastGraph = () => comfy.state.prompts[comfy.state.prompts.length - 1].graph;
  const paint = (extra) => api("POST", "/api/image/generations",
    { model: LOCAL, prompt: "make the shirt yellow", image: SRC, inpaint: { mask: SRC }, n: 1, resumable: true, ...extra }, token);

  // ── A. The proxy ──────────────────────────────────────────────────────────
  let r = await paint();
  check("a painted edit succeeds", r.status === 200, r.text);
  let g = lastGraph();
  const save = g[56];
  const paste = g[save.inputs.images[0]];
  check("the saved picture is the original with the edit pasted in", paste?.class_type === "ImageCompositeMasked"
    && g[paste.inputs.destination[0]].class_type === "LoadImage" && g[paste.inputs.source[0]].class_type === "ImageScale", JSON.stringify(paste));
  const editLoad = Object.values(g).find((n) => n.class_type === "LoadImage" && n !== g[paste.inputs.destination[0]]);
  check("the original pasted onto is the same upload the edit used", editLoad && g[paste.inputs.destination[0]].inputs.image === editLoad.inputs.image, JSON.stringify(editLoad));
  check("the edit itself is the model's own edit graph", !!node(g, "TextEncodeQwenImage21") && g[g[paste.inputs.source[0]].inputs.image[0]].class_type === "VAEDecode");
  const maskLoad = node(g, "LoadImageMask");
  check("the mask is uploaded and loaded", comfy.state.uploads.length === 2 && maskLoad?.inputs.image === "cardgen/up2.png" && maskLoad.inputs.channel === "red", JSON.stringify(maskLoad));
  const sizes = nodes(g, "ImageScale").filter((n) => Array.isArray(n.inputs.width));
  check("mask and edit are both scaled to the original's own size", sizes.length === 2
    && sizes.every((n) => g[n.inputs.width[0]].class_type === "GetImageSize" && g[g[n.inputs.width[0]].inputs.image[0]] === g[paste.inputs.destination[0]]));
  check("the mask is grown and softened before pasting", !!node(g, "GrowMask") && !!node(g, "ImageBlur") && g[paste.inputs.mask[0]].class_type === "ImageToMask");
  check("the instruction goes to the model as typed", node(g, "TextEncodeQwenImage21").inputs.prompt.includes("make the shirt yellow"));

  r = await api("POST", "/api/image/generations", { model: "local/fibo-2", prompt: "x", image: SRC, inpaint: { mask: SRC } }, token);
  g = lastGraph();
  check("any local edit model can paint an area (FIBO)", r.status === 200 && !!node(g, "TextEncodeFibo2") && g[g[56].inputs.images[0]].class_type === "ImageCompositeMasked", r.text);

  const sent = comfy.state.prompts.length;
  const imagesBefore = model.count("image");
  r = await api("POST", "/api/image/generations", { model: "fake-a", prompt: "x", image: SRC, inpaint: { mask: SRC } }, token,
    { "X-API-Key": "fake-image-key", "X-API-URL": stack.modelUrl });
  check("a hosted model is refused before any paid call", r.status === 400 && model.count("image") === imagesBefore, r.text);
  r = await api("POST", "/api/image/generations", { model: "local/z-image-turbo", prompt: "x", image: SRC, inpaint: { mask: SRC } }, token);
  check("a model that can't edit is refused", r.status === 400 && /can't edit/.test(r.text), r.text);
  r = await paint({ inpaint: { mask: "not a picture" } });
  check("a bad mask is refused", r.status === 400, r.text);
  r = await paint({ inpaint: {} });
  check("a missing mask is refused", r.status === 400, r.text);
  r = await paint({ prompt: "" });
  check("an empty instruction is refused", r.status === 400, r.text);
  r = await paint({ extend: { sourceWidth: 10, sourceHeight: 10, ratio: 1 } });
  check("painting and extending together are refused", r.status === 400, r.text);
  check("nothing refused reached the GPU", comfy.state.prompts.length === sent, comfy.state.prompts.length - sent);

  // ── B. The page ───────────────────────────────────────────────────────────
  const browser = await webkit.launch();
  const pageErrors = [];
  const sentBodies = [];
  const open = async (context) => {
    const page = await context.newPage();
    page.on("pageerror", (e) => pageErrors.push(e.message));
    page.on("request", (req) => {
      if (req.method() === "POST" && req.url().endsWith("/api/image/generations")) {
        try { sentBodies.push(req.postDataJSON()); } catch (_) { /* not JSON */ }
      }
    });
    await page.goto(stack.url + "/", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!window.app && window.app.storageReady === true, null, { timeout: 20000 });
    await page.evaluate(() => document.getElementById("tab-playground")?.click());
    await page.waitForSelector("#view-playground", { state: "visible" });
    return page;
  };
  // A picture with something in it (a uniform one reads as a safety-filter blank).
  const picture = (page, w, h, hue) => page.evaluate(([w, h, hue]) => {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const x = c.getContext("2d");
    const g = x.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, `hsl(${hue},60%,35%)`); g.addColorStop(1, `hsl(${hue + 40},70%,70%)`);
    x.fillStyle = g; x.fillRect(0, 0, w, h);
    x.fillStyle = "#222"; x.beginPath(); x.arc(w / 2, h / 2, w / 5, 0, Math.PI * 2); x.fill();
    return c.toDataURL("image/png");
  }, [w, h, hue]);
  const setPicture = (page, url) => page.evaluate((u) => { window.app.playgroundImageUrl = u; window.app.updatePlaygroundImagePreview(u); }, url);
  const btnText = (page) => page.textContent("#edit-playground-image-btn").then((t) => t.trim());
  const stroke = async (page, from, to) => {
    const b = await page.locator("#playground-paint-canvas").boundingBox();
    await page.mouse.move(b.x + b.width * from[0], b.y + b.height * from[1]);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width * to[0], b.y + b.height * to[1], { steps: 6 });
    await page.mouse.up();
  };
  const maskPixel = (page, dataUrl, fx, fy) => page.evaluate(([u, fx, fy]) => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.width; c.height = img.height;
      const x = c.getContext("2d");
      x.drawImage(img, 0, 0);
      const d = x.getImageData(Math.floor(img.width * fx), Math.floor(img.height * fy), 1, 1).data;
      resolve({ v: d[0], w: img.width, h: img.height });
    };
    img.src = u;
  }), [dataUrl, fx, fy]);
  const idle = (page) => page.waitForFunction(() => !document.getElementById("edit-playground-image-btn").dataset.busy, null, { timeout: 20000 });

  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
  await context.addInitScript((t) => { try { localStorage.setItem("cardgen_auth_token", t); } catch (_) {} }, token);
  let page = await open(context);
  const src = await picture(page, 600, 800, 200);
  await setPicture(page, src);
  await page.click("#pg-tab-edit");
  await page.click("#pg-edit-mode-change");
  check("✏️ Change it offers 🖌️ Paint an area", await page.locator("#playground-paint-toggle").isVisible()
    && !(await page.locator("#playground-paint-stage").isVisible()));
  await page.click("#pg-edit-mode-newshot");
  check("🔄 New shot doesn't", !(await page.locator("#playground-paint-toggle").isVisible()));
  await page.click("#pg-edit-mode-change");

  await page.click("#playground-paint-toggle");
  await page.waitForFunction(() => document.getElementById("playground-paint-stage").offsetWidth > 0, null, { timeout: 5000 });
  const st = await page.locator("#playground-paint-stage").boundingBox();
  check("the paint area shows the picture at its shape, within the screen", Math.abs(st.width / st.height - 600 / 800) < 0.02 && st.width <= 390 && st.height <= 844 * 0.56, JSON.stringify(st));
  check("the toggle now reads ✕ Stop painting", (await page.textContent("#playground-paint-toggle")).trim() === "✕ Stop painting");
  check("nothing painted yet: the button is the plain Edit Image, Undo and Clear are off", (await btnText(page)) === "✨ Edit Image"
    && await page.locator("#playground-paint-undo").isDisabled() && await page.locator("#playground-paint-clear").isDisabled());
  check("the medium brush starts lit", await page.evaluate(() => document.querySelector('#playground-paint-tools [data-size="m"]').classList.contains("active")));

  await stroke(page, [0.3, 0.3], [0.7, 0.3]);
  check("painting a stroke turns the button into ✨ Edit the painted area", (await btnText(page)) === "✨ Edit the painted area", await btnText(page));
  await page.click("#playground-paint-undo");
  check("↶ Undo takes it back", (await btnText(page)) === "✨ Edit Image");
  await stroke(page, [0.3, 0.3], [0.7, 0.3]);
  await page.click("#playground-paint-erase");
  check("🧽 Erase lights up", await page.evaluate(() => document.getElementById("playground-paint-erase").classList.contains("active")));
  await page.click('#playground-paint-tools [data-size="l"]');
  await stroke(page, [0.2, 0.3], [0.8, 0.3]);
  check("erasing over the whole stroke leaves nothing painted", (await btnText(page)) === "✨ Edit Image");
  await page.click("#playground-paint-erase");
  await page.click('#playground-paint-tools [data-size="m"]');
  await stroke(page, [0.25, 0.25], [0.45, 0.25]);
  await page.click("#playground-paint-clear");
  check("✕ Clear empties it", (await btnText(page)) === "✨ Edit Image");
  await stroke(page, [0.25, 0.25], [0.45, 0.25]);

  // A hosted model can't paint an area.
  await page.selectOption("#playground-edit-model", "fake-a");
  check("with a hosted model: the button is off and the note says why", await page.locator("#edit-playground-image-btn").isDisabled()
    && /local edit models/.test(await page.textContent("#playground-paint-note")));
  await page.selectOption("#playground-edit-model", LOCAL);
  check("…back on a local model it's on", !(await page.locator("#edit-playground-image-btn").isDisabled()));

  // The edit, with the mask. The fake GPU returns a picture the size of the source.
  comfy.state.png = Buffer.from((await picture(page, 600, 800, 60)).split(",")[1], "base64");
  await page.fill("#playground-edit-instruction", "make the circle red");
  const promptsBefore = comfy.state.prompts.length;
  await page.click("#edit-playground-image-btn");
  await idle(page);
  const body = sentBodies.filter((b) => b.inpaint).pop();
  check("the page sends the edit with the painted mask", comfy.state.prompts.length === promptsBefore + 1 && body?.model === LOCAL
    && body.prompt === "make the circle red" && /^data:image\/png;base64,/.test(body.inpaint.mask), JSON.stringify(body || {}).slice(0, 200));
  const onStroke = await maskPixel(page, body.inpaint.mask, 0.35, 0.25);
  const offStroke = await maskPixel(page, body.inpaint.mask, 0.7, 0.8);
  check("the mask is white where painted and black elsewhere, at the picture's shape", onStroke.v === 255 && offStroke.v === 0
    && Math.abs(onStroke.w / onStroke.h - 600 / 800) < 0.01, JSON.stringify({ onStroke, offStroke }));
  check("the result becomes the working image, labelled as a painted edit", await page.evaluate(() =>
    (window.app.playgroundHistory || []).some((e) => / painted area\)$/.test(e.label))));
  check("a result of the same size keeps the painted area for another go", (await btnText(page)) === "✨ Edit the painted area");
  const kept = await until(async () => { const l = await recent(); return l.items[0]?.prompt === "make the circle red" && l.items[0]; }, { what: "painted edit kept" });
  check("…and it's kept in Recent as an edit", kept.tool === "edit");

  // Stop painting: a plain edit again.
  await page.click("#playground-paint-toggle");
  check("✕ Stop painting hides the paint area and the button is plain again", !(await page.locator("#playground-paint-stage").isVisible()) && (await btnText(page)) === "✨ Edit Image");
  await page.fill("#playground-edit-instruction", "a plain edit");
  await page.click("#edit-playground-image-btn");
  await idle(page);
  check("…and the edit goes without a mask", sentBodies[sentBodies.length - 1].prompt === "a plain edit" && !sentBodies[sentBodies.length - 1].inpaint);

  // A picture of another size clears the paint.
  await page.click("#playground-paint-toggle");
  await setPicture(page, await picture(page, 800, 500, 300));
  await page.waitForFunction(() => { const s = document.getElementById("playground-paint-stage"); return s.offsetWidth / s.offsetHeight > 1.5; }, null, { timeout: 5000 });
  check("a picture of another size starts with nothing painted", (await btnText(page)) === "✨ Edit Image");

  const sw = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check("no sideways scroll at 390px", sw <= 0, sw);
  await stroke(page, [0.2, 0.5], [0.6, 0.5]);
  const dbg = await page.evaluate(() => { const p = window.app._paint; const c = document.getElementById("playground-paint-canvas"); const r = c.getBoundingClientRect(); return { pw: p.width, ph: p.height, cw: c.width, ch: c.height, painted: p.painted, undo: p.undo.length, rect: [r.x, r.y, r.width, r.height], sameUrl: p.url === window.app.playgroundImageUrl, open: window.app._paintOpen }; });
  check("a stroke on the new picture paints", (await btnText(page)) === "✨ Edit the painted area", JSON.stringify(dbg));
  await page.locator("#pg-panel-edit").screenshot({ path: path.join(os.tmpdir(), "paint-390.png") });

  // The iPhone case: the tab goes away mid-edit; the result is still kept.
  await page.fill("#playground-edit-instruction", "edited while the tab was gone");
  const hold = comfy.state.holdNext();
  const beforeGone = comfy.state.prompts.length;
  await page.click("#edit-playground-image-btn");
  await until(() => hold.reached, { what: "painted edit held" });
  await page.close();
  hold.release();
  await until(async () => (await recent()).items[0]?.prompt === "edited while the tab was gone", { what: "kept after the tab closed" });
  check("a painted edit finished after the tab closed is in Recent, drawn once", comfy.state.prompts.length === beforeGone + 1);
  await context.close();

  // Small phone, dark, with a finger.
  const dark = await browser.newContext({ viewport: { width: 320, height: 640 }, colorScheme: "dark", hasTouch: true, isMobile: true });
  await dark.addInitScript((t) => { try { localStorage.setItem("cardgen_auth_token", t); localStorage.setItem("theme", "dark"); } catch (_) {} }, token);
  page = await open(dark);
  await setPicture(page, await picture(page, 600, 800, 120));
  await page.click("#pg-tab-edit");
  await page.click("#pg-edit-mode-change");
  await page.click("#playground-paint-toggle");
  await page.waitForFunction(() => document.getElementById("playground-paint-stage").offsetWidth > 0, null, { timeout: 5000 });
  await page.evaluate(() => {
    const c = document.getElementById("playground-paint-canvas");
    const r = c.getBoundingClientRect();
    const fire = (type, x, y) => c.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: "touch", isPrimary: true, bubbles: true, cancelable: true, clientX: r.left + r.width * x, clientY: r.top + r.height * y }));
    fire("pointerdown", 0.3, 0.6); fire("pointermove", 0.5, 0.6); fire("pointermove", 0.7, 0.6); fire("pointerup", 0.7, 0.6);
  });
  check("320 dark: a finger stroke paints", (await btnText(page)) === "✨ Edit the painted area", await btnText(page));
  const lit = await page.evaluate(() => getComputedStyle(document.querySelector('#playground-paint-tools [data-size="m"]')).backgroundColor);
  const unlit = await page.evaluate(() => getComputedStyle(document.querySelector('#playground-paint-tools [data-size="s"]')).backgroundColor);
  check("320 dark: the chosen brush stands out", lit !== unlit, `${lit} vs ${unlit}`);
  const sw2 = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check("320 dark: no sideways scroll", sw2 <= 0, sw2);
  await page.locator("#pg-panel-edit").screenshot({ path: path.join(os.tmpdir(), "paint-320-dark.png") });
  await dark.close();

  check("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
  await browser.close();
  await stack.stop();
  comfy.server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
