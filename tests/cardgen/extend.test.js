// Image Playground ⤢ Extend (outpainting on the local GPU with MOSS AnyPaint).
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
const preps = (graph) => Object.values(graph).filter((n) => n.class_type === "MOSSAnyPaintPrepare").map((n) => n.inputs);
// Padding summed over the passes (one, or two when there is room on both axes).
const pads = (graph) => {
  const sum = (k) => preps(graph).reduce((t, i) => t + i[k], 0);
  const s = node(graph, "ImageScale").inputs;
  const [left, right, top, bottom] = ["left", "right", "top", "bottom"].map(sum);
  return { left, right, top, bottom, w: s.width, h: s.height, cw: s.width + left + right, ch: s.height + top + bottom, passes: preps(graph).length };
};

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
    { model: "local/moss-image", prompt: "", image: SRC, extend: ext, n: 1, resumable: true, ...extra }, token);
  const lastGraph = () => comfy.state.prompts[comfy.state.prompts.length - 1].graph;
  const mult16 = (p) => [p.left, p.right, p.top, p.bottom, p.w, p.h].every((n) => n % 16 === 0);
  const MP = 1024 * 1024;

  // ── A. The proxy ──────────────────────────────────────────────────────────
  let r = await extend({ sourceWidth: 600, sourceHeight: 900, ratio: 16 / 9, x: 0.5, y: 0.5, room: 1 });
  check("an extend succeeds", r.status === 200 && /^data:image\/png/.test(r.json?.data?.[0]?.url || ""), r.text);
  let g = lastGraph();
  let p = pads(g);
  check("it runs AnyPaint on MOSS Base with both LoRAs, 8 steps",
    node(g, "UNETLoader").inputs.unet_name === "moss_image_base_int8_convrot.safetensors"
    && Object.values(g).filter((n) => n.class_type === "LoraLoaderModelOnly").map((n) => n.inputs.lora_name).join() === "moss_anypaint_rank32.safetensors,moss_base_dmd2_8step.safetensors"
    && !!node(g, "MOSSAnyPaintModelPatch") && node(g, "KSampler").inputs.steps === 8,
    JSON.stringify(g).slice(0, 400));
  check("the uploaded picture is the one scaled and padded", node(g, "LoadImage").inputs.image === "cardgen/up1.png"
    && node(g, "MOSSAnyPaintPrepare").inputs.source[0] === Object.keys(g).find((k) => g[k].class_type === "ImageScale"));
  check("16:9 from a portrait: one pass, room left and right only, centred", p.passes === 1 && p.top === 0 && p.bottom === 0 && p.left > 0 && Math.abs(p.left - p.right) <= 16, JSON.stringify(p));
  check("the canvas is 16:9 (within the 16 px rounding)", Math.abs(p.cw / p.ch - 16 / 9) < 0.03, `${p.cw}x${p.ch}`);
  check("the canvas is 1–1.5 MP", p.cw * p.ch >= 0.97 * MP && p.cw * p.ch <= 1.53 * MP, p.cw * p.ch / MP);
  check("every size and pad is a multiple of 16", mult16(p), JSON.stringify(p));
  check("the picture keeps its shape", Math.abs(p.w / p.h - 600 / 900) < 0.03, `${p.w}x${p.h}`);
  check("no description → the default carry-on prompt", /continued naturally beyond its original edges/.test(node(g, "MOSSAnyPaintEncode").inputs.prompt));
  check("…with a negative against lettering, at CFG 2", /typography.*logo.*banner/.test(node(g, "CLIPTextEncode").inputs.text)
    && g[node(g, "KSampler").inputs.negative[0]] === node(g, "CLIPTextEncode") && node(g, "KSampler").inputs.cfg === 2,
    JSON.stringify([node(g, "CLIPTextEncode").inputs.text, node(g, "KSampler").inputs.cfg]));
  // The original is pasted back over the result, fading in only along sides that meet new room.
  const paste = node(g, "ImageCompositeMasked").inputs;
  const fade = node(g, "FeatherMask").inputs;
  const solid = node(g, "SolidMask").inputs;
  check("the original is pasted back at its place, unchanged in size", g[paste.source[0]].class_type === "ImageScale"
    && paste.x === p.left && paste.y === p.top && paste.resize_source === false
    && solid.width === p.w && solid.height === p.h && g[g[56].inputs.images[0]] === node(g, "ImageCompositeMasked"),
    JSON.stringify({ paste, solid }));
  check("…fading in over 32 px only on the sides that meet new room", fade.left === 32 && fade.right === 32 && fade.top === 0 && fade.bottom === 0, JSON.stringify(fade));
  check("no mask node is needed", !node(g, "LoadImageMask") && !("generated_mask" in node(g, "MOSSAnyPaintPrepare").inputs));

  await extend({ sourceWidth: 600, sourceHeight: 900, ratio: 16 / 9, x: 0, y: 0.5, room: 1 }, { prompt: "a beach at sunset" });
  p = pads(lastGraph());
  check("x = 0 puts the picture at the left edge", p.left === 0 && p.right > 0, JSON.stringify(p));
  check("a description goes to the model as written", node(lastGraph(), "MOSSAnyPaintEncode").inputs.prompt === "a beach at sunset");
  check("…at CFG 1 with an empty negative", node(lastGraph(), "KSampler").inputs.cfg === 1 && node(lastGraph(), "CLIPTextEncode").inputs.text === "");

  await extend({ sourceWidth: 1600, sourceHeight: 900, ratio: 9 / 16, x: 0.5, y: 1, room: 1 });
  p = pads(lastGraph());
  check("9:16 from a landscape: room above only when y = 1", p.left === 0 && p.right === 0 && p.bottom === 0 && p.top > 0, JSON.stringify(p));

  await extend({ sourceWidth: 600, sourceHeight: 900, ratio: 2 / 3, x: 0.5, y: 0.5, room: 1.5 });
  p = pads(lastGraph());
  check("the same shape with extra room pads all four sides", p.left > 0 && p.right > 0 && p.top > 0 && p.bottom > 0, JSON.stringify(p));
  g = lastGraph();
  const [pass1, pass2] = preps(g);
  const decodeOf = (prepInputs) => g[prepInputs.source[0]];
  check("…in two passes: the sides, then the top and bottom", p.passes === 2
    && pass1.left > 0 && pass1.right > 0 && pass1.top === 0 && pass1.bottom === 0
    && pass2.left === 0 && pass2.right === 0 && pass2.top > 0 && pass2.bottom > 0, JSON.stringify([pass1, pass2]));
  check("…the second pass works on the first one's result, and that's what is saved",
    decodeOf(pass1).class_type === "ImageScale" && decodeOf(pass2).class_type === "VAEDecode"
    && g[g[56].inputs.images[0]].class_type === "ImageCompositeMasked"
    && g[g[g[56].inputs.images[0]].inputs.destination[0]].class_type === "VAEDecode"
    && g[g[56].inputs.images[0]].inputs.destination[0] !== pass2.source[0],
    JSON.stringify(Object.keys(g)));
  check("…with a different seed for each pass", new Set(Object.values(g).filter((n) => n.class_type === "KSampler").map((n) => n.inputs.seed)).size === 2);
  check("…and the fallback CFG on both", Object.values(g).filter((n) => n.class_type === "KSampler").every((n) => n.inputs.cfg === 2));
  check("…and the picture is about 2/3 of the canvas each way", Math.abs(p.w / p.cw - 2 / 3) < 0.04 && Math.abs(p.h / p.ch - 2 / 3) < 0.04, JSON.stringify(p));

  await extend({ sourceWidth: 300, sourceHeight: 300, ratio: 16 / 9, x: 0.5, y: 0.5, room: 1 });
  p = pads(lastGraph());
  check("a small picture is brought up to at least ~1 MP", p.cw * p.ch >= 0.97 * MP, p.cw * p.ch / MP);
  await extend({ sourceWidth: 4000, sourceHeight: 3000, ratio: 9 / 16, x: 0.5, y: 0.5, room: 2 });
  p = pads(lastGraph());
  check("a big one with lots of room comes down to ≤1.5 MP", p.cw * p.ch <= 1.53 * MP && mult16(p), p.cw * p.ch / MP);

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
  r = await api("POST", "/api/image/generations", { model: "local/moss-image", prompt: "", extend: { sourceWidth: 600, sourceHeight: 900, ratio: 1 } }, token);
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
  check("a kept extend is in Recent as an extend", kept.prompt === "Extended to 1:1" && kept.model === "local/moss-image", JSON.stringify(kept));

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

  // Extend from the page: the vision model describes the finished picture
  // first, then the GPU draws from that description.
  const { REPLIES } = require("./stack");
  const lastDescribe = () => model.calls.filter((c) => c.kind === "extend-describe").pop();
  const userText = (call) => JSON.stringify(call.body.messages[1].content);
  const promptsBefore = comfy.state.prompts.length;
  const describesBefore = model.count("extend-describe");
  const describeHold = model.hold("extend-describe", 1);
  const hold = comfy.state.holdNext();
  await page.fill("#playground-extend-prompt", "a lighthouse on the cliff behind");
  await page.click("#extend-playground-image-btn");
  await until(() => describeHold.reached, { what: "description held" });
  check("first: the status says it is describing, the button is off", await page.locator("#extend-playground-image-btn").isDisabled()
    && /Describing the finished picture/.test(await page.textContent("#playground-extend-status")));
  describeHold.release();
  await until(() => hold.reached, { what: "extend held on the GPU" });
  check("while drawing: the button is off and the status shows", await page.locator("#extend-playground-image-btn").isDisabled()
    && /Drawing the new edges/.test(await page.textContent("#playground-extend-status")));
  hold.release();
  await page.waitForFunction(() => !document.getElementById("extend-playground-image-btn").disabled, null, { timeout: 20000 });
  g = lastGraph();
  p = pads(g);
  const call = lastDescribe();
  check("one vision call, streamed, with the picture", model.count("extend-describe") === describesBefore + 1
    && call.stream && /image_url/.test(userText(call)));
  check("…told where the new room is and what the user asked for",
    /New picture is added above it \(\d+% of the finished picture's height\), to its left \(\d+% of the finished picture's width\)/.test(userText(call))
    && /What the user wants: a lighthouse on the cliff behind/.test(userText(call)), userText(call).slice(-400));
  check("the GPU gets the written description, at CFG 1", comfy.state.prompts.length === promptsBefore + 1
    && p.left > 0 && p.top > 0 && p.right === 0 && p.bottom === 0
    && node(g, "MOSSAnyPaintEncode").inputs.prompt === REPLIES["extend-describe"] && node(g, "KSampler").inputs.cfg === 1,
    JSON.stringify([p, node(g, "MOSSAnyPaintEncode").inputs.prompt]));
  check("the result becomes the working image", await page.evaluate((b64) => window.app.playgroundImageUrl === "data:image/png;base64," + b64, PNG_B64));
  check("…with a history entry", await page.evaluate(() => (window.app.playgroundHistory || []).some((e) => e.label === "Extended to 2:3")));
  const keptFromPage = await until(async () => { const l = await recent(); return l.items[0]?.prompt === "a lighthouse on the cliff behind" && l.items[0]; }, { what: "page extend kept" });
  check("…and it is kept in Recent", keptFromPage.tool === "extend");

  // The click handler reads the picture's size before it disables the button,
  // so wait for the draw to reach the GPU and then for the button.
  const extendAndWait = async () => {
    await setPicture(page);
    const before = comfy.state.prompts.length;
    await page.click("#extend-playground-image-btn");
    await until(() => comfy.state.prompts.length > before, { what: "extend reached the GPU" });
    await page.waitForFunction(() => !document.getElementById("extend-playground-image-btn").disabled, null, { timeout: 20000 });
    return comfy.state.prompts.length - before;
  };

  // Nothing typed: the description is still written.
  await page.fill("#playground-extend-prompt", "");
  await extendAndWait();
  check("an empty box still gets a description, asking to continue the scene",
    /nothing in particular; continue the scene/.test(userText(lastDescribe()))
    && node(lastGraph(), "MOSSAnyPaintEncode").inputs.prompt === REPLIES["extend-describe"]);

  // The vision model fails or refuses: the extend still happens, on the proxy's fallback.
  for (const [what, arrange] of [
    ["fails", () => { model.failAll["extend-describe"] = 500; }],
    ["refuses", () => { model.replies["extend-describe"] = "I'm sorry, I can't help with that request."; }],
  ]) {
    arrange();
    const drawn = await extendAndWait();
    delete model.failAll["extend-describe"];
    g = lastGraph();
    check(`the vision model ${what}: extended anyway, on the default prompt at CFG 2`, drawn === 1
      && /continued naturally/.test(node(g, "MOSSAnyPaintEncode").inputs.prompt) && node(g, "KSampler").inputs.cfg === 2,
      node(g, "MOSSAnyPaintEncode").inputs.prompt);
    check(`…and the page says it went without a description`, await page.evaluate(() => document.body.innerText.includes("Extended without a description")));
  }
  model.replies["extend-describe"] = REPLIES["extend-describe"];

  // The iPhone case: the page is hidden while the description streams.
  const setHidden = (hidden) => page.evaluate((h) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (h ? "hidden" : "visible") });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
  const hiddenBefore = { describes: model.count("extend-describe"), draws: comfy.state.prompts.length };
  await setPicture(page);
  const hiddenHold = model.hold("extend-describe", 1);
  await page.click("#extend-playground-image-btn");
  await until(() => hiddenHold.reached, { what: "description held before hiding" });
  await setHidden(true);
  hiddenHold.release();
  await sleep(500);
  await setHidden(false);
  await until(() => comfy.state.prompts.length > hiddenBefore.draws, { what: "draw after waking" });
  await page.waitForFunction(() => !document.getElementById("extend-playground-image-btn").disabled, null, { timeout: 20000 });
  check("hidden mid-description: one vision call, one draw, from the full description",
    model.count("extend-describe") === hiddenBefore.describes + 1 && comfy.state.prompts.length === hiddenBefore.draws + 1
    && node(lastGraph(), "MOSSAnyPaintEncode").inputs.prompt === REPLIES["extend-describe"],
    JSON.stringify([model.count("extend-describe") - hiddenBefore.describes, comfy.state.prompts.length - hiddenBefore.draws]));

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
