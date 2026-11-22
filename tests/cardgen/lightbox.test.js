// The lightbox (image-gallery.js): the picture area is the whole screen, so a
// zoomed picture fills it and a pinch or pan can start anywhere; a tap on the
// picture hides the toolbar, a tap off it closes; max zoom follows the picture's
// own pixels. Opened from the Playground's working image. Real page in headless
// WebKit with synthetic touches (390 px), plus a mouse at 1280 px. See README.md.
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

// Two pictures in the working image's history, 1600×2000 (portrait, so on a
// phone there is black above and below it at rest).
async function loadPictures(page) {
  await page.evaluate(() => {
    const draw = (hue) => {
      const c = document.createElement("canvas");
      c.width = 1600; c.height = 2000;
      const g = c.getContext("2d");
      g.fillStyle = `hsl(${hue} 60% 50%)`; g.fillRect(0, 0, 1600, 2000);
      g.fillStyle = "#fff"; g.fillRect(700, 900, 200, 200);
      return c.toDataURL("image/jpeg", 0.8);
    };
    const a = draw(200), b = draw(20);
    window.app.playgroundHistory = [];
    window.app._addPlaygroundHistoryEntry(a, "First");
    window.app._addPlaygroundHistoryEntry(b, "Second");
    window.app.playgroundImageUrl = a;
    window.app.updatePlaygroundImagePreview(a);
  });
  await page.waitForFunction(() => document.querySelector("#playground-image-preview img")?.complete);
}

// Synthetic touches on whatever is under the first point.
async function touch(page, type, points) {
  await page.evaluate(({ type, points }) => {
    const target = document.elementFromPoint(points[0]?.x ?? 1, points[0]?.y ?? 1) || document.body;
    window.__touchTarget = type === "touchstart" ? target : (window.__touchTarget || target);
    const t = window.__touchTarget;
    // WebKit won't construct Touch objects; the handlers only read these.
    const list = points.map((p, i) => ({ identifier: i, target: t, clientX: p.x, clientY: p.y, pageX: p.x, pageY: p.y }));
    const ended = type === "touchend";
    const ev = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "touches", { value: ended ? [] : list });
    Object.defineProperty(ev, "targetTouches", { value: ended ? [] : list });
    Object.defineProperty(ev, "changedTouches", { value: list });
    t.dispatchEvent(ev);
  }, { type, points });
}
const tap = async (page, x, y) => { await touch(page, "touchstart", [{ x, y }]); await touch(page, "touchend", [{ x, y }]); };

const state = (page) => page.evaluate(() => {
  const r = document.getElementById("gallery-image").getBoundingClientRect();
  const c = document.getElementById("gallery-image-container").getBoundingClientRect();
  const o = document.getElementById("gallery-lightbox");
  return {
    open: o.classList.contains("show"),
    chromeHidden: o.classList.contains("chrome-hidden"),
    scale: window.app._galleryScale, panX: window.app._galleryPanX, panY: window.app._galleryPanY,
    img: { l: r.left, t: r.top, w: r.width, h: r.height, r: r.right, b: r.bottom },
    box: { l: c.left, t: c.top, w: c.width, h: c.height },
    idx: window.app._galleryCurrentIdx,
    max: window.app._galleryMaxScale(),
    toolbarOpacity: getComputedStyle(document.querySelector(".gallery-toolbar")).opacity,
  };
});

