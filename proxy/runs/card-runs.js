"use strict";

/**
 * Card runs: a new character made start to finish by the proxy.
 *
 * The page used to conduct this itself, one request per step, so the chain
 * stopped when the phone locked and was lost when Safari discarded the tab
 * (plans/character-gen-backend-driven.md). A run is the same chain with the
 * proxy conducting: the page posts what was asked for, polls for progress, and
 * can go away and come back, on any device.
 *
 *   POST /api/card-runs              { key, spec, settings }  -> the run
 *   GET  /api/card-runs              the caller's recent runs (?active=1: running only)
 *   GET  /api/card-runs/active-count how many runs are running, for anyone (deploy check)
 *   GET  /api/card-runs/:id          ?from=<chars>&log=<lines>  progress since then
 *   POST /api/card-runs/:id/stop
 *   POST /api/card-runs/:id/resume   { settings }  an interrupted, failed or stopped run
 *
 * State is one JSON file per run under the user's data folder, written after
 * every step. A proxy restart leaves a running run "interrupted"; Resume
 * carries on from the first step that hadn't finished. API keys are never
 * written to that file: the settings live in memory for the life of the run.
 */

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { randomUUID } = require("crypto");
const { createPromptHost } = require("./prompt-host");

const STOPPED = "Generation stopped by user";
const STEPS = ["card", "finishing"];
const LIMITS = {
  MAX_RUNNING_PER_USER: 2,
  KEEP_MS: 24 * 60 * 60 * 1000,
  MAX_TEXT_CHARS: 1024 * 1024,
  // A page that polled this recently is "reading": no push when the run ends.
  ATTACHED_MS: 10 * 1000,
  TEXT_ATTEMPTS: 2,
};
const DEVICE_STATE_FILE = "cardgen-state.json";
const DEVICE_STATE_KEYS = /^cardgenv2_recent_/;
const RUN_ID_RE = /^[a-f0-9-]{36}$/;

