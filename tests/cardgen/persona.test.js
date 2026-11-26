// 🎭 Personas (plans/persona-mode.md). Two halves:
//  1. No browser, through the real proxy: a persona card saved and loaded with
//     its type and extras, an older client's save not undoing it, the light
//     lists, a server run that writes a persona (no finishing fields, no cast),
//     and a Revise run that rewrites a character card as a persona.
//  2. The real page in headless WebKit: Character Gen's persona type, the
//     shared persona picker (suggestions, cast, Just a name, ✨ New written on
//     the server with the page hidden mid-run and with the tab discarded),
//     Roleplay Chat and Messenger sending the persona card, and Home.
// See README.md for the two environment variables.
const os = require("os");
const path = require("path");
const { start, sleep } = require("./stack");

const repo = path.resolve(__dirname, "..", "..");
let failed = 0, passed = 0;
const check = (name, ok, detail = "") => {
  if (ok) { passed++; console.log("ok   " + name); }
  else { failed++; console.log("FAIL " + name + (detail ? "\n     " + String(detail).slice(0, 500) : "")); }
};

async function waitFor(fn, ms = 15000, step = 50) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await sleep(step);
  }
}

async function waitRun(stack, id, token = stack.token) {
  return waitFor(async () => {
    const r = await stack.api("GET", `/api/card-runs/${id}`, undefined, token);
    return r.json && r.json.status !== "running" ? r.json : null;
  }, 30000, 100);
}

