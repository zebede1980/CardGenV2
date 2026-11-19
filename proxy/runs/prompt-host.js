"use strict";

/**
 * Runs the browser's own prompt code on the server.
 *
 * Every card prompt is built by files the page loads with <script> tags
 * (src/scripts/api-character.js and the ones listed below). A generation that
 * the proxy runs by itself needs exactly those prompts, and a second copy in
 * another language would drift. So the proxy loads the same files into a
 * sandbox (Node's `vm`: a fresh set of globals, like a page with no document)
 * and gives them a small host to stand on:
 *
 *   window.config      the user's settings, read-only for practical purposes
 *   class APIHandler   server bodies for makeRequest & co. (host-api.js)
 *   localStorage       the per-user name history, kept by the proxy
 *   fetch              only the web-search route character-search.js calls
 *
 * One sandbox per run: the files keep module-level state (name history,
 * the last search), and separate sandboxes keep users and runs apart.
 *
 * Anything in SHARED_SCRIPTS therefore runs in two places. A change there that
 * reaches for the page (document, a DOM element) breaks server runs;
 * tests/cardgen/prompt-host.test.js fails when that happens.
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

// Load order matters, as it does in index.html.
const SHARED_SCRIPTS = [
  "content-context.js",
  "name-bank-data.js",
  "name-bank.js",
  "api-character.js",
  "character-search.js",
  "character-generator.js",
];

function scriptsDir() {
  const candidates = [
    process.env.CARDGEN_SCRIPTS_DIR,
    path.join(__dirname, "..", "src", "scripts"),        // the Docker image: /app/src/scripts
    path.join(__dirname, "..", "..", "src", "scripts"),  // the repository
  ].filter(Boolean);
  const found = candidates.find((dir) => fs.existsSync(path.join(dir, SHARED_SCRIPTS[0])));
  if (!found) throw new Error(`Shared prompt scripts not found (looked in ${candidates.join(", ")})`);
  return found;
}

// Compiled once per file and reused for every sandbox; recompiled if the file changes.
const compiled = new Map();
function scriptFor(file) {
  const stat = fs.statSync(file);
  const cached = compiled.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.script;
  const script = new vm.Script(fs.readFileSync(file, "utf8"), { filename: path.basename(file) });
  compiled.set(file, { mtimeMs: stat.mtimeMs, script });
  return script;
}

function readPath(object, dotted) {
  return String(dotted).split(".").reduce((value, key) => (value == null ? undefined : value[key]), object);
}

/**
 * @param {object}   options.settings     the user's config object (as the page holds it)
 * @param {object}   options.deviceState  { key: string } the localStorage the prompt code sees
 * @param {function} options.callText     (body, { onContent, label }) -> { content, finishReason, reasoningChars, usage }
 * @param {function} [options.search]     (name, isFictional) -> results | null
 * @param {function} [options.warn]       (message) for things the page would show as a toast
 * @param {function} [options.random]     replaces Math.random (tests)
 * @param {boolean}  [options.strict]     throw on any page access instead of returning nothing (tests)
 */
function createPromptHost({ settings = {}, deviceState = {}, callText, search = null, warn = () => {}, random = null, strict = false } = {}) {
  if (typeof callText !== "function") throw new Error("createPromptHost needs callText");
  const storage = { ...deviceState };
  const pageAccess = [];

  const quietConsole = {
    log() {},
    info() {},
    debug() {},
    warn: (...args) => console.warn("[run]", ...args),
    error: (...args) => console.error("[run]", ...args),
  };

  const noPage = (what) => {
    pageAccess.push(what);
    if (strict) throw new Error(`Shared prompt code reached for the page: ${what}`);
    return null;
  };

  const sandbox = {
    console: quietConsole,
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL, URLSearchParams, TextEncoder, TextDecoder, AbortController,
    localStorage: {
      getItem: (key) => (Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null),
      setItem: (key, value) => { storage[key] = String(value); },
      removeItem: (key) => { delete storage[key]; },
    },
    document: {
      getElementById: (id) => noPage(`document.getElementById("${id}")`),
      querySelector: (selector) => noPage(`document.querySelector("${selector}")`),
      querySelectorAll: (selector) => { noPage(`document.querySelectorAll("${selector}")`); return []; },
    },
    // character-search.js calls the proxy's own search route with fetch().
    fetch: async (url, init = {}) => {
      if (String(url).endsWith("/api/search/character") && search) {
        const { name, isFictional } = JSON.parse(init.body || "{}");
        const results = await search(name, !!isFictional);
        return { ok: true, status: 200, json: async () => ({ success: true, results: results || null }) };
      }
      return { ok: false, status: 503, json: async () => ({ success: false }) };
    },
    __host: {
      warn,
      callText: (body, options) => callText(body, options || {}),
    },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.config = {
    config: settings,
    get: (dotted) => readPath(settings, dotted),
    set() {},
    log() {},
    getDebugMode: () => false,
  };
  sandbox.cardgenAuth = { getToken: () => "" };

  vm.createContext(sandbox);
  if (random) {
    sandbox.__host.random = random;
    vm.runInContext("Math.random = () => __host.random();", sandbox);
  }

  scriptFor(path.join(__dirname, "host-api.js")).runInContext(sandbox);
  const dir = scriptsDir();
  for (const name of SHARED_SCRIPTS) scriptFor(path.join(dir, name)).runInContext(sandbox);

  return {
    api: sandbox.apiHandler,
    characterGenerator: sandbox.characterGenerator,
    characterSearch: sandbox.characterSearch,
    /** The localStorage contents now, to be kept for the user's next run. */
    deviceState: () => ({ ...storage }),
    /** Everything the shared code asked the page for (should stay empty). */
    pageAccess: () => [...pageAccess],
  };
}

module.exports = { createPromptHost, SHARED_SCRIPTS, scriptsDir };