function register(app, deps) {
  const { requireAuth, dataDir, getUserDataDir, callTextUpstream, saveHistoryCard, searchCharacter, reportDone, loadUserConfig } = deps;

  /** id -> run. Fields starting "_" are live handles and are never written to disk. */
  const runs = new Map();

  // ── Persistence ────────────────────────────────────────────────────────────
  const runsDir = (userId) => path.join(getUserDataDir(userId), "runs");
  const runFile = (run) => path.join(runsDir(run.userId), `${run.id}.json`);

  async function persist(run) {
    run.updatedAt = Date.now();
    const { _live, ...stored } = run; // eslint-disable-line no-unused-vars
    const file = runFile(run);
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      // Write-then-rename: a crash mid-write leaves the old file, never half a one.
      await fsp.writeFile(`${file}.tmp`, JSON.stringify(stored));
      await fsp.rename(`${file}.tmp`, file);
    } catch (error) {
      console.error(`[runs] could not save run ${run.id}:`, error.message);
    }
  }

  /** On start: runs that were running when the proxy stopped are "interrupted". */
  function loadFromDisk() {
    const usersDir = path.join(dataDir, "users");
    if (!fs.existsSync(usersDir)) return;
    const now = Date.now();
    for (const userId of fs.readdirSync(usersDir)) {
      const dir = path.join(usersDir, userId, "runs");
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        const file = path.join(dir, name);
        try {
          if (!name.endsWith(".json")) { fs.unlinkSync(file); continue; }
          const run = JSON.parse(fs.readFileSync(file, "utf8"));
          if (now - (run.updatedAt || 0) > LIMITS.KEEP_MS) { fs.unlinkSync(file); continue; }
          if (run.status === "running") {
            run.status = "interrupted";
            run.error = "The server restarted while this was being made.";
            for (const step of run.steps) if (step.status === "running") step.status = "pending";
            fs.writeFileSync(file, JSON.stringify(run));
          }
          run._live = null;
          runs.set(run.id, run);
        } catch (error) {
          console.warn(`[runs] ignoring unreadable run file ${file}:`, error.message);
        }
      }
    }
    if (runs.size) console.log(`[runs] ${runs.size} recent run(s) loaded`);
  }

  function sweep() {
    const now = Date.now();
    for (const run of runs.values()) {
      if (run.status === "running" || now - run.updatedAt <= LIMITS.KEEP_MS) continue;
      runs.delete(run.id);
      fsp.unlink(runFile(run)).catch(() => {});
    }
  }

  // ── Per-user name history (what localStorage holds for the page) ───────────
  async function readDeviceState(userId) {
    try {
      return JSON.parse(await fsp.readFile(path.join(getUserDataDir(userId), DEVICE_STATE_FILE), "utf8"));
    } catch (_) {
      return {};
    }
  }

  async function writeDeviceState(userId, state) {
    const kept = Object.fromEntries(Object.entries(state).filter(([key]) => DEVICE_STATE_KEYS.test(key)));
    try {
      await fsp.writeFile(path.join(getUserDataDir(userId), DEVICE_STATE_FILE), JSON.stringify(kept));
    } catch (error) {
      console.warn("[runs] could not save the name history:", error.message);
    }
  }

  // ── Running a run ──────────────────────────────────────────────────────────
  const stepOf = (run, name) => run.steps.find((s) => s.name === name);
  const say = (run, text) => { run.log.push(text); };

  /** One text call for a run: retried once if it fails before any text arrives. */
  async function callText(run, body, { onContent } = {}) {
    const live = run._live;
    const text = live.settings?.api?.text || {};
    let lastError;
    for (let attempt = 1; attempt <= LIMITS.TEXT_ATTEMPTS; attempt++) {
      if (live.abort.signal.aborted) throw new Error(STOPPED);
      let received = false;
      try {
        const result = await callTextUpstream({
          apiUrl: text.baseUrl,
          apiKey: text.apiKey,
          body,
          signal: live.abort.signal,
          onContent: (delta) => { received = true; if (onContent) onContent(delta); },
        });
        if (result.usage) run.usage.push(result.usage);
        return result;
      } catch (error) {
        if (live.abort.signal.aborted || error.name === "AbortError") throw new Error(STOPPED);
        lastError = error;
        // Never replay a reply the caller has already been shown part of, and
        // don't hammer a key or a request the provider has refused.
        if (received || [400, 401, 403].includes(error.status)) break;
        if (attempt < LIMITS.TEXT_ATTEMPTS) await new Promise((r) => setTimeout(r, 1500));
      }
    }
    throw lastError;
  }

  async function runStep(run, name, work) {
    const step = stepOf(run, name);
    if (step.status === "done") return;
    step.status = "running";
    step.startedAt = Date.now();
    step.error = null;
    run.step = name;
    await persist(run);
    try {
      await work();
      step.status = "done";
    } catch (error) {
      step.status = "error";
      step.error = error.message;
      throw error;
    } finally {
      step.finishedAt = Date.now();
    }
    await persist(run);
  }

  async function execute(run) {
    const { spec, userId } = run;
    try {
      const host = createPromptHost({
        settings: run._live.settings,
        deviceState: await readDeviceState(userId),
        callText: (body, options) => callText(run, body, options),
        search: searchCharacter,
        warn: (message) => say(run, `⚠️ ${message}\n`),
      });

      await runStep(run, "card", async () => {
        run.text = "";
        const onStream = (delta, full) => {
          if (full.length <= LIMITS.MAX_TEXT_CHARS) run.text = full;
        };
        const character = spec.mode === "search"
          ? await host.characterSearch.generateCharacter(spec.searchQuery, spec.searchScenario, spec.characterName, onStream, spec.pov, spec.lorebook, spec.cardType)
          : await host.characterGenerator.generateCharacter(spec.concept, spec.characterName, onStream, spec.pov, spec.lorebook, spec.cardType);

        // Out of the sandbox as plain data.
        const card = JSON.parse(JSON.stringify(character));
        card.cardType = spec.cardType;
        if (spec.cardType === "group" || spec.cardType === "scenario") {
          card.tags = Array.isArray(card.tags) ? card.tags : [];
          if (!card.tags.includes(spec.cardType)) card.tags.push(spec.cardType);
        }
        run.card = card;
        await writeDeviceState(userId, host.deviceState());

        // Into History at once: whatever happens to the later steps, the card is kept.
        run.historyId = await saveHistoryCard(userId, {
          isPermanent: false,
          draft: true,
          replaceHistoryId: run.historyId || undefined,
          characterName: card.name,
          character: card,
          imageBase64: spec.referenceImage || "",
        });
        delete spec.referenceImage; // stored with the card now; no need to carry megabytes around
      });

      await runStep(run, "finishing", async () => {
        say(run, "\n\n💬 Generating example messages, creator's notes and post-history instructions...\n");
        await host.api.fillFinishingFields(run.card, {
          count: spec.exampleCount,
          pov: spec.pov,
          brief: spec.brief,
          exampleStyle: spec.exampleStyle,
          lorebookEntries: [],
        });
        // Still a draft: the portrait is the page's step for now.
        await saveHistoryCard(userId, {
          isPermanent: false,
          draft: true,
          replaceHistoryId: run.historyId,
          characterName: run.card.name,
          character: run.card,
        });
      });

      await finish(run, "done");
    } catch (error) {
      if (error.message === STOPPED || run._live?.abort.signal.aborted) await finish(run, "stopped");
      else await finish(run, "error", error.message);
    }
  }

  async function finish(run, status, error = null) {
    run.status = status;
    run.error = error;
    run.finishedAt = Date.now();
    for (const step of run.steps) if (step.status === "running") step.status = status === "done" ? "done" : "pending";
    const live = run._live;
    run._live = null;
    await persist(run);
    console.log(`[runs] run ${run.id} ${status}${error ? `: ${error}` : ""} (${Math.round((run.finishedAt - run.startedAt) / 1000)}s)`);

    // One push for the whole run, and only if nobody is watching it.
    if (status === "stopped" || !reportDone || !run.page) return;
    const attached = !!live && Date.now() - (live.lastPollAt || 0) < LIMITS.ATTACHED_MS;
    reportDone(run.userId, {
      page: run.page,
      view: "cardgen",
      attached,
      items: [{ label: run.card?.name ? `${run.card.name} (character)` : "Character", ok: status === "done", error: String(error || "").slice(0, 300) }],
    }).catch((err) => console.warn("[runs] done report failed:", err.message));
  }

  function start(run, settings) {
    run.status = "running";
    run.error = null;
    run.finishedAt = null;
    run.startedAt = run.startedAt || Date.now();
    run._live = { settings, abort: new AbortController(), lastPollAt: Date.now() };
    execute(run).catch((error) => console.error(`[runs] run ${run.id} crashed:`, error));
  }

  // ── What the page is told ──────────────────────────────────────────────────
  function view(run, { from = 0, logFrom = 0, withCard = false } = {}) {
    const out = {
      id: run.id,
      kind: run.kind,
      status: run.status,
      step: run.step,
      steps: run.steps.map(({ name, status, error }) => ({ name, status, error: error || null })),
      error: run.error,
      name: run.card?.name || "",
      cardType: run.spec.cardType,
      pov: run.spec.pov,
      historyId: run.historyId || null,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      textLength: run.text.length,
      text: run.text.slice(Math.max(0, from)),
      logLength: run.log.length,
      log: run.log.slice(Math.max(0, logFrom)),
    };
    if (withCard || run.status !== "running") out.card = run.card || null;
    return out;
  }

  function ownRun(req, res) {
    const run = RUN_ID_RE.test(req.params.id) ? runs.get(req.params.id) : null;
    if (!run || run.userId !== req.user.userId) {
      res.status(404).json({ error: { code: "404", message: "Run not found" } });
      return null;
    }
    return run;
  }

  const cleanText = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");

  function cleanSpec(raw) {
    const spec = raw && typeof raw === "object" ? raw : {};
    const mode = spec.mode === "search" ? "search" : "classic";
    const referenceImage = typeof spec.referenceImage === "string" && spec.referenceImage.startsWith("data:image/") ? spec.referenceImage : "";
    return {
      mode,
      concept: cleanText(spec.concept, 60000),
      brief: cleanText(spec.brief, 60000),
      searchQuery: cleanText(spec.searchQuery, 500),
      searchScenario: cleanText(spec.searchScenario, 20000),
      characterName: cleanText(spec.characterName, 200),
      pov: spec.pov === "first" ? "first" : "third",
      cardType: ["group", "scenario"].includes(spec.cardType) ? spec.cardType : "single",
      lorebook: spec.lorebook && typeof spec.lorebook === "object" ? spec.lorebook : null,
      exampleCount: Math.min(10, Math.max(1, parseInt(spec.exampleCount, 10) || 3)),
      exampleStyle: cleanText(spec.exampleStyle, 4000),
      referenceImage,
      hasReferenceImage: !!referenceImage,
    };
  }

  const usableSettings = (settings) => !!(settings?.api?.text?.apiKey && settings.api.text.baseUrl && settings.api.text.model);

  // ── Routes ─────────────────────────────────────────────────────────────────
  app.post("/api/card-runs", requireAuth, async (req, res) => {
    const userId = req.user.userId;
    const key = cleanText(req.body?.key, 100);
    // The same key again (a double tap, or iOS re-sending the POST) is the same run.
    if (key) {
      const existing = [...runs.values()].find((r) => r.userId === userId && r.key === key);
      if (existing) return res.json(view(existing, { withCard: true }));
    }

    const spec = cleanSpec(req.body?.spec);
    if (spec.mode === "classic" && !spec.concept) {
      return res.status(400).json({ error: { code: "400", message: "A concept is required" } });
    }
    if (spec.mode === "search" && !spec.searchQuery) {
      return res.status(400).json({ error: { code: "400", message: "A character to search for is required" } });
    }
    const settings = req.body?.settings;
    if (!usableSettings(settings)) {
      return res.status(400).json({ error: { code: "400", message: "Text API settings are missing (base URL, key and model)" } });
    }
    const running = [...runs.values()].filter((r) => r.userId === userId && r.status === "running").length;
    if (running >= LIMITS.MAX_RUNNING_PER_USER) {
      return res.status(429).json({ error: { code: "429", message: `Already making ${running} characters. Wait for one to finish.` } });
    }

    const page = String(req.headers["x-page-id"] || "");
    const run = {
      id: randomUUID(),
      key,
      userId,
      kind: "new-card",
      status: "running",
      step: STEPS[0],
      steps: STEPS.map((name) => ({ name, status: "pending", error: null })),
      spec,
      page: /^[A-Za-z0-9_-]{1,64}$/.test(page) ? page : "",
      text: "",
      log: [],
      usage: [],
      card: null,
      historyId: null,
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: Date.now(),
      finishedAt: null,
      _live: null,
    };
    runs.set(run.id, run);
    start(run, settings);
    console.log(`[runs] run ${run.id} started for user ${userId} (${spec.mode}, ${spec.cardType})`);
    res.json(view(run));
  });

  app.get("/api/card-runs/active-count", requireAuth, (req, res) => {
    res.json({ running: [...runs.values()].filter((r) => r.status === "running").length });
  });

  app.get("/api/card-runs", requireAuth, (req, res) => {
    const activeOnly = req.query.active === "1";
    const list = [...runs.values()]
      .filter((r) => r.userId === req.user.userId && (!activeOnly || r.status === "running"))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 20)
      .map((r) => ({ id: r.id, status: r.status, step: r.step, name: r.card?.name || "", historyId: r.historyId || null, createdAt: r.createdAt, updatedAt: r.updatedAt, error: r.error }));
    res.json({ runs: list });
  });

  app.get("/api/card-runs/:id", requireAuth, (req, res) => {
    const run = ownRun(req, res);
    if (!run) return;
    if (run._live) run._live.lastPollAt = Date.now();
    res.json(view(run, {
      from: parseInt(req.query.from, 10) || 0,
      logFrom: parseInt(req.query.log, 10) || 0,
      withCard: req.query.card === "1",
    }));
  });

  app.post("/api/card-runs/:id/stop", requireAuth, async (req, res) => {
    const run = ownRun(req, res);
    if (!run) return;
    if (run.status === "running" && run._live) {
      run._live.abort.abort();
      // execute() notices and finishes the run; give it a moment so the reply is the final state.
      for (let i = 0; i < 50 && run.status === "running"; i++) await new Promise((r) => setTimeout(r, 20));
    }
    res.json(view(run, { withCard: true }));
  });

  app.post("/api/card-runs/:id/resume", requireAuth, async (req, res) => {
    const run = ownRun(req, res);
    if (!run) return;
    if (run.status === "running") return res.json(view(run));
    if (run.status === "done") return res.json(view(run, { withCard: true }));
    let settings = req.body?.settings;
    if (!usableSettings(settings) && loadUserConfig) settings = await loadUserConfig(run.userId).catch(() => null);
    if (!usableSettings(settings)) {
      return res.status(400).json({ error: { code: "400", message: "Text API settings are missing (base URL, key and model)" } });
    }
    const page = String(req.headers["x-page-id"] || "");
    if (/^[A-Za-z0-9_-]{1,64}$/.test(page)) run.page = page;
    for (const step of run.steps) if (step.status !== "done") step.status = "pending";
    say(run, "\n▶️ Carrying on from where it stopped...\n");
    start(run, settings);
    res.json(view(run));
  });

  loadFromDisk();
  setInterval(sweep, 10 * 60 * 1000).unref();

  return { runs, LIMITS };
}

module.exports = { register, STOPPED };
