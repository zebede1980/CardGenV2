"use strict";

/**
 * 🏷️ Tag untagged cards: the proxy works through a user's library cards that
 * have no tags, asks the text model for each card's tags and saves them. The
 * prompt is the page's own (generateTags in src/scripts/api-character.js, run
 * in the prompt host), so a card tagged here gets the same vocabulary as one
 * tagged from the editor's ✨ button.
 *
 *   GET  /api/card-tags/run        the caller's latest run, or { status: "idle" }
 *   POST /api/card-tags/run        start one (or answer with the one running)  { settings? }
 *   POST /api/card-tags/run/stop
 *
 * It needs nobody watching: a few hundred cards take a while, and the phone
 * will lock. Only untagged cards are picked, so a run that stopped, failed or
 * was cut off by a proxy restart is simply started again and carries on with
 * what is left; nothing is redone or paid for twice. Tagging leaves a card's
 * updated_at alone (PATCH /api/cards/:id/tags), so nothing sorted by last edit
 * moves. State is one small JSON file per user; API keys are never written.
 */

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { randomUUID } = require("crypto");
const { createPromptHost } = require("./prompt-host");

const LIMITS = {
  CONCURRENCY: Number(process.env.TAG_RUN_CONCURRENCY) || 3,
  // This many failures in a row means something is wrong for every card (the
  // key, the model, the provider): stop rather than pay for the rest.
  MAX_FAILS_IN_A_ROW: 5,
  ATTEMPTS: 2,
  RECENT: 8,
  FAILURES: 20,
};
const STATE_FILE = "tag-run.json";

