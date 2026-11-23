// Story Writer's ✨ New story sheet: the ✍️ Freeform tile beside the lengths
// (no plan, the opening written at once, then a part at a time on Continue)
// and the planned lengths (✨ Write the whole story). Real page in headless
// WebKit at 390 px light and 320 px dark; Story Writer's backend (/api/sw/*) is
// faked in the browser with page.route. See README.md.
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

const OPENING = "The rain had not let up since noon.\n\nMira stood under the awning and waited.";

// A tiny Story Writer backend. `sent` records every request the page makes.
async function fakeStoryBackend(page) {
  const sent = [];
  let story = null;
  await page.route("**/api/sw/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname.replace(/^\/api\/sw/, "");
    const body = req.postData() ? JSON.parse(req.postData()) : null;
    sent.push({ method: req.method(), path: p, body });
    const json = (data, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
    if (p === "/cards/") return json([{ id: 1, name: "Mira" }, { id: 2, name: "Joe" }]);
    if (p === "/stories/" && req.method() === "POST") {
      story = { id: 7, title: body.title || "", synopsis: body.synopsis || "", segments: [], characters: [],
        card_ids: body.card_ids, is_autowritten: false, created_at: new Date().toISOString() };
      return json(story);
    }
    if (p === "/stories/autowrite" && req.method() === "POST") {
      story = { id: 8, title: "", synopsis: "", segments: [], characters: [], is_autowritten: true, created_at: new Date().toISOString() };
      return json(story);
    }
    if (p === "/stories/7" && story) return json(story);
    if (p === "/stories/8" && story) return json(story);
    if (p.startsWith("/stories/8/autowrite")) return json({ status: "planning", chapters_done: 0, chapters_total: 7, partial: "", from: 0 });
    if (p === "/generate") {
      await sleep(300);
      story.segments.push({ id: 100 + story.segments.length, content: OPENING, order_index: story.segments.length, is_summary: false });
      const sse = [
        { type: "chunk", content: OPENING.slice(0, 20) },
        { type: "chunk", content: OPENING.slice(20) },
        { type: "done", segment_id: 100 },
      ].map((d) => `data: ${JSON.stringify(d)}\n\n`).join("");
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: sse });
    }
    if (req.method() === "GET") return json(p.endsWith("/") ? [] : {});
    return json({});
  });
  return sent;
}

async function openSheet(page) {
  await page.evaluate(() => document.getElementById("tab-storywriter")?.click());
  await page.waitForFunction(() => window.storyWriterApp?.autowriter);
  await page.evaluate(() => window.storyWriterApp.createStory());
  await page.waitForFunction(() => {
    const s = document.getElementById("sw-setup-sheet");
    return s && !s.hidden && s.querySelectorAll(".saw-length").length === 5;
  });
}

const visible = (page, sel) => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
}, sel);