async function proxyHalf(stack) {
  const { api, token, userId, backend, model } = stack;

  // ── Save and load ──
  const saved = await api("POST", "/api/storage/cards", {
    isPermanent: true, characterName: "Joe Marsh",
    character: { name: "Joe Marsh", description: "# Joe Marsh\n\nA paramedic.", personality: "- Calm", cardType: "persona",
      persona: { age: "34", gender: "he/him", voice: "Few words." }, tags: ["persona"] },
  }, token);
  const row = backend.cards(userId).get(String(saved.json?.id));
  check("save: a persona is stored as kind persona with its extras", row?.kind === "persona" && JSON.parse(row.persona).age === "34" && JSON.parse(row.persona).voice === "Few words.", JSON.stringify(row));
  const loaded = await api("GET", `/api/storage/cards/${saved.json.id}`, undefined, token);
  check("load: the card comes back as a persona (cardType, age, gender, voice)", loaded.json?.kind === "persona" && loaded.json?.character?.cardType === "persona" && loaded.json?.character?.persona?.gender === "he/him", JSON.stringify(loaded.json?.character));
  const old = await api("POST", "/api/storage/cards", { isPermanent: true, id: saved.json.id, characterName: "Joe Marsh",
    character: { name: "Joe Marsh", description: "Edited by an old page." } }, token);
  check("an older page's save (no type) leaves it a persona", old.status === 200 && row.kind === "persona" && JSON.parse(row.persona).age === "34", JSON.stringify(row));
  const npc = await api("POST", "/api/storage/cards", { isPermanent: true, characterName: "Mira", character: { name: "Mira", description: "x", cardType: "single" } }, token);
  check("a character saved with its type stays a character", backend.cards(userId).get(String(npc.json.id))?.kind === "character");

  const summary = await api("GET", "/api/storage/cards/summary", undefined, token);
  const s = Object.fromEntries(summary.json.map((r) => [r.id, r]));
  check("summary: kind and the persona's age / gender", s[saved.json.id]?.kind === "persona" && s[saved.json.id]?.persona?.age === "34" && s[npc.json.id]?.kind === "character" && !s[npc.json.id]?.persona, JSON.stringify(s[saved.json.id]));
  const library = await api("GET", "/api/storage/cards/library", undefined, token);
  check("library list marks personas", library.json.find((r) => r.id === saved.json.id)?.kind === "persona" && !library.json.find((r) => r.id === npc.json.id)?.kind, JSON.stringify(library.json));
  await api("DELETE", `/api/storage/cards/${npc.json.id}`, undefined, token);

  // ── A persona written on the server ──
  model.calls.length = 0;
  const run = await api("POST", "/api/card-runs", { key: "persona-run-1", kind: "new-card", settings: stack.config,
    spec: { mode: "classic", concept: "a tired paramedic", cardType: "persona", cast: { want: true }, portrait: { want: false } } }, token);
  check("a persona run starts", run.status === 200 && run.json?.id, run.text);
  const done = await waitRun(stack, run.json.id);
  const kinds = model.calls.map((c) => c.kind);
  check("persona run: written with the persona prompt, then tags; no card, finishing or cast calls",
    done?.status === "done" && kinds.includes("persona") && kinds.includes("tags") && !kinds.some((k) => ["card", "finishing", "cast-list", "examples", "notes", "posthistory"].includes(k)), `${done?.status} ${kinds.join(",")}`);
  const card = done?.card || {};
  check("persona run: the card is a persona with age, gender and voice", card.cardType === "persona" && card.persona?.age === "34" && card.persona?.gender === "Man, he/him" && /Yorkshire/.test(card.persona?.voice || ""), JSON.stringify(card.persona));
  check("persona run: real name, no {{char}} / {{user}}, no scenario or first message",
    card.name === "Joe Marsh" && !/\{\{/.test(JSON.stringify(card)) && !card.scenario && !card.firstMessage && /^# Joe Marsh/.test(card.description), JSON.stringify(card).slice(0, 400));
  check("persona run: tagged persona", Array.isArray(card.tags) && card.tags[0] === "persona" && card.tags.length > 1, JSON.stringify(card.tags));
  check("persona run: no supporting cast step even when asked", !done.steps.some((st) => st.name === "cast"), JSON.stringify(done.steps));
  check("persona run: in History as a persona", backend.history(userId).some((h) => h.data?.character?.cardType === "persona"));
  const system = model.calls.find((c) => c.kind === "persona")?.body.messages[0].content || "";
  check("persona prompt: facts not behaviour rules, short, portable, real name",
    /NOT instructions for playing them/.test(system) && /150–300 words/.test(system) && /no scenario/.test(system) && /Do NOT use \{\{char\}\} or \{\{user\}\}/.test(system));

  // ── Make a persona from a character card (a Revise run) ──
  model.calls.length = 0;
  const rev = await api("POST", "/api/card-runs", { key: "persona-rev-1", kind: "revise", settings: stack.config,
    spec: { card: { name: "Mira Okafor", description: "# Mira Okafor's Profile\n\n{{char}} keeps a light.", personality: "x", scenario: "A storm.", firstMessage: "Hi {{user}}", mesExample: "<START>", creatorNotes: "n", cardType: "persona", persona: {} },
      instruction: "Rewrite this character card as a persona", withFinishing: true } }, token);
  const revDone = await waitRun(stack, rev.json.id);
  const rk = model.calls.map((c) => c.kind);
  check("make-a-persona: the persona revise prompt, then tags only", revDone?.status === "done" && rk.includes("persona-revise") && rk.includes("tags") && !rk.includes("revise") && !rk.includes("finishing"), `${revDone?.status} ${rk.join(",")}`);
  const rc = revDone?.card || {};
  check("make-a-persona: persona fields, nothing a persona doesn't use", rc.cardType === "persona" && rc.persona?.age === "41" && /Cornish/.test(rc.persona?.voice || "") && !rc.scenario && !rc.firstMessage && !rc.mesExample && !rc.creatorNotes, JSON.stringify(rc).slice(0, 400));
}

// ── The page ────────────────────────────────────────────────────────────────

async function openPage(browser, stack, { width = 390, height = 844, dark = false, init = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, hasTouch: width < 800, serviceWorkers: "block", colorScheme: dark ? "dark" : "light" });
  await ctx.addInitScript(([t, dark]) => {
    try {
      localStorage.setItem("cardgen_auth_token", t);
      if (dark) localStorage.setItem("theme", "dark");
    } catch (_) {}
  }, [stack.token, dark]);
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept());
  page.on("pageerror", (e) => console.log("     [pageerror]", e.message));
  await page.goto(stack.url + "/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.PersonaPicker && window.app && window.roleplayChatHandler && document.querySelectorAll("#home-grid .hc-tile").length > 0, null, { timeout: 20000 });
  return { ctx, page };
}

const hide = (page) => page.evaluate(() => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
  document.dispatchEvent(new Event("visibilitychange"));
});
const show = (page) => page.evaluate(() => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  document.dispatchEvent(new Event("visibilitychange"));
});

