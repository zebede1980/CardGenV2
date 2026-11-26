// Image Playground ⤢ Extend (outpainting on the local GPU: the picture on a
// green canvas, filled in by Qwen-Image 2.1 Lightning as an edit).
// The real proxy against a fake ComfyUI that records each workflow it is sent,
// then the real page in headless WebKit. See README.md.
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
// The picture's place on the green canvas.
const placeOf = (graph) => nodes(graph, "ImageCompositeMasked").find((n) => graph[n.inputs.destination[0]].class_type === "EmptyImage");
const pads = (graph) => {
  const s = node(graph, "ImageScale").inputs;
  const c = node(graph, "EmptyImage").inputs;
  const place = placeOf(graph).inputs;
  return { left: place.x, top: place.y, right: c.width - s.width - place.x, bottom: c.height - s.height - place.y, w: s.width, h: s.height, cw: c.width, ch: c.height };
};
const BASE = "Replace the green area with more of the same scene, continuing the picture naturally so it becomes one seamless picture.";
const promptOf = (graph) => node(graph, "TextEncodeQwenImage21").inputs.prompt;

(async () => {
  const comfy = await startComfy();
  const stack = await start({
    repo,
    stageDir: path.join(os.tmpdir(), "cardgen-test-stage-extend"),
    env: { COMFYUI_URL: `http://127.0.0.1:${comfy.port}`, COMFYUI_API_KEY: "comfy-key" },
  });
  const { api, token, model } = stack;
  await api("POST", "/api/config", {
    ...stack.config,
    api: { ...stack.config.api, image: stack.imageSettings({ models: ["fake-a"], model: "fake-a", editModel: "fake-a" }) },
    app: { ...stack.config.app, enableImageGeneration: true },
  }, token);
  const recent = async () => (await api("GET", "/api/storage/playground-recent", undefined, token)).json;
  const SRC = `data:image/png;base64,${PNG_B64}`;
  const extend = (ext, extra = {}) => api("POST", "/api/image/generations",
    { model: "local/qwen-image-2.1-lightning", prompt: "", image: SRC, extend: ext, n: 1, resumable: true, ...extra }, token);
  const lastGraph = () => comfy.state.prompts[comfy.state.prompts.length - 1].graph;
  const mult32 = (p) => [p.left, p.right, p.top, p.bottom, p.w, p.h, p.cw, p.ch].every((n) => n % 32 === 0);
  const MP = 1024 * 1024;

  // ── A. The proxy ──────────────────────────────────────────────────────────
  let r = await extend({ sourceWidth: 600, sourceHeight: 900, ratio: 16 / 9, x: 0.5, y: 0.5, room: 1 });
  check("an extend succeeds", r.status === 200 && /^data:image\/png/.test(r.json?.data?.[0]?.url || ""), r.text);
  let g = lastGraph();
  let p = pads(g);
  check("it runs on Qwen-Image 2.1 with the Lightning LoRA, one sampler",
    node(g, "UNETLoader").inputs.unet_name === "qwen_image_2.1_int8_convrot.safetensors"
    && /lightning/i.test(node(g, "LoraLoaderModelOnly")?.inputs.lora_name || "") && nodes(g, "SamplerCustomAdvanced").length === 1,
    JSON.stringify(g).slice(0, 400));
  const canvas = node(g, "EmptyImage").inputs;
  check("the canvas is solid green, the uploaded picture scaled onto it", canvas.color === 0x00ff00
    && g[node(g, "ImageScale").inputs.image[0]].class_type === "LoadImage" && node(g, "LoadImage").inputs.image === "cardgen/up1.png",
    JSON.stringify(canvas));
  const encode = node(g, "TextEncodeQwenImage21").inputs;
  check("the green canvas is what the edit model sees, at its own size",
    g[encode["images.image_1"][0]] === placeOf(g) && encode.resolution === 0 && !nodes(g, "ResizeImageMaskNode").length
    && g[node(g, "GetImageSize").inputs.image[0]] === placeOf(g));
  check("16:9 from a portrait: room left and right only, centred", p.top === 0 && p.bottom === 0 && p.left > 0 && Math.abs(p.left - p.right) <= 32, JSON.stringify(p));
  check("the canvas is 16:9 (within the 32 px rounding)", Math.abs(p.cw / p.ch - 16 / 9) < 0.04, `${p.cw}x${p.ch}`);
  check("the canvas is 1–1.5 MP", p.cw * p.ch >= 0.95 * MP && p.cw * p.ch <= 1.55 * MP, p.cw * p.ch / MP);
  check("every size and pad is a multiple of 32", mult32(p), JSON.stringify(p));
  check("the picture keeps its shape", Math.abs(p.w / p.h - 600 / 900) < 0.04, `${p.w}x${p.h}`);
  check("nothing typed → the fill-the-green instruction alone", promptOf(g) === BASE, promptOf(g));
  // The original is pasted back over the result, fading in only along sides that meet new room.
  const pasteNode = nodes(g, "ImageCompositeMasked").find((n) => n.inputs.mask);
  const paste = pasteNode.inputs;
  const fade = node(g, "FeatherMask").inputs;
  const solid = node(g, "SolidMask").inputs;
  check("the original is pasted back at its place, unchanged in size, and that's what is saved",
    g[paste.source[0]].class_type === "ImageScale" && g[paste.destination[0]].class_type === "VAEDecode"
    && paste.x === p.left && paste.y === p.top && paste.resize_source === false
    && solid.width === p.w && solid.height === p.h && g[g[56].inputs.images[0]] === pasteNode,
    JSON.stringify({ paste, solid }));
  check("…fading in over 32 px only on the sides that meet new room", fade.left === 32 && fade.right === 32 && fade.top === 0 && fade.bottom === 0, JSON.stringify(fade));

  await extend({ sourceWidth: 600, sourceHeight: 900, ratio: 16 / 9, x: 0, y: 0.5, room: 1 }, { prompt: "a beach at sunset" });
  p = pads(lastGraph());
  check("x = 0 puts the picture at the left edge", p.left === 0 && p.right > 0, JSON.stringify(p));
  check("what the user typed is added for the new area", promptOf(lastGraph()) === `${BASE} In the new area: a beach at sunset.`, promptOf(lastGraph()));

  await extend({ sourceWidth: 1600, sourceHeight: 900, ratio: 9 / 16, x: 0.5, y: 1, room: 1 });
  p = pads(lastGraph());
  check("9:16 from a landscape: room above only when y = 1", p.left === 0 && p.right === 0 && p.bottom === 0 && p.top > 0, JSON.stringify(p));

  await extend({ sourceWidth: 600, sourceHeight: 900, ratio: 2 / 3, x: 0.5, y: 0.5, room: 1.5 });
  g = lastGraph();
  p = pads(g);
  check("the same shape with extra room pads all four sides, in one pass", p.left > 0 && p.right > 0 && p.top > 0 && p.bottom > 0
    && nodes(g, "SamplerCustomAdvanced").length === 1, JSON.stringify(p));
  check("…fading in on all four", ["left", "right", "top", "bottom"].every((k) => node(g, "FeatherMask").inputs[k] === 32));
  check("…and the picture is about 2/3 of the canvas each way", Math.abs(p.w / p.cw - 2 / 3) < 0.04 && Math.abs(p.h / p.ch - 2 / 3) < 0.04, JSON.stringify(p));

  await extend({ sourceWidth: 300, sourceHeight: 300, ratio: 16 / 9, x: 0.5, y: 0.5, room: 1 });
  p = pads(lastGraph());
  check("a small picture is brought up to at least ~1 MP", p.cw * p.ch >= 0.95 * MP, p.cw * p.ch / MP);
  await extend({ sourceWidth: 4000, sourceHeight: 3000, ratio: 9 / 16, x: 0.5, y: 0.5, room: 2 });
  p = pads(lastGraph());
  check("a big one with lots of room comes down to ≤1.5 MP", p.cw * p.ch <= 1.55 * MP && mult32(p), p.cw * p.ch / MP);

  const sent = comfy.state.prompts.length;
  r = await extend({ sourceWidth: 600, sourceHeight: 900, ratio: 2 / 3, x: 0.5, y: 0.5, room: 1 });
  check("the picture's own shape with no room is refused", r.status === 400 && /already that shape/.test(r.text), r.text);
  for (const [what, ext] of [
    ["a shape past 4:1", { sourceWidth: 600, sourceHeight: 900, ratio: 10 }],
    ["a position outside 0–1", { sourceWidth: 600, sourceHeight: 900, ratio: 1, x: 2 }],
    ["too much room", { sourceWidth: 600, sourceHeight: 900, ratio: 1, room: 5 }],
    ["no picture size", { ratio: 1 }],
    ["a string for a number", { sourceWidth: "600", sourceHeight: 900, ratio: 1 }],
  ]) {
    r = await extend(ext);
    check(`${what} is refused`, r.status === 400, `${r.status} ${r.text}`);
  }
  r = await api("POST", "/api/image/generations", { model: "local/z-image-turbo", prompt: "", image: SRC, extend: { sourceWidth: 600, sourceHeight: 900, ratio: 1 } }, token);
  check("a model without Extend is refused", r.status === 400 && /can't extend/.test(r.text), r.text);
  r = await api("POST", "/api/image/generations", { model: "local/moss-image", prompt: "", image: SRC, extend: { sourceWidth: 600, sourceHeight: 900, ratio: 1 } }, token);
  check("MOSS no longer extends", r.status === 400 && /can't extend/.test(r.text), r.text);
  r = await api("POST", "/api/image/generations", { model: "local/qwen-image-2.1-lightning", prompt: "", extend: { sourceWidth: 600, sourceHeight: 900, ratio: 1 } }, token);
  check("Extend without a picture is refused", r.status === 400, r.text);
  check("nothing refused reached the GPU", comfy.state.prompts.length === sent, comfy.state.prompts.length - sent);

  const imagesBefore = model.count("image");
  r = await api("POST", "/api/image/generations", { model: "fake-a", prompt: "x", image: SRC, extend: { sourceWidth: 600, sourceHeight: 900, ratio: 1 } },
    token, { "X-API-Key": "fake-image-key", "X-API-URL": stack.modelUrl });
  check("Extend on a hosted model is refused before any paid call", r.status === 400 && model.count("image") === imagesBefore, r.text);

  comfy.state.failNext = "out of memory";
  r = await extend({ sourceWidth: 600, sourceHeight: 900, ratio: 1, x: 0.5, y: 0.5, room: 1 });
  check("a GPU failure is reported", r.status === 502 && /out of memory/.test(r.text), r.text);

  r = await extend({ sourceWidth: 600, sourceHeight: 900, ratio: 1, x: 0.5, y: 0.5, room: 1 }, { __keep: { tool: "extend", prompt: "Extended to 1:1" } });
  const kept = await until(async () => { const l = await recent(); return l?.items?.[0]?.tool === "extend" && l.items[0]; }, { what: "extend kept" });
  check("a kept extend is in Recent as an extend", kept.prompt === "Extended to 1:1" && kept.model === "local/qwen-image-2.1-lightning", JSON.stringify(kept));

  // ── B. The page ───────────────────────────────────────────────────────────
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
  // A 600×900 picture with something to see in it.
  const setPicture = (page, w = 600, h = 900) => page.evaluate(([w, h]) => {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const x = c.getContext("2d");
    const grad = x.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, "#5b7fd6"); grad.addColorStop(1, "#f2b46b");
    x.fillStyle = grad; x.fillRect(0, 0, w, h);
    x.fillStyle = "#2d2240"; x.beginPath(); x.arc(w / 2, h * 0.45, w * 0.25, 0, Math.PI * 2); x.fill();
    const url = c.toDataURL("image/png");
    window.app.playgroundImageUrl = url;
    window.app.updatePlaygroundImagePreview(url);
  }, [w, h]);
  const box = (page, sel) => page.locator(sel).boundingBox();
  const picturePlace = async (page) => {
    const f = await box(page, "#playground-extend-frame");
    const i = await box(page, "#playground-extend-picture");
    return { f, i, left: i.x - f.x, right: f.x + f.width - (i.x + i.width), top: i.y - f.y, bottom: f.y + f.height - (i.y + i.height) };
  };
  const activeSnap = (page) => page.evaluate(() => [...document.querySelectorAll("#playground-extend-snap button.active")].map((b) => b.textContent).join(""));
  const enabledSnaps = (page) => page.evaluate(() => [...document.querySelectorAll("#playground-extend-snap button")].filter((b) => !b.disabled).map((b) => b.textContent).join(""));

  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
  await context.addInitScript((t) => { try { localStorage.setItem("cardgen_auth_token", t); } catch (_) {} }, token);
  let page = await open(context);

  const tabOrder = await page.evaluate(() => [...document.querySelectorAll("#playground-tool-tabs button")].map((b) => b.id.replace("pg-tab-", "")).join(","));
  check("⤢ Extend sits after Edit in the tool tabs", /edit,extend,enhance/.test(tabOrder), tabOrder);
  await page.click("#pg-tab-extend");
  check("the Extend panel opens", await page.locator("#pg-panel-extend").isVisible());
  check("with no picture: no frame, a hint, the button off",
    !(await page.locator("#playground-extend-frame").isVisible())
    && /Upload, paste or generate/.test(await page.textContent("#playground-extend-note"))
    && await page.locator("#extend-playground-image-btn").isDisabled());

  await setPicture(page);
  await page.waitForFunction(() => document.getElementById("playground-extend-frame").offsetWidth > 0, null, { timeout: 5000 });
  let place = await picturePlace(page);
  check("the frame is 16:9 by default", Math.abs(place.f.width / place.f.height - 16 / 9) < 0.03, `${place.f.width}x${place.f.height}`);
  check("the picture sits in the middle, full height", Math.abs(place.left - place.right) < 2 && place.top < 1 && place.bottom < 1, JSON.stringify(place));
  check("the frame fits the screen", place.f.width <= 390 && place.f.height <= 844 * 0.46, JSON.stringify(place.f));
  check("the middle button is lit; up/down rows are off", (await activeSnap(page)) === "•" && (await enabledSnaps(page)) === "←•→", `${await activeSnap(page)} / ${await enabledSnaps(page)}`);
  check("the Extend button is on", !(await page.locator("#extend-playground-image-btn").isDisabled()));

  await page.click('#playground-extend-snap button[aria-label="Picture at the left"]');
  place = await picturePlace(page);
  check("← puts the picture at the left edge", place.left < 1 && place.right > 50, JSON.stringify(place));
  check("…and lights ←", (await activeSnap(page)) === "←");

  // Drag it with a finger (pointer events from touch) to the right edge.
  const pic = (await picturePlace(page)).i;
  await page.mouse.move(pic.x + pic.width / 2, pic.y + pic.height / 2);
  await page.mouse.down();
  await page.mouse.move(pic.x + pic.width / 2 + 400, pic.y + pic.height / 2, { steps: 8 });
  await page.mouse.up();
  place = await picturePlace(page);
  check("dragging the picture moves it, stopping at the edge", place.right < 1 && place.left > 50, JSON.stringify(place));
  check("…and lights →", (await activeSnap(page)) === "→");

  // Tap in the empty area: the picture's middle goes under the finger.
  const f = place.f;
  await page.mouse.click(f.x + 40, f.y + f.height / 2);
  place = await picturePlace(page);
  check("tapping the empty area moves the picture there", place.left < 1, JSON.stringify(place));

  await page.selectOption("#playground-extend-ratio", "2:3");
  check("the picture's own shape with no room: button off, says why",
    await page.locator("#extend-playground-image-btn").isDisabled()
    && /already this shape/.test(await page.textContent("#playground-extend-note")));
  await page.selectOption("#playground-extend-room", "1.5");
  place = await picturePlace(page);
  check("extra room: all nine buttons on, the picture smaller in the frame", (await enabledSnaps(page)).length === 9
    && place.i.width < place.f.width * 0.7 && !(await page.locator("#extend-playground-image-btn").isDisabled()), JSON.stringify(place));
  await page.click('#playground-extend-snap button[aria-label="Picture at the bottom right"]');
  place = await picturePlace(page);
  check("↘ puts it in the bottom right corner", place.right < 1 && place.bottom < 1 && place.left > 20 && place.top > 20, JSON.stringify(place));
  check("the shape and room are remembered", await page.evaluate(() => window.app.config.get("api.image.extendRatio") === "2:3" && window.app.config.get("api.image.extendRoom") === "1.5"));

  // The description is written for every extend now, so no button and no nag.
  await page.selectOption("#playground-extend-room", "2");
  check("no ✍️ Describe it button and no warning for a big extension",
    !(await page.locator("#playground-extend-describe-btn").count()) && !/Most of this will be new/.test(await page.textContent("#playground-extend-note")));
  await page.selectOption("#playground-extend-room", "1.5");

  const sw = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check("no sideways scroll at 390px", sw <= 0, sw);
  await page.locator("#pg-panel-extend").screenshot({ path: path.join(os.tmpdir(), "extend-390.png") });

  // Extend from the page.
  const promptsBefore = comfy.state.prompts.length;
  const describesBefore = model.calls.length;
  const hold = comfy.state.holdNext();
  await page.fill("#playground-extend-prompt", "a lighthouse on the cliff behind");
  await page.click("#extend-playground-image-btn");
  await until(() => hold.reached, { what: "extend held on the GPU" });
  check("while drawing: the button is off and the status shows", await page.locator("#extend-playground-image-btn").isDisabled()
    && /Drawing the new edges/.test(await page.textContent("#playground-extend-status")));
  hold.release();
  await page.waitForFunction(() => !document.getElementById("extend-playground-image-btn").disabled, null, { timeout: 20000 });
  g = lastGraph();
  p = pads(g);
  check("the page sends one extend with its settings and what was typed", comfy.state.prompts.length === promptsBefore + 1
    && p.left > 0 && p.top > 0 && p.right === 0 && p.bottom === 0
    && promptOf(g) === `${BASE} In the new area: a lighthouse on the cliff behind.`, JSON.stringify([p, promptOf(g)]));
  check("…and no text-model call", model.calls.length === describesBefore, model.calls.slice(describesBefore).map((c) => c.kind).join());
  check("the result becomes the working image", await page.evaluate((b64) => window.app.playgroundImageUrl === "data:image/png;base64," + b64, PNG_B64));
  check("…with a history entry", await page.evaluate(() => (window.app.playgroundHistory || []).some((e) => e.label === "Extended to 2:3")));
  const keptFromPage = await until(async () => { const l = await recent(); return l.items[0]?.prompt === "a lighthouse on the cliff behind" && l.items[0]; }, { what: "page extend kept" });
  check("…and it is kept in Recent", keptFromPage.tool === "extend");

  // A failure frees the button and says so.
  await setPicture(page);
  const beforeFail = await page.evaluate(() => window.app.playgroundImageUrl);
  comfy.state.failNext = "boom";
  await page.click("#extend-playground-image-btn");
  await page.waitForFunction(() => !document.getElementById("extend-playground-image-btn").disabled, null, { timeout: 20000 });
  check("a failed extend leaves the picture as it was", await page.evaluate((u) => window.app.playgroundImageUrl === u, beforeFail));

  // The iPhone case: the tab goes away mid-draw; the picture is still kept.
  await page.fill("#playground-extend-prompt", "drawn while the tab was gone");
  const hold2 = comfy.state.holdNext();
  const beforeGone = comfy.state.prompts.length;
  await page.click("#extend-playground-image-btn");
  await until(() => hold2.reached, { what: "second extend held" });
  await page.close();
  hold2.release();
  await until(async () => (await recent()).items[0]?.prompt === "drawn while the tab was gone", { what: "kept after the tab closed" });
  check("an extend finished after the tab closed is in Recent, drawn once", comfy.state.prompts.length === beforeGone + 1);
  await context.close();

  // Small phone, dark.
  const dark = await browser.newContext({ viewport: { width: 320, height: 640 }, colorScheme: "dark", hasTouch: true });
  await dark.addInitScript((t) => { try { localStorage.setItem("cardgen_auth_token", t); localStorage.setItem("theme", "dark"); } catch (_) {} }, token);
  page = await open(dark);
  await page.click("#pg-tab-extend");
  await setPicture(page, 1200, 800);
  await page.selectOption("#playground-extend-ratio", "9:16");
  await page.selectOption("#playground-extend-room", "1");
  place = await picturePlace(page);
  check("320 dark: a tall frame stays within half the screen", place.f.height <= 640 * 0.46 + 1 && place.f.width <= 320, JSON.stringify(place.f));
  check("320 dark: full width picture, up/down only", place.left < 1 && place.right < 1 && (await enabledSnaps(page)) === "↑•↓", await enabledSnaps(page));
  const litColour = await page.evaluate(() => getComputedStyle(document.querySelector("#playground-extend-snap button.active")).backgroundColor);
  const offColour = await page.evaluate(() => getComputedStyle(document.querySelector("#playground-extend-snap button:not(.active)")).backgroundColor);
  check("320 dark: the lit button looks different from the rest", litColour !== offColour, `${litColour} vs ${offColour}`);
  const sw2 = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check("320 dark: no sideways scroll", sw2 <= 0, sw2);
  await page.locator("#pg-panel-extend").screenshot({ path: path.join(os.tmpdir(), "extend-320-dark.png") });
  await dark.close();

  check("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
  await browser.close();
  await stack.stop();
  comfy.server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