function register(app, deps) {
  const { requireAuth, getUserDataDir, dataDir, callTextUpstream, loadUserConfig, backendRequest } = deps;

  /** userId -> run. `_live` holds the abort controller and is never written. */
  const runs = new Map();
  const stateFile = (userId) => path.join(getUserDataDir(userId), STATE_FILE);

  async function persist(run) {
    run.updatedAt = Date.now();
    const { _live, ...stored } = run; // eslint-disable-line no-unused-vars
    const file = stateFile(run.userId);
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(`${file}.tmp`, JSON.stringify(stored));
      await fsp.rename(`${file}.tmp`, file);
    } catch (error) {
      console.error(`[tags] could not save the run for user ${run.userId}:`, error.message);
    }
  }

  async function load(userId) {
    const key = String(userId);
    if (runs.has(key)) return runs.get(key);
    try {
      const run = JSON.parse(await fsp.readFile(stateFile(userId), "utf8"));
      if (run.status === "running") {
        // The proxy stopped mid-run. Starting again picks up the cards still untagged.
        run.status = "interrupted";
        run.error = "The server restarted while tagging. Start again to tag the rest.";
        await persist(run);
      }
      run._live = null;
      runs.set(key, run);
      return run;
    } catch (_) {
      return null;
    }
  }

  // Runs left "running" on disk by a restart are marked interrupted at start.
  try {
    const usersDir = path.join(dataDir, "users");
    for (const userId of fs.existsSync(usersDir) ? fs.readdirSync(usersDir) : []) {
      if (fs.existsSync(path.join(usersDir, userId, STATE_FILE))) load(userId);
    }
  } catch (error) {
    console.warn("[tags] could not read saved runs:", error.message);
  }

  const view = (run) => {
    if (!run) return { status: "idle" };
    const { _live, userId, ...shown } = run; // eslint-disable-line no-unused-vars
    return shown;
  };

  async function backendJson(userId, method, p, body) {
    const r = await backendRequest(userId, method, p, body);
    if (!r.ok) {
      const error = new Error(`Library ${method} ${p.split("?")[0]} returned ${r.status}`);
      error.status = r.status;
      error.backend = true;
      throw error;
    }
    return r.json();
  }

  function finish(run, status, error = null) {
    run.status = status;
    run.error = error;
    run.finishedAt = Date.now();
    run._live = null;
    console.log(`[tags] user ${run.userId}: ${status}, ${run.tagged} tagged, ${run.failed} failed, ${run.skipped} skipped of ${run.total}`);
    return persist(run);
  }

  async function tagOne(run, host, item) {
    const card = await backendJson(run.userId, "GET", `/api/cards/${encodeURIComponent(item.id)}`);
    // Tagged since the list was read (the editor, another device): leave it.
    if (String(card.tags || "").trim()) return { skipped: true };
    const character = {
      name: card.name || item.name || "",
      description: card.description || "",
      personality: card.personality || "",
      scenario: card.scenario || "",
      firstMessage: card.first_mes || "",
    };
    let lastError;
    for (let attempt = 1; attempt <= LIMITS.ATTEMPTS; attempt++) {
      if (run._live?.abort.signal.aborted) throw Object.assign(new Error("stopped"), { stopped: true });
      try {
        const tags = await host.api.generateTags(character);
        await backendJson(run.userId, "PATCH", `/api/cards/${encodeURIComponent(item.id)}/tags`, { tags });
        return { tags };
      } catch (error) {
        lastError = error;
        if (run._live?.abort.signal.aborted || error.name === "AbortError") throw Object.assign(new Error("stopped"), { stopped: true });
        if ([400, 401, 402, 403].includes(error.status)) break;
        if (attempt < LIMITS.ATTEMPTS) await new Promise((r) => setTimeout(r, 1500));
      }
    }
    throw lastError;
  }

  async function work(run, settings) {
    const live = run._live;
    const text = settings.api.text;
    const host = createPromptHost({
      settings: JSON.parse(JSON.stringify(settings)),
      callText: async (body, { onContent } = {}) => {
        const result = await callTextUpstream({ apiUrl: text.baseUrl, apiKey: text.apiKey, body, signal: live.abort.signal, onContent });
        if (result.usage?.total_tokens) run.tokens += result.usage.total_tokens;
        return result;
      },
    });

    let todo;
    try {
      const summaries = await backendJson(run.userId, "GET", "/api/cards/summary");
      todo = summaries.filter((s) => !(s.tags || []).length);
    } catch (error) {
      return finish(run, "failed", `Couldn't read your characters: ${error.message}`);
    }
    run.total = todo.length;
    await persist(run);

    let next = 0;
    let failsInARow = 0;
    let fatal = null;
    const worker = async () => {
      while (!fatal && !live.abort.signal.aborted && next < todo.length) {
        const item = todo[next++];
        run.current = item.name || "";
        try {
          const result = await tagOne(run, host, item);
          if (result.skipped) run.skipped++;
          else {
            run.tagged++;
            run.recent = [{ id: item.id, name: item.name, tags: result.tags }, ...run.recent].slice(0, LIMITS.RECENT);
          }
          failsInARow = 0;
        } catch (error) {
          if (error.stopped) return;
          if (error.backend && error.status === 404) { run.skipped++; continue; } // deleted meanwhile
          run.failed++;
          failsInARow++;
          const message = String(error.message || error).slice(0, 200);
          run.failures = [...run.failures, { id: item.id, name: item.name, error: message }].slice(-LIMITS.FAILURES);
          console.warn(`[tags] user ${run.userId}: card ${item.id} failed: ${message}`);
          if ([401, 402, 403].includes(error.status) && !error.backend) fatal = `The text API refused the request (${error.status}). Check the key in Settings.`;
          else if (failsInARow >= LIMITS.MAX_FAILS_IN_A_ROW) fatal = `Stopped after ${failsInARow} failures in a row. Last: ${message}`;
        } finally {
          run.done = run.tagged + run.failed + run.skipped;
          await persist(run);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(LIMITS.CONCURRENCY, todo.length || 1) }, worker));
    run.current = "";
    if (live.abort.signal.aborted) return finish(run, "stopped");
    if (fatal) return finish(run, "failed", fatal);
    return finish(run, "done");
  }

  const usable = (s) => !!(s?.api?.text?.apiKey && s.api.text.baseUrl && s.api.text.model);

  app.get("/api/card-tags/run", requireAuth, async (req, res) => {
    res.json(view(await load(req.user.userId)));
  });

  app.post("/api/card-tags/run", requireAuth, async (req, res) => {
    const userId = req.user.userId;
    const existing = await load(userId);
    // A double tap, or iOS re-sending the POST: the same run.
    if (existing?.status === "running") return res.json(view(existing));

    let settings = req.body?.settings;
    if (!usable(settings) && loadUserConfig) settings = await loadUserConfig(userId).catch(() => null);
    if (!usable(settings)) {
      return res.status(400).json({ error: { code: "400", message: "Text API settings are missing (base URL, key and model)" } });
    }
    const run = {
      id: randomUUID(),
      userId,
      status: "running",
      model: settings.api.text.model,
      total: 0, done: 0, tagged: 0, failed: 0, skipped: 0, tokens: 0,
      current: "",
      recent: [],
      failures: [],
      error: null,
      startedAt: Date.now(),
      finishedAt: null,
      _live: { abort: new AbortController() },
    };
    runs.set(String(userId), run);
    await persist(run);
    work(run, settings).catch((error) => {
      console.error(`[tags] user ${userId}: run crashed:`, error);
      return finish(run, "failed", String(error.message || error).slice(0, 300));
    });
    res.json(view(run));
  });

  app.post("/api/card-tags/run/stop", requireAuth, async (req, res) => {
    const run = await load(req.user.userId);
    if (run?.status === "running" && run._live) run._live.abort.abort();
    res.json(view(run));
  });

  return { runs, LIMITS };
}

module.exports = { register, LIMITS };