(async () => {
  const stack = await start({ repo, stageDir: path.join(os.tmpdir(), "cardgen-test-stage-lightbox") });
  const { token } = stack;
  const browser = await webkit.launch();
  const pageErrors = [];
  const open = async (context) => {
    const page = await context.newPage();
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.goto(stack.url + "/", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!window.app && window.app.storageReady === true, null, { timeout: 20000 });
    await page.evaluate(() => document.getElementById("tab-playground")?.click());
    await page.waitForSelector("#view-playground", { state: "visible" });
    await loadPictures(page);
    return page;
  };
  const openLightbox = async (page) => {
    await page.click("#playground-image-preview img");
    await page.waitForFunction(() => document.getElementById("gallery-lightbox").classList.contains("show"));
    await page.waitForFunction(() => document.getElementById("gallery-image").complete && document.getElementById("gallery-image").naturalWidth > 0);
  };

  // ── Phone ─────────────────────────────────────────────────────────────────
  const W = 390, H = 844;
  const phone = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 3, hasTouch: true });
  await phone.addInitScript((t) => { try { localStorage.setItem("cardgen_auth_token", t); } catch (_) {} }, token);
  let page = await open(phone);
  await openLightbox(page);
  let s = await state(page);
  check("the picture area is the whole screen", s.box.l === 0 && s.box.t === 0 && s.box.w === W && s.box.h === H, JSON.stringify(s.box));
  check("at rest the picture fills the width", Math.abs(s.img.w - W) < 1 && Math.abs(s.img.h - W * 1.25) < 1, JSON.stringify(s.img));
  check("max zoom follows the picture's pixels (1600 px on 390 → ~8×)", s.max > 8 && s.max < 8.5, s.max);
  await page.screenshot({ path: path.join(os.tmpdir(), "lightbox-390-rest.png") });

  // Pinch started on the black below the picture.
  const below = s.img.b + 40;
  check("there is black below the picture to start on", below < H - 20, below);
  await touch(page, "touchstart", [{ x: 120, y: below }, { x: 270, y: below }]);
  await touch(page, "touchmove", [{ x: 60, y: below }, { x: 330, y: below }]);
  await touch(page, "touchend", [{ x: 60, y: below }, { x: 330, y: below }]);
  s = await state(page);
  check("a pinch that starts off the picture zooms it", s.scale > 1.7, s.scale);
  check("zoomed, the picture is not cropped to its resting box", s.img.w > W + 100 && s.img.l < 0 && s.img.r > W, JSON.stringify(s.img));

  // Pan from the black area (now covered by picture, but it was black at rest).
  const before = await state(page);
  await touch(page, "touchstart", [{ x: 200, y: below }]);
  await touch(page, "touchmove", [{ x: 260, y: below - 80 }]);
  await touch(page, "touchend", [{ x: 260, y: below - 80 }]);
  s = await state(page);
  check("one finger pans the zoomed picture", s.panX !== before.panX || s.panY !== before.panY, JSON.stringify({ before: [before.panX, before.panY], after: [s.panX, s.panY] }));
  check("…and stays open (a drag is not a tap)", s.open);

  // Pan far: the picture's edge stops at the screen's edge.
  await touch(page, "touchstart", [{ x: 100, y: 400 }]);
  await touch(page, "touchmove", [{ x: 3000, y: 400 }]);
  await touch(page, "touchend", [{ x: 3000, y: 400 }]);
  s = await state(page);
  check("panning stops with the left edge at the screen's edge", Math.abs(s.img.l) < 1, s.img.l);

  // Zoom to the top with the ＋ button.
  for (let i = 0; i < 20; i++) await page.click("#gallery-zoom-in-btn");
  s = await state(page);
  check("＋ goes past the old 5× limit, to the picture's own limit", s.scale > 5 && Math.abs(s.scale - s.max) < 0.01, s.scale);
  await page.screenshot({ path: path.join(os.tmpdir(), "lightbox-390-zoomed.png") });

  // Double tap back out; it doesn't hide the toolbar.
  await tap(page, 200, 400); await sleep(80); await tap(page, 200, 400);
  await sleep(400);
  s = await state(page);
  check("double tap zooms back out", s.scale === 1 && s.panX === 0 && s.panY === 0, s.scale);
  check("…without hiding the toolbar", !s.chromeHidden);

  // Single tap on the picture: toolbar away, and back.
  const mid = s.img.t + s.img.h / 2;
  await tap(page, 200, mid);
  await sleep(150);
  check("a single tap waits for a possible second tap", !(await state(page)).chromeHidden);
  await sleep(300);
  s = await state(page);
  check("a tap on the picture hides the toolbar, arrows and caption", s.chromeHidden && s.open, JSON.stringify(s));
  await sleep(250);
  check("…which fade out", (await state(page)).toolbarOpacity === "0");
  await page.screenshot({ path: path.join(os.tmpdir(), "lightbox-390-clean.png") });
  const zoomBtnClickable = await page.evaluate(() => getComputedStyle(document.getElementById("gallery-zoom-in-btn").parentElement).pointerEvents);
  check("hidden buttons can't be hit", zoomBtnClickable === "none");
  await tap(page, 200, mid); await sleep(400);
  check("another tap brings them back", !(await state(page)).chromeHidden);

  // Swipe to the next picture still works.
  await touch(page, "touchstart", [{ x: 300, y: mid }]);
  await touch(page, "touchmove", [{ x: 100, y: mid }]);
  await touch(page, "touchend", [{ x: 100, y: mid }]);
  check("a swipe moves to the other picture", (await state(page)).idx === 1);

  // Tap the black: closes, as the backdrop did.
  await tap(page, 200, below); await sleep(400);
  check("a tap off the picture closes the lightbox", !(await state(page)).open);
  await openLightbox(page);
  check("reopening shows the toolbar", !(await state(page)).chromeHidden);
  await page.click("#gallery-close-btn");
  check("✕ closes", !(await state(page)).open);

  await phone.close();

  // ── Desktop mouse ────────────────────────────────────────────────────────
  const desk = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await desk.addInitScript((t) => { try { localStorage.setItem("cardgen_auth_token", t); } catch (_) {} }, token);
  page = await open(desk);
  await openLightbox(page);
  s = await state(page);
  check("desktop: the picture fills the height", Math.abs(s.img.h - 800) < 1, JSON.stringify(s.img));
  await page.mouse.click(s.img.l + 50, 400);
  check("desktop: a click on the picture leaves it open", (await state(page)).open);
  await page.mouse.wheel(0, -300);
  await page.mouse.move(640, 400); await page.mouse.wheel(0, -100); await sleep(50);
  s = await state(page);
  check("desktop: the wheel zooms", s.scale > 1, s.scale);
  await page.mouse.move(640, 400); await page.mouse.down(); await page.mouse.move(400, 300, { steps: 5 }); await page.mouse.up();
  const dragged = await state(page);
  check("desktop: a drag pans and doesn't close", dragged.open && (dragged.panX !== s.panX || dragged.panY !== s.panY), JSON.stringify({ open: dragged.open, before: [s.panX, s.panY], after: [dragged.panX, dragged.panY] }));
  await page.click("#gallery-zoom-out-btn"); for (let i = 0; i < 20; i++) await page.click("#gallery-zoom-out-btn");
  s = await state(page);
  await page.mouse.click(Math.max(5, s.img.l / 2), 400);
  check("desktop: a click on the black closes", !(await state(page)).open);
  await page.keyboard.press("Escape");
  await openLightbox(page);
  await page.keyboard.press("Escape");
  check("desktop: Esc closes", !(await state(page)).open);
  await desk.close();

  check("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
  await browser.close();
  await stack.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
