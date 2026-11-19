// Card runs through the real proxy, no browser:  see README.md for how to run.
// Covers the run engine (proxy/runs/card-runs.js): a whole card made by the
// proxy, idempotent start, stop, resume, a proxy restart mid-run, errors, limits.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { start, sleep } = require("./stack");

const repo = path.resolve(__dirname, "..", "..");
let failed = 0, passed = 0;
const check = (name, ok, detail = "") => {
  if (ok) { passed++; console.log("ok   " + name); }
  else { failed++; console.log("FAIL " + name + (detail ? "\n     " + String(detail).slice(0, 500) : "")); }
};
const until = async (fn, { timeout = 15000, step = 40, what = "condition" } = {}) => {
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
  const { api, token, userId, backend, model, config } = stack;
  const history = () => backend.history(userId);
  const spec = (extra = {}) => ({ mode: "classic", concept: "a lighthouse keeper", brief: "a lighthouse keeper", pov: "third", cardType: "single", exampleCount: 3, ...extra });
  const PAGE = { "X-Page-Id": "testpage1", "X-Page-View": "cardgen" };
  const begin = (body, t = token) => api("POST", "/api/card-runs", { settings: config, ...body }, t, PAGE);
  const get = (id, query = "", t = token) => api("GET", `/api/card-runs/${id}${query}`, undefined, t);
  const settled = (id, t = token) => until(async () => { const r = await get(id, "", t); return r.json?.status !== "running" ? r.json : null; }, { what: "run to settle" });
  const clearHistory = async () => { for (const h of history()) await api("DELETE", `/api/storage/cards/${h.id}`, undefined, token); await until(() => history().length === 0, { what: "history cleared" }); };

  // 1. A whole card, start to finish, with nobody watching.
  let r = await begin({ key: "k1", spec: spec() });
  check("a run starts", r.status === 200 && r.json.status === "running" && r.json.steps.length === 2, r.text);
  const id1 = r.json.id;
  let done = await settled(id1);
  check("the run finishes on its own", done.status === "done" && done.steps.every((s) => s.status === "done"), JSON.stringify(done.steps));
  check("the card is parsed", done.card?.name === "Mira Okafor" && done.card.cardType === "single" && done.card.description.includes("lighthouse keeper"), JSON.stringify(done.card)?.slice(0, 200));
  check("finishing fields are filled", done.card.mesExample.includes("Always") && done.card.creatorNotes.includes("slow-burn") && done.card.postHistoryInstructions.includes("short and wary"));
  check("the card is in History under the run's id", history().length === 1 && history()[0].id === done.historyId && history()[0].data.character.creatorNotes.includes("slow-burn"));
  check("the live text is the whole card", done.textLength > 300 && done.text.startsWith("# Mira Okafor's Profile"));
  r = await get(id1, "?from=100&log=0");
  check("progress can be read from an offset", r.json.text.length === done.textLength - 100 && r.json.log.some((l) => l.includes("example messages")), r.json.text.length);
  check("one card call, one finishing call, both streamed", model.count("card") === 1 && model.count("finishing") === 1 && model.calls.every((c) => c.stream));
  const cardCall = model.calls.find((c) => c.kind === "card");
  check("the content context leads the system prompt", cardCall.body.messages[0].role === "system" && cardCall.body.messages[0].content.startsWith("**CONTENT CONTEXT:**"));
  check("page-only fields are not sent upstream", !("resumable" in cardCall.body) && !("clientRef" in cardCall.body) && !("__jobLabel" in cardCall.body), Object.keys(cardCall.body).join(","));
  check("the token floor and top_p apply as on the browser route", cardCall.body.max_tokens >= 4096 && cardCall.body.top_p === 0.95, `${cardCall.body.max_tokens}/${cardCall.body.top_p}`);
  const stateFile = path.join(stack.dataDir, "users", String(userId), "cardgen-state.json");
  check("the name history is kept for the user", fs.existsSync(stateFile) && /Mira Okafor/.test(fs.readFileSync(stateFile, "utf8")));
  const runFile = path.join(stack.dataDir, "users", String(userId), "runs", `${id1}.json`);
  check("the run file holds no API key", fs.existsSync(runFile) && !fs.readFileSync(runFile, "utf8").includes("fake-key"));
  await until(() => backend.pushes.length === 1, { what: "done report" });
  check("one done report for the whole run, with a label that gives nothing away", backend.pushes[0].page === "testpage1" && backend.pushes[0].view === "cardgen" && backend.pushes[0].items.length === 1 && backend.pushes[0].items[0].ok === true && backend.pushes[0].items[0].label === "New character", JSON.stringify(backend.pushes));
  check("a run that was being polled is reported as attached", backend.pushes[0].attached === true);

  // 2. The same key is the same run.
  const calls = model.calls.length;
  r = await begin({ key: "k1", spec: spec({ concept: "something else" }) });
  check("the same key returns the same run and starts nothing", r.json.id === id1 && model.calls.length === calls);

  // 3. Bad requests.
  r = await begin({ key: "k-bad1", spec: spec({ concept: "" }) });
  check("no concept is refused", r.status === 400, r.status);
  r = await api("POST", "/api/card-runs", { key: "k-bad2", spec: spec(), settings: { api: { text: {} } } }, token);
  check("missing settings are refused", r.status === 400, r.status);
  r = await api("POST", "/api/card-runs", { key: "k-bad3", spec: spec(), settings: config });
  check("no session is a 401 from our own auth", r.status === 401);

  // 4. Another user cannot see or stop it.
  const other = await stack.register();
  r = await get(id1, "", other.token);
  check("another user gets 404 for the run", r.status === 404, r.status);
  r = await api("POST", `/api/card-runs/${id1}/stop`, {}, other.token);
  check("another user cannot stop it", r.status === 404);

  // 5. Stop during the finishing step: the card stays, the model call is cut.
  await clearHistory();
  let hold = model.hold("finishing", 1);
  r = await begin({ key: "k5", spec: spec() });
  const id5 = r.json.id;
  await until(() => hold.reached, { what: "finishing call" });
  await until(() => history().length === 1, { what: "draft saved" });
  r = await api("POST", `/api/card-runs/${id5}/stop`, {}, token);
  check("stop ends the run", r.json.status === "stopped", r.text);
  hold.release();
  await sleep(200);
  check("a stopped run keeps its card in History", history().length === 1 && history()[0].data.character.name === "Mira Okafor" && history()[0].data.draft === true);
  const pushesAfterStop = backend.pushes.length;
  check("a stopped run sends no done report", backend.pushes.length === 1, backend.pushes.length);

  // 6. Resume the stopped run: the card is not written again.
  let cardCalls = model.count("card"), finCalls = model.count("finishing");
  r = await api("POST", `/api/card-runs/${id5}/resume`, { settings: config }, token);
  check("resume restarts the run", r.json.status === "running", r.text);
  done = await settled(id5);
  check("the resumed run finishes", done.status === "done" && done.card.creatorNotes.includes("slow-burn"), JSON.stringify(done.steps));
  check("resume does not pay for the card again", model.count("card") === cardCalls && model.count("finishing") === finCalls + 1, `${model.count("card") - cardCalls}/${model.count("finishing") - finCalls}`);
  check("resume updates the same History item", history().length === 1 && history()[0].id === done.historyId && !!history()[0].data.character.creatorNotes);
  await until(() => backend.pushes.length === pushesAfterStop + 1, { what: "report after resume" });
  check("the finished resume is reported", true);

  // 7. The proxy restarts in the middle of the finishing step.
  await clearHistory();
  hold = model.hold("finishing", 1);
  r = await begin({ key: "k7", spec: spec() });
  const id7 = r.json.id;
  await until(() => hold.reached && history().length === 1, { what: "mid-run" });
  await stack.restartProxy();
  hold.release();
  r = await get(id7);
  check("after a restart the run is 'interrupted', with its card", r.json.status === "interrupted" && r.json.card?.name === "Mira Okafor" && r.json.steps[0].status === "done" && r.json.steps[1].status === "pending", JSON.stringify(r.json).slice(0, 300));
  cardCalls = model.count("card");
  r = await api("POST", `/api/card-runs/${id7}/resume`, {}, token);   // no settings sent: the saved config is used
  check("resume works from the saved settings", r.status === 200 && r.json.status === "running", r.text);
  done = await settled(id7);
  check("the interrupted run finishes without writing the card again", done.status === "done" && model.count("card") === cardCalls && !!done.card.mesExample);
  r = await get(id1);
  check("earlier runs are still readable after a restart", r.status === 200 && r.json.status === "done" && r.json.card.name === "Mira Okafor");

  // 8. The provider fails.
  await clearHistory();
  model.failNext.card = 500;
  cardCalls = model.count("card");
  r = await begin({ key: "k8a", spec: spec() });
  done = await settled(r.json.id);
  check("one failed attempt is retried and the run still finishes", done.status === "done" && model.count("card") === cardCalls + 2, `${done.status} ${model.count("card") - cardCalls}`);
  model.failAll.card = 401;
  cardCalls = model.count("card");
  r = await begin({ key: "k8b", spec: spec() });
  done = await settled(r.json.id);
  delete model.failAll.card;
  // The proxy itself retries a 401 once with the other auth header; the run does not retry after that.
  check("a rejected key fails the run with a message, and is not retried by the run", done.status === "error" && /API Error: 401/.test(done.error) && model.count("card") === cardCalls + 2, `${done.status} ${done.error} ${model.count("card") - cardCalls}`);
  r = await get(done.id);
  check("a provider 401 never reaches the browser as a 401", r.status === 200);
  await until(() => backend.pushes.some((p) => p.items[0].ok === false), { what: "failure report" });
  check("a failed run is reported as failed", backend.pushes.some((p) => p.items[0].ok === false && /401/.test(p.items[0].error)));

  // 9. Card types and the reference image.
  await clearHistory();
  r = await begin({ key: "k9", spec: spec({ cardType: "scenario", concept: "a haunted lighthouse", referenceImage: PNG }) });
  done = await settled(r.json.id);
  check("a scenario card keeps its title and gets its tag", done.status === "done" && done.card.name === "The Haunted Lighthouse" && done.card.tags.includes("scenario") && done.card.description.startsWith("# The Haunted Lighthouse\n"), JSON.stringify(done.card).slice(0, 200));
  r = await api("GET", `/api/storage/cards/${done.historyId}`, undefined, token);
  check("the reference image is stored as the portrait", String(r.json?.imageBase64 || "").startsWith("data:image/png"));
  const file9 = path.join(stack.dataDir, "users", String(userId), "runs", `${done.id}.json`);
  check("the reference image is not kept in the run file", !fs.readFileSync(file9, "utf8").includes("iVBORw0KGgo"));

  // 10. Search mode with no search key configured falls back to a normal card.
  r = await begin({ key: "k10", spec: spec({ mode: "search", concept: "", searchQuery: "Ellen Ripley from Alien", searchScenario: "aboard the Nostromo" }) });
  done = await settled(r.json.id);
  check("search mode without a search key still makes a card", done.status === "done" && !!done.card?.name, `${done.status} ${done.error}`);

  // 11. Limits.
  const holdA = model.hold("card", 1);
  const a = await begin({ key: "k11a", spec: spec() });
  await until(() => holdA.reached, { what: "first held" });
  const b = await begin({ key: "k11b", spec: spec() });
  const c = await begin({ key: "k11c", spec: spec() });
  check("a third run at once is refused", a.status === 200 && b.status === 200 && c.status === 429, `${a.status}/${b.status}/${c.status}`);
  r = await api("GET", "/api/card-runs/active-count", undefined, token);
  check("active-count sees the running runs", r.json.running === 2, r.text);
  r = await api("GET", "/api/card-runs?active=1", undefined, token);
  check("the active list names them", r.json.runs.length === 2 && r.json.runs.every((x) => x.status === "running"));
  holdA.release();
  await settled(a.json.id);
  await settled(b.json.id);
  r = await api("GET", "/api/card-runs/not-a-run", undefined, token);
  check("an unknown run id is a 404", r.status === 404);

  // 13. The portrait, drawn by the run.
  await clearHistory();
  const withImages = (image = {}, app = {}) => ({ ...config, api: { ...config.api, image: stack.imageSettings(image) }, app: { ...config.app, enableImageGeneration: true, ...app } });
  const wantPortrait = { want: true, resetStyle: true, referenceDescription: "", guidance: "" };
  let imageCalls = model.count("image"), promptCalls = model.count("image-prompt");
  r = await begin({ key: "k13a", spec: spec({ portrait: wantPortrait }), settings: withImages() });
  check("a run asked for a portrait has three steps", r.json.steps.map((s) => s.name).join(",") === "card,finishing,portrait" && r.json.portrait === "pending", JSON.stringify(r.json.steps));
  done = await settled(r.json.id);
  check("portrait: the run draws it and finishes", done.status === "done" && done.portrait === "done" && done.steps.every((s) => s.status === "done"), `${done.status} ${done.portrait} ${done.portraitError} ${JSON.stringify(done.log)}`);
  check("portrait: one prompt-writing call and one image call", model.count("image") === imageCalls + 1 && model.count("image-prompt") === promptCalls + 1, `${model.count("image") - imageCalls}/${model.count("image-prompt") - promptCalls}`);
  const imageCall = model.calls.filter((c) => c.kind === "image").pop();
  check("portrait: the image request names the model and carries the written prompt", imageCall.body.model === "fake-image" && /lighthouse keeper/.test(imageCall.body.prompt) && !("resumable" in imageCall.body) && !("__jobLabel" in imageCall.body), JSON.stringify(imageCall.body).slice(0, 300));
  r = await api("GET", `/api/storage/cards/${done.historyId}`, undefined, token);
  check("portrait: stored with the card in History, with the prompt used", String(r.json?.imageBase64 || "").startsWith("data:image/png") && /lighthouse keeper/.test(r.json.character.imagePrompt || ""), r.json?.character?.imagePrompt);
  check("portrait: the progress messages say so", done.log.some((l) => l.includes("Generating character image")) && done.log.some((l) => l.includes("Image generation complete")));

  // 14. The image API fails: the card is still whole and the run still ends well.
  await clearHistory();
  model.failAll.image = 500;
  r = await begin({ key: "k14", spec: spec({ portrait: wantPortrait }), settings: withImages() });
  done = await settled(r.json.id);
  delete model.failAll.image;
  check("failed portrait: the run is still done, and says what went wrong", done.status === "done" && done.portrait === "failed" && /Image API Error \(500\)/.test(done.portraitError) && done.log.some((l) => l.includes("Image generation failed")), `${done.status} ${done.portrait} ${done.portraitError}`);
  check("failed portrait: the card and its fields are in History", history().length === 1 && !!history()[0].data.character.creatorNotes);

  // 15. A local model first in the list, the PC off: the hosted fallback draws it, with the same prompt.
  await clearHistory();
  imageCalls = model.count("image"); promptCalls = model.count("image-prompt");
  r = await begin({ key: "k15", spec: spec({ portrait: wantPortrait }), settings: withImages({ models: ["local/z-image-turbo", "fake-image"], model: "local/z-image-turbo", localFallbackModel: "fake-image" }) });
  done = await settled(r.json.id);
  check("local GPU off: the hosted fallback draws the portrait", done.status === "done" && done.portrait === "done" && done.log.some((l) => l.includes("Local GPU unavailable")), `${done.portrait} ${done.portraitError} ${JSON.stringify(done.log)}`);
  check("local GPU off: the prompt is written once and reused", model.count("image") === imageCalls + 1 && model.count("image-prompt") === promptCalls + 1, `${model.count("image") - imageCalls}/${model.count("image-prompt") - promptCalls}`);
  check("local GPU off: the fallback request is for the fallback model", model.calls.filter((c) => c.kind === "image").pop().body.model === "fake-image");
  await clearHistory();
  r = await begin({ key: "k15b", spec: spec({ portrait: wantPortrait }), settings: withImages({ models: ["local/z-image-turbo", "fake-image"], model: "local/z-image-turbo", localFallbackModel: "" }) });
  done = await settled(r.json.id);
  check("local GPU off and no fallback set: the portrait fails with the GPU message", done.status === "done" && done.portrait === "failed" && /local GPU/i.test(done.portraitError), done.portraitError);

  // 16. No portrait when none was asked for, or when a reference image is the portrait.
  r = await begin({ key: "k16a", spec: spec(), settings: withImages() });
  check("no portrait step unless asked for", r.json.steps.length === 2 && r.json.portrait === null);
  await settled(r.json.id);
  imageCalls = model.count("image");
  r = await begin({ key: "k16b", spec: spec({ portrait: wantPortrait, referenceImage: PNG }), settings: withImages() });
  done = await settled(r.json.id);
  check("a reference image is the portrait: none is drawn", done.steps.length === 2 && done.portrait === null && model.count("image") === imageCalls);

  // 17. Supporting cast, as a step of the run.
  await clearHistory();
  let listCalls = model.count("cast-list"), memberCalls = model.count("cast-member"), editCalls = model.count("card-edit");
  r = await begin({ key: "k17", spec: spec({ cast: { want: true } }) });
  check("a run asked for a cast has the step, between finishing and portrait", r.json.steps.map((s) => s.name).join(",") === "card,finishing,cast" && r.json.cast === "pending", JSON.stringify(r.json.steps));
  done = await settled(r.json.id);
  check("cast: the run finishes with the step done", done.status === "done" && done.cast === "done" && done.steps.every((s) => s.status === "done"), `${done.status} ${done.cast} ${JSON.stringify(done.log)}`);
  check("cast: one list call, one call per member, one card edit", model.count("cast-list") === listCalls + 1 && model.count("cast-member") === memberCalls + 2 && model.count("card-edit") === editCalls + 1, `${model.count("cast-list") - listCalls}/${model.count("cast-member") - memberCalls}/${model.count("card-edit") - editCalls}`);
  const book = done.card.character_book;
  check("cast: the card has a lorebook entry per member, keyed on name and role", book?.entries?.length === 2 && book.entries[0].keys.join("|") === "Tamsin Hale|Harbour Master" && book.entries[1].comment === "Jory Penrose (Apprentice)" && book.entries.every((e) => e.enabled === true), JSON.stringify(book)?.slice(0, 300));
  check("cast: the card now names them", /Tamsin Hale/.test(done.card.scenario) && /Jory Penrose/.test(done.card.scenario));
  check("cast: the finishing fields survive the card edit", !!done.card.mesExample && !!done.card.creatorNotes && done.card.cardType === "single");
  check("cast: saved to History with the book", history().length === 1 && history()[0].data.character.character_book?.entries?.length === 2 && /Tamsin Hale/.test(history()[0].data.character.scenario));
  check("cast: the progress lines are in the run's log", done.log.some((l) => l.includes("Auto-generating supporting cast")) && done.log.filter((l) => l.startsWith("Generating cast member:")).length === 2 && done.log.some((l) => l.includes("Supporting cast generated")));

  // 18. The cast step fails outright: the run still finishes with the card.
  await clearHistory();
  model.failAll["cast-list"] = 500;
  r = await begin({ key: "k18", spec: spec({ cast: { want: true } }) });
  done = await settled(r.json.id);
  delete model.failAll["cast-list"];
  check("failed cast: the run is still done and says so", done.status === "done" && done.cast === "failed" && done.log.some((l) => l.includes("Supporting cast generation failed")) && !!done.card.creatorNotes, `${done.status} ${done.cast}`);

  // 12. The proxy image must copy every prompt file the host loads.
  const { SHARED_SCRIPTS } = require(path.join(repo, "proxy", "runs", "prompt-host.js"));
  const dockerfile = fs.readFileSync(path.join(repo, "Dockerfile.proxy"), "utf8");
  const missing = SHARED_SCRIPTS.filter((name) => !dockerfile.includes(`src/scripts/${name}`));
  check("Dockerfile.proxy copies every shared prompt file", missing.length === 0 && dockerfile.includes("COPY proxy/runs/"), missing.join(", "));

  await stack.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
