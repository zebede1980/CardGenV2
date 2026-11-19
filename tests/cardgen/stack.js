// Test stack for Character Gen: the REAL proxy (a staged copy of proxy/server.js
// and whatever it requires), a fake Python backend, a fake OpenAI-style model,
// and a static server in front that plays nginx. Usage:
//   const stack = await require("./stack").start({ repo });
//   ... stack.url, stack.model, stack.backend, stack.token ...
//   await stack.stop();
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function copyDir(from, to) {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "data") continue;
    const a = path.join(from, entry.name), b = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(a, b);
    else fs.copyFileSync(a, b);
  }
}

// ── Canned model replies ────────────────────────────────────────────────────
const CARD_SINGLE = `# Mira Okafor's Profile

Mira Okafor is a lighthouse keeper on a spit of rock off the Cornish coast.

**Appearance:** Weathered hands, grey eyes, a yellow oilskin.

## Personality & Drives

{{char}} is patient and wary of strangers. Mira keeps the lamp lit whatever the weather.

# The Roleplay's Setup

A storm has cut the causeway. {{user}} arrives at the door of the lighthouse.

# First Message

The door opens a hand's width. "Road's gone," {{char}} says. "You'd better come in."`;

const CARD_SCENARIO = `# The Haunted Lighthouse

The Haunted Lighthouse is a derelict tower where the lamp still turns.

## The Setting

**Time & Place:** The coast, 1923. The fog comes in at dusk.

## Personality & Drives

The place is patient.

# The Roleplay's Setup

The storm has cut the road.

# First Message

The door swings open on its own.`;

const FINISHING = `<example_messages>
<START>
{{user}}: Is the lamp always lit?
{{char}}: "Always."
</example_messages>
<creator_notes>
A slow-burn coastal mystery.
</creator_notes>
<post_history>
Keep replies short and wary.
</post_history>`;