/** Mount a picker into a test box on the page. */
const mountPicker = (page, opts = {}) => page.evaluate((o) => {
  document.getElementById("pp-test")?.remove();
  const box = document.createElement("div");
  box.id = "pp-test";
  box.style.cssText = "position:fixed;inset:0 0 auto 0;z-index:5000;background:var(--surface-color,#fff);padding:8px";
  document.body.appendChild(box);
  window.__cast = o.cast || [];
  window.__pp = window.PersonaPicker.mount(box, { value: o.value || null, nameHint: o.nameHint || "", cast: () => window.__cast });
  return window.__pp.ready;
}, opts);
const picked = (page) => page.evaluate(() => window.__pp.get());

async function cardGen(browser, stack) {
  const tag = "390 Character Gen";
  const { ctx, page } = await openPage(browser, stack);
  await page.click("#tab-cardgen");
  await page.selectOption("#card-type-select", "persona");
  const hidden = await page.evaluate(() => ({
    pov: getComputedStyle(document.getElementById("pov-select").closest(".form-group")).display,
    cast: getComputedStyle(document.getElementById("auto-generate-cast").closest(".form-group")).display,
    hint: document.getElementById("card-type-hint").textContent,
    label: document.querySelector('label[for="character-name"]')?.textContent,
  }));
  check(`${tag}: persona type hides point of view and supporting cast`, hidden.pov === "none" && hidden.cast === "none", JSON.stringify(hidden));
  check(`${tag}: says what a persona is, and asks for your name`, /chats and adventures/.test(hidden.hint) && /Your Name/.test(hidden.label || ""), JSON.stringify(hidden));
  stack.model.calls.length = 0;
  await page.fill("#character-concept", "a tired night-shift paramedic");
  await page.click("#generate-btn");
  await page.waitForFunction(() => window.app.currentCharacter?.cardType === "persona" && window.app.currentCharacter.tags?.length > 1, null, { timeout: 30000 }).catch(() => {});
  const kinds = stack.model.calls.map((c) => c.kind);
  check(`${tag}: written with the persona prompt and tagged; no finishing fields`, kinds.includes("persona") && kinds.includes("tags") && !kinds.includes("finishing") && !kinds.includes("card"), kinds.join(","));
  const shown = await page.evaluate(() => {
    const vis = (id) => { const el = document.getElementById(id); return !!el && el.offsetParent !== null; };
    return {
      age: document.getElementById("persona-age").value, gender: document.getElementById("persona-gender").value,
      voice: document.getElementById("persona-voice").value, personaVisible: vis("persona-age"),
      scenario: vis("character-scenario"), first: vis("character-first-message"), examples: vis("example-messages-output") || !!document.querySelector(".example-messages-section")?.offsetParent,
      post: vis("character-post-history"), notes: vis("creator-notes"), desc: document.getElementById("character-description").value,
    };
  });
  check(`${tag}: the editor shows age, gender and how they talk`, shown.personaVisible && shown.age === "34" && shown.gender === "Man, he/him" && /Yorkshire/.test(shown.voice), JSON.stringify(shown));
  check(`${tag}: and hides scenario, first message, examples, post-history and notes`, !shown.scenario && !shown.first && !shown.examples && !shown.post && !shown.notes, JSON.stringify(shown));
  check(`${tag}: the description keeps the real name`, /^# Joe Marsh/.test(shown.desc) && !/\{\{char\}\}/.test(shown.desc), shown.desc.slice(0, 80));
  await page.fill("#persona-age", "35");
  check(`${tag}: editing age updates the card`, await page.evaluate(() => window.app.currentCharacter.persona.age === "35"));
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(`${tag}: no sideways scroll`, sideways <= 0, sideways);
  await page.screenshot({ path: path.join(os.tmpdir(), "persona-cardgen.png"), fullPage: false });

  // Clearing the form or loading a character puts the character fields back.
  await page.evaluate(() => window.app.resetCharacterForm());
  check(`${tag}: a cleared form is not in persona mode`, await page.evaluate(() => !document.getElementById("view-cardgen").classList.contains("cg-persona-card") && document.getElementById("card-type-select").value === "single" && !document.getElementById("view-cardgen").classList.contains("cg-make-persona")));
  await ctx.close();
}

async function picker(browser, stack) {
  const { backend, userId } = stack;
  // Two personas (Ann the default), and a character.
  const joe = backend.addCard(userId, { name: "Joe Persona", kind: "persona", persona: JSON.stringify({ age: "34", gender: "he/him" }), tags: "persona" });
  const ann = backend.addCard(userId, { name: "Ann Persona", kind: "persona", persona: JSON.stringify({ age: "29", isDefault: true }), tags: "persona" });
  const mira = backend.addCard(userId, { name: "Mira Character", description: "A lighthouse keeper." });
  const tag = "390 picker";
  const { ctx, page } = await openPage(browser, stack);
  // Once, not as an init script: a reopened page must still find a pending run.
  await page.evaluate(() => { localStorage.removeItem("cardgen.personaFor.v1"); localStorage.removeItem("cardgen.personaRun.v1"); });

  await mountPicker(page, { cast: [mira.id] });
  const tiles = await page.$$eval("#pp-test .pp-tile .pp-name", (els) => els.map((e) => e.textContent.trim()));
  check(`${tag}: personas as tiles, default first, then Just a name / New / From a card`, tiles[0] === "★ Ann Persona" && tiles.includes("Joe Persona") && !tiles.includes("Mira Character") && tiles.slice(-3).join("|") === "Just a name|New persona|From a card", tiles.join("|"));
  check(`${tag}: the default is pre-picked`, (await picked(page)).cardId === ann.id, JSON.stringify(await picked(page)));
  check(`${tag}: says who you're playing`, /Playing as Ann Persona/.test(await page.textContent("#pp-test .pp-chosen")));
  check(`${tag}: with a persona picked, the name and new-persona fields are not shown`,
    await page.isHidden("#pp-test [data-name]") && await page.isHidden("#pp-test [data-new-name]"));

  await page.evaluate((id) => window.PersonaPicker.remember([id], null), mira.id);
  await page.evaluate(([m, j]) => window.PersonaPicker.remember([m], j), [mira.id, joe.id]);
  await mountPicker(page, { cast: [mira.id] });
  check(`${tag}: the persona last played with these characters beats the default`, (await picked(page)).cardId === joe.id);

  await page.evaluate((id) => { window.__cast = [id]; window.__pp.refreshCast(); }, joe.id);
  const greyed = await page.$eval(`#pp-test input[value="card:${joe.id}"]`, (e) => e.disabled);
  check(`${tag}: a persona already in the chat as a character is greyed out and not picked`, greyed && (await picked(page)).cardId !== joe.id, JSON.stringify(await picked(page)));

  await mountPicker(page, { value: { cardId: null, name: "Sam", detail: "A sailor." } });
  check(`${tag}: an existing "just a name" choice is kept, not replaced by the default`, JSON.stringify(await picked(page)) === JSON.stringify({ cardId: null, name: "Sam", detail: "A sailor." }), JSON.stringify(await picked(page)));
  await page.click('#pp-test .pp-tile:has(input[value="card:' + ann.id + '"])');
  check(`${tag}: tapping a tile picks it`, (await picked(page)).cardId === ann.id);
  await page.click('#pp-test .pp-tile:has(input[value="name"])');
  await page.fill("#pp-test [data-name]", "Pat");
  check(`${tag}: Just a name shows the name field and hides "Playing as"`, await page.isVisible("#pp-test [data-name]") && await page.isHidden("#pp-test .pp-chosen"));
  check(`${tag}: Just a name gives the typed name`, (await picked(page)).name === "Pat" && (await picked(page)).cardId === null);

  // ☆ Make default
  await page.click('#pp-test .pp-tile:has(input[value="card:' + joe.id + '"])');
  await page.click("#pp-test [data-make-default]");
  await waitFor(() => JSON.parse(backend.cards(userId).get(String(joe.id)).persona).isDefault);
  check(`${tag}: ☆ Make default moves the default`, JSON.parse(backend.cards(userId).get(String(joe.id)).persona).isDefault && !JSON.parse(backend.cards(userId).get(String(ann.id)).persona).isDefault);

  // ✨ New, saved as typed
  await page.click('#pp-test .pp-tile:has(input[value="new"])');
  await page.fill("#pp-test [data-new-name]", "Kim Typed");
  await page.fill("#pp-test [data-new-idea]", "A quiet librarian.");
  await page.click("#pp-test [data-new-save]");
  await page.waitForFunction(() => /Kim Typed/.test(document.querySelector("#pp-test .pp-chosen")?.textContent || ""), null, { timeout: 8000 }).catch(() => {});
  const kim = [...backend.cards(userId).values()].find((c) => c.name === "Kim Typed");
  check(`${tag}: Save as typed makes a persona card and picks it`, kim?.kind === "persona" && (await picked(page)).cardId === kim?.id && /quiet librarian/.test(kim?.description || ""), JSON.stringify(kim));

  // ✨ Write it for me, with the page hidden part-way: no polling while hidden.
  const joeMarshBefore = [...backend.cards(userId).values()].filter((c) => c.name === "Joe Marsh").map((c) => c.id);
  const polls = [];
  page.on("request", (r) => { if (/\/api\/card-runs\/[a-f0-9-]{36}$/.test(r.url())) polls.push(Date.now()); });
  stack.model.calls.length = 0;
  const hold = stack.model.hold("persona", 2);
  await page.click('#pp-test .pp-tile:has(input[value="new"])');
  await page.fill("#pp-test [data-new-name]", "");
  await page.fill("#pp-test [data-new-idea]", "a tired paramedic from Leeds");
  await page.click("#pp-test [data-new-write]");
  await waitFor(() => hold.reached);
  await hide(page);
  await sleep(300);
  const hiddenAt = polls.length;
  hold.release();
  await sleep(4000);
  check(`${tag}: ✨ Write it: no polling while the page is hidden`, polls.length === hiddenAt, `${hiddenAt} → ${polls.length}`);
  check(`${tag}: ...and the server finished it anyway`, stack.model.count("tags") >= 1);
  await show(page);
  await page.waitForFunction(() => /Joe Marsh/.test(document.querySelector("#pp-test .pp-chosen")?.textContent || ""), null, { timeout: 15000 }).catch(() => {});
  const written = [...backend.cards(userId).values()].filter((c) => c.name === "Joe Marsh" && c.kind === "persona" && !joeMarshBefore.includes(c.id));
  check(`${tag}: back on the page it is saved to the Library once and picked`, written.length === 1 && (await picked(page)).cardId === written[0]?.id, `${written.length} ${JSON.stringify(await picked(page))}`);
  const inView = await page.evaluate(() => { const row = document.querySelector("#pp-test .pp-row").getBoundingClientRect(); const t = document.querySelector("#pp-test .pp-tile.is-on")?.getBoundingClientRect(); return !!t && t.left >= row.left - 1 && t.right <= row.right + 1; });
  check(`${tag}: the new persona's tile is scrolled into view and highlighted`, inView);
  check(`${tag}: one model call for the persona (nothing paid twice)`, stack.model.count("persona") === 1, stack.model.count("persona"));
  const layout = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth - window.innerWidth, row: document.querySelector("#pp-test .pp-row").scrollWidth > 0 }));
  check(`${tag}: no sideways page scroll (the tile row scrolls itself)`, layout.doc <= 0, JSON.stringify(layout));
  await page.screenshot({ path: path.join(os.tmpdir(), "persona-picker.png") });

  // ✨ Write it, then the tab is discarded mid-run: the next picker saves it.
  const hold2 = stack.model.hold("persona", 2);
  stack.model.replies.persona = stack.model.replies.persona.replace(/Joe Marsh/g, "Rae Discard");
  await page.click('#pp-test .pp-tile:has(input[value="new"])');
  await page.fill("#pp-test [data-new-idea]", "someone else");
  await page.click("#pp-test [data-new-write]");
  await waitFor(() => hold2.reached);
  await page.close();
  hold2.release();
  await sleep(1500);
  check(`${tag}: discarded tab: nothing saved to the Library yet`, ![...backend.cards(userId).values()].some((c) => c.name === "Rae Discard"));
  const page2 = await ctx.newPage();
  await page2.goto(stack.url + "/", { waitUntil: "domcontentloaded" });
  await page2.waitForFunction(() => window.PersonaPicker && document.querySelectorAll("#home-grid .hc-tile").length > 0, null, { timeout: 20000 });
  await mountPicker(page2, {});
  await waitFor(() => [...backend.cards(userId).values()].some((c) => c.name === "Rae Discard"), 15000);
  const rae = [...backend.cards(userId).values()].filter((c) => c.name === "Rae Discard");
  check(`${tag}: the next picker to open saves it, once`, rae.length === 1 && rae[0].kind === "persona", rae.length);
  await mountPicker(page2, {});
  await sleep(1000);
  check(`${tag}: and not again on the next one`, [...backend.cards(userId).values()].filter((c) => c.name === "Rae Discard").length === 1);
  check(`${tag}: one model call for it`, stack.model.count("persona") === 2, stack.model.count("persona"));
  await ctx.close();
  return { joe, ann, mira };
}