async function run(browser, stack, { width, height, dark }) {
  const tag = `${width}${dark ? " dark" : ""}`;
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 3, hasTouch: true, serviceWorkers: "block", colorScheme: dark ? "dark" : "light" });
  await ctx.addInitScript(([t, dark]) => {
    try {
      localStorage.setItem("cardgen_auth_token", t);
      localStorage.removeItem("cardgen.storySetup.v1");
      if (dark) localStorage.setItem("theme", "dark");
    } catch (_) {}
  }, [stack.token, dark]);
  const page = await ctx.newPage();
  const sent = await fakeStoryBackend(page);
  await page.goto(stack.url + "/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.storyWriterApp && document.getElementById("tab-storywriter"), null, { timeout: 20000 });
  check(`${tag}: the app rendered (not a blank or login page)`, await visible(page, "#tab-storywriter"));

  await openSheet(page);
  const tiles = await page.$$eval("#sw-setup-sheet .saw-length", (els) => els.map((e) => ({ id: e.dataset.length, w: e.getBoundingClientRect().width })));
  check(`${tag}: five tiles, Freeform last`, tiles.length === 5 && tiles[4].id === "freeform", JSON.stringify(tiles));
  check(`${tag}: Freeform spans the row`, tiles[4].w > tiles[0].w * 1.8, JSON.stringify(tiles));
  check(`${tag}: default is a planned length: Ending and the slider show`, await visible(page, "#saw-faith") && await visible(page, '[data-ending="any"]'));
  check(`${tag}: planned: only ✨ Write the whole story`, await visible(page, '[data-act="auto"]') && !(await visible(page, '[data-act="manual"]')));
  check(`${tag}: planned: no freeform hint`, !(await visible(page, '[data-el="freeform-hint"]')));

  await page.click('[data-length="freeform"]');
  check(`${tag}: Freeform pressed`, await page.$eval('[data-length="freeform"]', (e) => e.getAttribute("aria-pressed")) === "true");
  check(`${tag}: Freeform hides Ending and the slider`, !(await visible(page, "#saw-faith")) && !(await visible(page, '[data-ending="any"]')));
  check(`${tag}: Freeform shows its hint`, await visible(page, '[data-el="freeform-hint"]'));
  check(`${tag}: Freeform: only ✍️ Start writing`, await visible(page, '[data-act="manual"]') && !(await visible(page, '[data-act="auto"]')));
  const sideways = await page.evaluate(() => {
    const sheet = document.querySelector("#sw-setup-sheet .pb-scroll");
    return { doc: document.documentElement.scrollWidth - window.innerWidth, sheet: sheet.scrollWidth - sheet.clientWidth };
  });
  check(`${tag}: no sideways scroll`, sideways.doc <= 0 && sideways.sheet <= 0, JSON.stringify(sideways));
  await page.screenshot({ path: path.join(os.tmpdir(), `story-setup-${width}${dark ? "-dark" : ""}.png`) });

  // Back to Medium and forward again: the toggle goes both ways.
  await page.click('[data-length="medium"]');
  check(`${tag}: back to Medium restores Ending and the slider`, await visible(page, "#saw-faith") && await visible(page, '[data-act="auto"]') && !(await visible(page, '[data-act="manual"]')));
  await page.click('[data-length="freeform"]');

  await page.fill("#saw-idea", "A rainy night at a station");
  await page.click('[data-act="manual"]');
  await page.waitForFunction(() => document.getElementById("sw-setup-sheet").hidden);
  await page.waitForFunction((t) => document.getElementById("sw-story-area")?.textContent.includes("Mira stood under the awning"), OPENING, { timeout: 10000 })
    .catch(() => {});
  const creates = sent.filter((r) => r.method === "POST" && r.path === "/stories/");
  const gens = sent.filter((r) => r.path === "/generate");
  check(`${tag}: one plain story created with the idea as synopsis`, creates.length === 1 && creates[0].body.synopsis === "A rainy night at a station", JSON.stringify(creates));
  check(`${tag}: no autowrite run started`, !sent.some((r) => r.path === "/stories/autowrite"));
  check(`${tag}: the opening is written straight away, once, unsteered`, gens.length === 1 && gens[0].body.story_id === 7 && gens[0].body.steering === null, JSON.stringify(gens));
  check(`${tag}: the opening shows in the reader`, await page.evaluate(() => document.getElementById("sw-story-area").textContent.includes("Mira stood under the awning")));
  await page.waitForFunction(() => !window.storyWriterApp.isFetchingLLM, null, { timeout: 10000 });
  check(`${tag}: Continue and the steer box are there for the next part`, await visible(page, "#sw-generate-btn") && await visible(page, "#sw-steering"));
  check(`${tag}: the auto-writer panel stays hidden`, !(await visible(page, "#sw-auto-panel")));

  // Steer, then Continue: one more part, with the note.
  await page.fill("#sw-steering", "A stranger offers her an umbrella");
  await page.click("#sw-generate-btn");
  await page.waitForFunction(() => !window.storyWriterApp.isFetchingLLM, null, { timeout: 10000 });
  const gens2 = sent.filter((r) => r.path === "/generate");
  check(`${tag}: Continue writes the next part with the steer`, gens2.length === 2 && gens2[1].body.steering === "A stranger offers her an umbrella", JSON.stringify(gens2.map((g) => g.body)));

  // Remembered: the next New story opens on Freeform.
  await page.evaluate(() => document.getElementById("sw-back-btn")?.click());
  await openSheet(page);
  check(`${tag}: Freeform remembered next time`, await page.$eval('[data-length="freeform"]', (e) => e.getAttribute("aria-pressed")) === "true");

  // A planned length still starts an autowrite run, with no hand-driven generate.
  await page.click('[data-length="medium"]');
  const before = sent.filter((r) => r.path === "/generate").length;
  await page.click('[data-act="auto"]');
  await page.waitForFunction(() => document.getElementById("sw-setup-sheet").hidden);
  await sleep(800);
  const auto = sent.filter((r) => r.path === "/stories/autowrite");
  check(`${tag}: Medium starts an autowrite run`, auto.length === 1 && auto[0].body.length === "medium", JSON.stringify(auto));
  check(`${tag}: Medium makes no hand-driven generate`, sent.filter((r) => r.path === "/generate").length === before);

  await ctx.close();
}

(async () => {
  const stack = await start({ repo, stageDir: path.join(os.tmpdir(), "cardgen-test-stage-story-setup") });
  const browser = await webkit.launch();
  try {
    await run(browser, stack, { width: 390, height: 844, dark: false });
    await run(browser, stack, { width: 320, height: 640, dark: true });
  } catch (e) {
    failed++;
    console.log("FAIL threw: " + (e.stack || e));
  } finally {
    await browser.close();
    await stack.stop();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