function replyKind(body) {
  const text = (body.messages || []).map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
  if (/<example_messages>|three tagged sections/.test(text)) return "finishing";
  if (/# \[Scenario Title\]/.test(text)) return "card-scenario";
  if (/The Roleplay's Setup/.test(text) && /Profile/.test(text) && /template/i.test(text)) return "card";
  if (/creator'?s notes/i.test(text) && !/Profile Template/.test(text)) return "notes";
  if (/post-history/i.test(text)) return "posthistory";
  if (/example dialogue/i.test(text)) return "examples";
  if (/image/i.test(text) && /prompt/i.test(text)) return "image-prompt";
  return "other";
}

const REPLIES = {
  card: CARD_SINGLE,
  "card-scenario": CARD_SCENARIO,
  finishing: FINISHING,
  notes: "Notes written on their own.",
  posthistory: "Post-history written on its own.",
  examples: "<START>\n{{char}}: \"Mind the step.\"",
  "image-prompt": "A weathered lighthouse keeper in a yellow oilskin, storm light, 35mm photograph.",
  other: "A plain reply.",
};

function startModel() {
  const control = {
    calls: [],            // { kind, stream, body, at }
    chunkDelayMs: 5,
    chunkSize: 40,
    replies: { ...REPLIES },
    // kind -> { afterChunks, release() } : the stream pauses there until released
    holds: {},
    failNext: {},         // kind -> status code to fail the next call with
    failAll: {},          // kind -> status code to fail every call with, until removed
    imageDataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  };
  control.hold = (kind, afterChunks = 2) => {
    let release;
    const gate = new Promise((r) => (release = r));
    control.holds[kind] = { afterChunks, gate, release, reached: false };
    return control.holds[kind];
  };
  control.count = (kind) => control.calls.filter((c) => c.kind === kind).length;

  const server = http.createServer(async (req, res) => {
    // The page asks the provider for its model list directly, so allow it.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
    if (req.method === "POST" && /images\/generations$/.test(req.url)) {
      const body = JSON.parse((await readBody(req)).toString() || "{}");
      control.calls.push({ kind: "image", stream: false, body, at: Date.now() });
      const status = control.failNext.image || control.failAll.image;
      delete control.failNext.image;
      res.writeHead(status || 200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(status ? { error: { message: `fake image failure ${status}` } } : { data: [{ url: control.imageDataUrl }] }));
    }
    if (req.method === "GET" && /\/api\/models$/.test(req.url)) {   // the size catalogue
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ models: { image: {} } }));
    }
    if (req.method !== "POST" || !/chat\/completions$/.test(req.url)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: "fake-model" }] }));
    }
    const body = JSON.parse((await readBody(req)).toString() || "{}");
    const kind = replyKind(body);
    control.calls.push({ kind, stream: !!body.stream, body, at: Date.now() });
    if (control.failNext[kind] || control.failAll[kind]) {
      const status = control.failNext[kind] || control.failAll[kind];
      delete control.failNext[kind];
      res.writeHead(status, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: `fake failure ${status}` } }));
    }
    const text = control.replies[kind] ?? control.replies.other;
    if (!body.stream) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { total_tokens: 10 } }));
    }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const chunks = text.match(new RegExp(`[\\s\\S]{1,${control.chunkSize}}`, "g")) || [""];
    let aborted = false;
    req.on("close", () => { aborted = true; });
    res.on("close", () => { aborted = true; });
    for (let i = 0; i < chunks.length; i++) {
      const hold = control.holds[kind];
      if (hold && i === hold.afterChunks) {
        hold.reached = true;
        await hold.gate;
        if (control.holds[kind] === hold) delete control.holds[kind];
      }
      if (aborted) return;
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: chunks[i] } }] })}\n\n`);
      await sleep(control.chunkDelayMs);
    }
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
  return listen(server).then((port) => ({ server, port, control }));
}

// ── Fake Python backend: just the generic stores the proxy talks to ─────────
function startBackend() {
  const state = {
    users: new Map(),   // userId -> { config, kinds: { history: Map, prompts: Map, ... } }
    requests: [],       // { method, path }
    pushes: [],
    failHistoryWrites: false,
    failHistoryReads: false,
  };
  const user = (id) => {
    if (!state.users.has(id)) state.users.set(id, { config: {}, kinds: {} });
    return state.users.get(id);
  };
  const kindMap = (u, kind) => (u.kinds[kind] ||= new Map());
  state.history = (userId) => [...kindMap(user(String(userId)), "history").values()];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const uid = String(req.headers["x-user-id"] || "0");
    const raw = await readBody(req);
    const body = raw.length ? JSON.parse(raw.toString()) : null;
    state.requests.push({ method: req.method, path: url.pathname });
    const send = (status, data) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };

    let m;
    if (url.pathname === "/api/proxy-data/config") {
      const u = user(uid);
      if (req.method === "POST") u.config = body.config_data || {};
      return send(200, { id: 1, config_data: u.config });
    }
    if ((m = url.pathname.match(/^\/api\/proxy-data\/([a-z-]+)(?:\/(.+))?$/))) {
      const [, kind, id] = m;
      const map = kindMap(user(uid), kind);
      if (kind === "history" && state.failHistoryReads && req.method === "GET") return send(500, { detail: "down" });
      if (kind === "history" && state.failHistoryWrites && req.method !== "GET") return send(500, { detail: "down" });
      if (req.method === "GET" && !id) return send(200, [...map.values()]);
      if (req.method === "GET") return map.has(id) ? send(200, map.get(id)) : send(404, { detail: "Item not found" });
      if (req.method === "POST") {
        const item = { id: String(body.id), data: body.data, updated_at: new Date().toISOString() };
        map.set(item.id, item);
        return send(200, item);
      }
      if (req.method === "DELETE") { map.delete(decodeURIComponent(id)); return send(200, { success: true }); }
    }
    if (url.pathname === "/api/push/internal/jobs-done") { state.pushes.push(body); return send(200, {}); }
    if (req.method === "GET") return send(200, []);
    return send(200, {});
  });
  return listen(server).then((port) => ({ server, port, state }));
}

// ── Static files + /api forwarding (what nginx does in production) ──────────
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml" };

function startFront(repo, proxyPort) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname.startsWith("/api/") || url.pathname === "/health") {
      const upstream = http.request({ host: "127.0.0.1", port: proxyPort, path: req.url, method: req.method, headers: req.headers }, (up) => {
        res.writeHead(up.statusCode, up.headers);
        up.pipe(res);
      });
      upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      res.on("close", () => upstream.destroy());
      return req.pipe(upstream);
    }
    let rel = decodeURIComponent(url.pathname);
    if (rel === "/") rel = "/index.html";
    if (rel === "/version.json") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end('{"build":"test"}'); }
    const file = path.join(repo, rel);
    if (!file.startsWith(repo) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    fs.createReadStream(file).pipe(res);
  });
  return listen(server).then((port) => ({ server, port }));
}

async function start({ repo, stageDir, quiet = true }) {
  const model = await startModel();
  const backend = await startBackend();

  // Stage the proxy exactly as its Dockerfile lays it out, plus shared code.
  fs.rmSync(stageDir, { recursive: true, force: true });
  // CARDGEN_TEST_LAYOUT=docker lays the files out as Dockerfile.proxy does
  // (server.js and src/scripts side by side under one folder), to catch a path
  // that only works in the repository's layout.
  const dockerLayout = process.env.CARDGEN_TEST_LAYOUT === "docker";
  const proxyDir = dockerLayout ? path.join(stageDir, "app") : path.join(stageDir, "proxy");
  const scriptsDir = dockerLayout ? path.join(stageDir, "app", "src", "scripts") : path.join(stageDir, "src", "scripts");
  copyDir(path.join(repo, "proxy"), proxyDir);
  // The prompt files the proxy shares with the page: only the ones its image copies.
  const { SHARED_SCRIPTS } = require(path.join(repo, "proxy", "runs", "prompt-host.js"));
  fs.mkdirSync(scriptsDir, { recursive: true });
  for (const name of SHARED_SCRIPTS) {
    fs.copyFileSync(path.join(repo, "src", "scripts", name), path.join(scriptsDir, name));
  }

  const proxyPort = await new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  // The front server comes up first: the proxy's CORS check needs its origin.
  const front = await startFront(repo, proxyPort);
  const url = `http://127.0.0.1:${front.port}`;
  const logs = [];
  const spawnProxy = () => {
    const child = spawn(process.execPath, [path.join(proxyDir, "server.js")], {
      env: {
        ...process.env,
        PORT: String(proxyPort),
        NODE_PATH: process.env.PROXY_NODE_MODULES || path.join(repo, "proxy", "node_modules"),
        STORY_APP_URL: `http://127.0.0.1:${backend.port}`,
        ALLOW_REGISTRATION: "true",
        JWT_SECRET: "test-secret",
        INTERNAL_API_SECRET: "test-internal",
        FRONTEND_URL: url,
        IMAGE_CATALOG_URL: `http://127.0.0.1:${model.port}/api/models`,
        COMFYUI_URL: "",
        COMFYUI_API_KEY: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const onData = (d) => { const t = d.toString(); logs.push(t); if (!quiet) process.stdout.write("[proxy] " + t); };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    return child;
  };
  const waitHealthy = async () => {
    for (let i = 0; i < 100; i++) {
      try {
        const ok = await new Promise((resolve) => {
          http.get({ host: "127.0.0.1", port: proxyPort, path: "/health" }, (r) => { r.resume(); resolve(r.statusCode === 200); }).on("error", () => resolve(false));
        });
        if (ok) return;
      } catch (_) { /* retry */ }
      await sleep(100);
    }
    throw new Error("proxy did not start:\n" + logs.join(""));
  };
  let proxy = spawnProxy();
  await waitHealthy();

  const api = async (method, p, body, token, headers = {}) => {
    const res = await fetch(url + p, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* not json */ }
    return { status: res.status, json, text };
  };

  const username = `tester${Date.now().toString(36)}`;
  const reg = await api("POST", "/api/auth/register", { username, password: "password123" });
  if (!reg.json?.token) throw new Error("register failed: " + reg.text);
  const token = reg.json.token;
  const me = await api("GET", "/api/auth/me", undefined, token);
  const userId = me.json.userId;

  const config = {
    api: {
      text: { baseUrl: `http://127.0.0.1:${model.port}/v1`, apiKey: "fake-key", model: "fake-model", timeout: 120000 },
      image: { baseUrl: "", apiKey: "", model: "" },
    },
    app: { enableImageGeneration: false, persistApiKeys: true, maxRetries: 2, retryDelay: 50 },
  };
  await api("POST", "/api/config", config, token);

  const register = async () => {
    const name = `tester${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const r = await api("POST", "/api/auth/register", { username: name, password: "password123" });
    const who = await api("GET", "/api/auth/me", undefined, r.json.token);
    return { token: r.json.token, userId: who.json.userId };
  };

  // Settings for a user who has a hosted image model set up.
  const imageSettings = (extra = {}) => ({ baseUrl: `http://127.0.0.1:${model.port}/v1`, apiKey: "fake-image-key", model: "fake-image", models: ["fake-image"], ...extra });

  return {
    imageSettings,
    url, token, userId, username, config, api, register, stageDir, dataDir: path.join(proxyDir, "data"),
    model: model.control,
    backend: backend.state,
    proxyLogs: logs,
    async restartProxy() {
      await new Promise((resolve) => { proxy.once("exit", resolve); proxy.kill(); });
      proxy = spawnProxy();
      await waitHealthy();
    },
    async stop() {
      proxy.kill();
      model.server.close(); backend.server.close(); front.server.close();
      model.server.closeAllConnections?.(); backend.server.closeAllConnections?.(); front.server.closeAllConnections?.();
    },
  };
}

module.exports = { start, sleep, replyKind, REPLIES };