async function chats(browser, stack, { joe, mira }) {
  const tag = "390 chats";
  const { ctx, page } = await openPage(browser, stack, { width: 320, height: 640, dark: true });
  const sent = {};
  await page.route("**/api/sw/chats/", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    sent.roleplay = JSON.parse(route.request().postData());
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "rp1", title: "t" }) });
  });
  await page.route("**/api/sw/messenger/", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    sent.messenger = JSON.parse(route.request().postData());
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "m1" }) });
  });

  // Roleplay Chat's new-chat sheet, with Mira picked: Joe is pre-picked (remembered for Mira earlier).
  await page.evaluate((id) => window.PersonaPicker.remember([id], null), mira.id);
  await page.evaluate(([m, j]) => window.PersonaPicker.remember([m], j), [mira.id, joe.id]);
  await page.evaluate(() => document.getElementById("tab-roleplay")?.click());
  await page.evaluate((id) => window.roleplayChatHandler.openNewChatModal(id), mira.id);
  await page.waitForFunction(() => document.querySelectorAll("#chat-new-persona-picker .pp-tile").length > 3, null, { timeout: 10000 }).catch(() => {});
  await page.waitForFunction(() => window.roleplayChatHandler.personaPicker?.get().cardId, null, { timeout: 5000 }).catch(() => {});
  check(`${tag}: Roleplay new chat has the picker, with Mira's last persona picked`, (await page.evaluate(() => window.roleplayChatHandler.personaPicker.get().cardId)) === joe.id, JSON.stringify(await page.evaluate(() => window.roleplayChatHandler.personaPicker.get())));
  const sheetWide = await page.evaluate(() => { const r = document.getElementById("chat-new-persona-picker").getBoundingClientRect(); return { right: r.right, w: window.innerWidth, doc: document.documentElement.scrollWidth - window.innerWidth }; });
  check(`${tag}: the picker fits a 320 px screen`, sheetWide.right <= sheetWide.w + 1 && sheetWide.doc <= 0, JSON.stringify(sheetWide));
  await page.screenshot({ path: path.join(os.tmpdir(), "persona-roleplay-new.png") });
  await page.evaluate(() => window.roleplayChatHandler.createNewChat());
  await waitFor(() => sent.roleplay, 5000);
  check(`${tag}: creating the chat sends the persona card id`, sent.roleplay?.user_persona_card_id === joe.id && sent.roleplay?.user_persona_name === "Joe Persona", JSON.stringify(sent.roleplay));
  await page.evaluate(() => window.roleplayChatHandler.closeNewChatModal());

  // Messenger: New conversation with Mira.
  await page.evaluate((m) => window.messengerHandler.openNewWith({ id: m.id, name: m.name }), { id: mira.id, name: mira.name });
  await page.waitForFunction(() => document.querySelectorAll(".msg-sheet .pp-tile").length > 3, null, { timeout: 10000 }).catch(() => {});
  await page.waitForFunction(() => document.querySelector(".msg-sheet .pp-chosen")?.textContent.includes("Joe Persona"), null, { timeout: 5000 }).catch(() => {});
  check(`${tag}: Messenger's new conversation has the picker, Joe pre-picked`, /Joe Persona/.test(await page.textContent(".msg-sheet .pp-chosen").catch(() => "")));
  await page.click(".msg-sheet [data-start]");
  await waitFor(() => sent.messenger, 5000);
  check(`${tag}: starting it sends the persona card id`, sent.messenger?.user_persona_card_id === joe.id, JSON.stringify(sent.messenger));
  await ctx.close();
}

async function home(browser, stack, { joe }) {
  const tag = "390 Home";
  const { ctx, page } = await openPage(browser, stack);
  await page.waitForSelector('#home-chip-row [data-chip="personas"]', { timeout: 8000 }).catch(() => {});
  check(`${tag}: a 🎭 Personas chip`, await page.isVisible('#home-chip-row [data-chip="personas"]'));
  check(`${tag}: persona tiles carry a 🎭 badge`, await page.$$eval("#home-grid .hc-persona", (els) => els.length) >= 2);
  await page.click('#home-chip-row [data-chip="personas"]');
  const names = await page.$$eval("#home-grid .hc-tile .hc-name", (els) => els.map((e) => e.textContent));
  check(`${tag}: the chip shows only personas`, names.length >= 3 && names.every((n) => /Persona|Joe Marsh|Kim Typed|Rae Discard/.test(n)), names.join("|"));
  await page.click(`#home-grid .hc-tile[data-id="${joe.id}"]`);
  await page.waitForSelector("#home-card-sheet:not([hidden])");
  check(`${tag}: a persona's sheet says so, without "Make a persona"`, /🎭 Persona/.test(await page.textContent("#home-card-sheet .hcs-meta")) && await page.isHidden('#home-card-sheet [data-act="make-persona"]'));
  await page.click('#home-card-sheet [data-act="close"]');
  await ctx.close();
}

(async () => {
  const stack = await start({ repo, stageDir: path.join(os.tmpdir(), "cardgen-persona") });
  let browser;
  try {
    await proxyHalf(stack);
    const { webkit } = require(process.env.PLAYWRIGHT_CORE || "playwright-core");
    browser = await webkit.launch();
    await cardGen(browser, stack);
    const made = await picker(browser, stack);
    await chats(browser, stack, made);
    await home(browser, stack, made);
  } catch (error) {
    failed++;
    console.log("FAIL crashed: " + (error.stack || error));
  } finally {
    if (browser) await browser.close();
    await stack.stop();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
