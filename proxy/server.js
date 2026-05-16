const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
require("dotenv").config({ path: "../.env" });

const fs = require("fs");
const fsPromises = require("fs").promises;
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

// ── Auth configuration ────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || "cardgen-default-secret-change-me";
const JWT_EXPIRES_IN = "30d";
const BCRYPT_ROUNDS = 12;

if (!process.env.JWT_SECRET) {
  console.warn("⚠️  JWT_SECRET not set — using insecure default. Set JWT_SECRET in your environment.");
}
const app = express();
const PORT = process.env.PORT || 2426;

// Allow CORS from any origin in production (adjust for security as needed)
const allowedOrigins = [
  "http://localhost:2427",
  "http://127.0.0.1:2427",
  process.env.FRONTEND_URL || "http://localhost:2427",
];

// Enable CORS for the frontend
app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  }),
);

// Increase payload limits for vision requests that include base64 images.
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Local Server-Side Storage Configuration
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

async function readJsonStore(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const data = await fsPromises.readFile(filePath, "utf8");
      return JSON.parse(data);
    }
  } catch (e) {
    console.error(`Error reading ${filePath}:`, e);
  }
  return [];
}

async function writeJsonStore(filePath, data) {
  await fsPromises.writeFile(filePath, JSON.stringify(data, null, 2));
}

// Per-file mutex — ensures concurrent writes to the same JSON file are
// serialised rather than racing. Uses a promise chain per filename.
const writeLocks = new Map();

function withFileLock(filename, fn) {
  const current = writeLocks.get(filename) || Promise.resolve();
  const next = current.then(fn).catch((err) => {
    console.error(`Error in locked write for ${filename}:`, err);
    throw err;
  });
  // Store only a never-rejecting tail so the chain doesn't stall on error.
  writeLocks.set(filename, next.catch(() => {}));
  return next;
}

// ── User account helpers ──────────────────────────────────────────────────────

const USERS_FILE = path.join(DATA_DIR, "users.json");

async function readUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const data = await fsPromises.readFile(USERS_FILE, "utf8");
      return JSON.parse(data);
    }
  } catch (e) {
    console.error("Error reading users.json:", e);
  }
  return [];
}

async function writeUsers(users) {
  await fsPromises.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
}

function getUserDataDir(userId) {
  const dir = path.join(DATA_DIR, "users", String(userId));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// ── JWT middleware ────────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Authentication required" });
  }
  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload; // { userId, username }
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ── Auth endpoints ────────────────────────────────────────────────────────────

// Whether registration is currently open (used by the frontend to show/hide the link)
app.get("/api/auth/registration-open", (req, res) => {
  res.json({ open: process.env.ALLOW_REGISTRATION === "true" });
});

app.post("/api/auth/register", async (req, res) => {
  if (process.env.ALLOW_REGISTRATION !== "true") {
    return res.status(403).json({ error: "Registration is currently closed" });
  }
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required" });
  }
  if (typeof username !== "string" || username.length < 3 || username.length > 50) {
    return res.status(400).json({ error: "Username must be 3–50 characters" });
  }
  if (typeof password !== "string" || password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }
  // Sanitise username — alphanumeric + _ - only
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    return res.status(400).json({ error: "Username may only contain letters, numbers, _ and -" });
  }

  try {
    const result = await withFileLock("users.json", async () => {
      const users = await readUsers();
      if (users.find((u) => u.username.toLowerCase() === username.toLowerCase())) {
        return { conflict: true };
      }
      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const user = {
        id: Date.now().toString(),
        username,
        passwordHash,
        createdAt: new Date().toISOString(),
      };
      users.push(user);
      await writeUsers(users);
      return { user };
    });

    if (result.conflict) {
      return res.status(409).json({ error: "Username already taken" });
    }

    const { user } = result;
    const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, {
      expiresIn: JWT_EXPIRES_IN,
    });
    res.json({ token, username: user.username });
  } catch (e) {
    console.error("Register error:", e);
    res.status(500).json({ error: "Registration failed" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required" });
  }
  try {
    const users = await readUsers();
    const user = users.find((u) => u.username.toLowerCase() === username.toLowerCase());
    // Use a constant-time comparison path even on missing user to avoid timing attacks
    const dummyHash = "$2a$12$invalidhashtopreventtimingattacks00000000000000000000000";
    const valid = user
      ? await bcrypt.compare(password, user.passwordHash)
      : await bcrypt.compare(password, dummyHash).then(() => false);
    if (!user || !valid) {
      return res.status(401).json({ error: "Invalid username or password" });
    }
    const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, {
      expiresIn: JWT_EXPIRES_IN,
    });
    res.json({ token, username: user.username });
  } catch (e) {
    console.error("Login error:", e);
    res.status(500).json({ error: "Login failed" });
  }
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  res.json({ userId: req.user.userId, username: req.user.username });
});

// ── Data Endpoints for Settings & Configurations ─────────────────────────────
// Config is now stored per user, ensuring each user has their own API settings
app.get("/api/config", requireAuth, async (req, res) => {
  try {
    const configPath = path.join(getUserDataDir(req.user.userId), "config.json");
    if (fs.existsSync(configPath)) {
      const data = await fsPromises.readFile(configPath, "utf8");
      res.json(JSON.parse(data));
    } else {
      res.json({});
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/config", requireAuth, async (req, res) => {
  try {
    await fsPromises.writeFile(path.join(getUserDataDir(req.user.userId), "config.json"), JSON.stringify(req.body, null, 2));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Per-user Data Endpoints for Characters/Cards/Prompts ─────────────────────
app.get("/api/storage/:type", requireAuth, async (req, res) => {
  const storeName = req.params.type === "cards" ? "cards.json" : "prompts.json";
  const storeFile = path.join(getUserDataDir(req.user.userId), storeName);
  const items = await readJsonStore(storeFile);
  res.json(items);
});

app.get("/api/storage/:type/:id", requireAuth, async (req, res) => {
  const storeName = req.params.type === "cards" ? "cards.json" : "prompts.json";
  const storeFile = path.join(getUserDataDir(req.user.userId), storeName);
  const items = await readJsonStore(storeFile);
  const item = items.find(i => i.id == req.params.id);
  if (item) res.json(item);
  else res.status(404).json({ error: "Not found" });
});

app.post("/api/storage/:type", requireAuth, async (req, res) => {
  const storeName = req.params.type === "cards" ? "cards.json" : "prompts.json";
  const storeFile = path.join(getUserDataDir(req.user.userId), storeName);
  const lockKey = `user-${req.user.userId}-${storeName}`;
  const record = req.body;
  if (!record.id) record.id = Date.now();
  try {
    const result = await withFileLock(lockKey, async () => {
      const items = await readJsonStore(storeFile);
      const index = items.findIndex(i => i.id == record.id);
      if (index >= 0) items[index] = record;
      else items.push(record);
      await writeJsonStore(storeFile, items);
      return record;
    });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/storage/:type/:id", requireAuth, async (req, res) => {
  const storeName = req.params.type === "cards" ? "cards.json" : "prompts.json";
  const storeFile = path.join(getUserDataDir(req.user.userId), storeName);
  const lockKey = `user-${req.user.userId}-${storeName}`;
  try {
    await withFileLock(lockKey, async () => {
      let items = await readJsonStore(storeFile);
      items = items.filter(i => i.id != req.params.id);
      await writeJsonStore(storeFile, items);
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ── Story Writer availability check ──────────────────────────────────────────
// Probes the JoeAnory backend container-to-container over the shared Docker
// network.  Returns the public URL for the browser tab if reachable.
app.get("/api/story-app/status", async (req, res) => {
  const internalUrl = (process.env.STORY_APP_URL || "").replace(/\/$/, "");
  const publicUrl = (process.env.STORY_APP_PUBLIC_URL || "").replace(/\/$/, "");

  if (!internalUrl) {
    console.log("Story Writer connection check skipped: STORY_APP_URL is not set.");
    return res.json({ available: false });
  }

  try {
    console.log(`Story Writer connection check: Pinging ${internalUrl}/`);
    const response = await fetch(`${internalUrl}/`, {
      method: "GET",
      timeout: 3000,
    });
    
    console.log(`Story Writer connection check: Received status ${response.status} ${response.statusText}`);
    if (response.ok) {
      console.log(`Story Writer connection check: Success! Returning public URL: ${publicUrl || internalUrl}`);
      return res.json({ available: true, url: publicUrl || internalUrl });
    }
    const errorText = await response.text();
    console.log(`Story Writer connection check: Response not ok. Body: ${errorText}`);
    return res.json({ available: false });
  } catch (err) {
    console.error("Story Writer connection check: Network error or timeout:", err.message);
    return res.json({ available: false });
  }
});

// Proxy endpoint for text API
app.post("/api/text/chat/completions", requireAuth, async (req, res) => {
  try {
    const { model, messages, max_tokens, temperature, stream } = req.body;

    const apiKey = req.headers["x-api-key"];
    const apiUrl = req.headers["x-api-url"];

    if (!apiKey) {
      console.error("Missing API key in request headers");
      return res.status(401).json({
        error: {
          code: "401",
          message: "API key required",
          details: "Please configure your Text API key in the settings",
        },
      });
    }

    if (!apiUrl) {
      console.error("Missing API URL in request headers");
      return res.status(400).json({
        error: {
          code: "400",
          message: "API URL required",
          details: "Please configure your Text API Base URL in the settings",
        },
      });
    }

    // Append the endpoint path if not already present
    const fullTextUrl = apiUrl.endsWith("/chat/completions")
      ? apiUrl
      : `${apiUrl}/chat/completions`;

    console.log("Proxying text request to:", fullTextUrl);
    console.log("Model:", model);
    console.log("Messages count:", messages?.length || 0);

    // Add OpenRouter-specific headers if using OpenRouter
    const isOpenRouter = apiUrl.includes("openrouter.ai");
    const additionalHeaders = isOpenRouter
      ? {
          "HTTP-Referer": process.env.FRONTEND_URL || "http://localhost:2427",
          "X-Title": "SillyTavern Character Generator",
        }
      : {};

    const requestBody = {
      model,
      messages,
      max_tokens: max_tokens || 1000,
      temperature: temperature || 0.7,
      stream: stream || false,
    };

    // Try Bearer auth first (most common)
    let response = await fetch(fullTextUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...additionalHeaders,
      },
      body: JSON.stringify(requestBody),
    });

    // If Bearer fails with 401, try X-API-Key
    if (response.status === 401) {
      console.log("Bearer auth failed, trying X-API-Key...");
      response = await fetch(fullTextUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": apiKey,
          ...additionalHeaders,
        },
        body: JSON.stringify(requestBody),
      });
    }

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Text API error:", response.status, errorText);
      return res.status(response.status).json({
        error: {
          code: response.status.toString(),
          message: `API Error: ${response.statusText}`,
          details: errorText,
        },
      });
    }

    if (stream) {
      // Handle streaming response
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      response.body.on("data", (chunk) => {
        res.write(chunk);
      });

      response.body.on("end", () => {
        res.end();
      });
    } else {
      const data = await response.json();
      res.json(data);
    }
  } catch (error) {
    console.error("Proxy error:", error);
    res.status(500).json({
      error: {
        code: "500",
        message: "Internal server error in proxy",
        details: error.message,
      },
    });
  }
});

// Free image generation via Pollinations.ai (no API key required)
app.post("/api/image/free", requireAuth, async (req, res) => {  try {
    const { prompt, service, model, width, height, seed } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: { code: "400", message: "prompt is required" } });
    }

    if (service !== "pollinations") {
      return res.status(400).json({ error: { code: "400", message: `Unknown free image service: ${service}` } });
    }

    const w = width || 768;
    const h = height || 1024;
    const s = seed !== undefined ? seed : Math.floor(Math.random() * 2147483647);
    const encodedPrompt = encodeURIComponent(prompt);
    const pollinationsUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?model=${encodeURIComponent(model || "flux")}&width=${w}&height=${h}&nologo=true&seed=${s}`;

    console.log("Free image (Pollinations):", pollinationsUrl.substring(0, 120) + "...");

    const response = await fetch(pollinationsUrl, { timeout: 120000 });

    if (!response.ok) {
      return res.status(response.status).json({
        error: { code: response.status.toString(), message: `Pollinations returned ${response.status}: ${response.statusText}` },
      });
    }

    const contentType = response.headers.get("content-type") || "image/jpeg";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Access-Control-Allow-Origin", "*");
    response.body.pipe(res);
  } catch (error) {
    console.error("Free image proxy error:", error);
    res.status(500).json({ error: { code: "500", message: "Free image proxy error", details: error.message } });
  }
});

// Proxy endpoint for image API
app.post("/api/image/generations", requireAuth, async (req, res) => {
  try {
    const { model, prompt, size } = req.body;

    const apiKey = req.headers["x-api-key"];
    const apiUrl = req.headers["x-api-url"];

    if (!apiKey) {
      console.error("Missing API key in request headers");
      return res.status(401).json({
        error: {
          code: "401",
          message: "Image API key required",
          details: "Please configure your Image API key in the settings",
        },
      });
    }

    if (!apiUrl) {
      console.error("Missing API URL in request headers");
      return res.status(400).json({
        error: {
          code: "400",
          message: "Image API URL required",
          details: "Please configure your Image API Base URL in the settings",
        },
      });
    }

    // Append the endpoint path if not already present
    const fullImageUrl = apiUrl.endsWith("/images/generations")
      ? apiUrl
      : `${apiUrl}/images/generations`;

    console.log("Proxying image request to:", fullImageUrl);
    console.log("Model:", model);
    console.log("Prompt length:", prompt?.length || 0);

    // Use simplified format for all models, but forward all parameters
    // This supports APIs like NanoGPT that need n, response_format, etc.
    const requestBody = {
      ...req.body,
    };

    // Ensure model is set (should be from req.body, but just in case)
    if (!requestBody.model) requestBody.model = model;
    if (!requestBody.prompt) requestBody.prompt = prompt;

    // Add size only if provided by the client and not already in body
    if (size && !requestBody.size) {
      requestBody.size = size;
    }

    // Add OpenRouter-specific headers if using OpenRouter
    const isOpenRouter = apiUrl.includes("openrouter.ai");
    const additionalHeaders = isOpenRouter
      ? {
          "HTTP-Referer": process.env.FRONTEND_URL || "http://localhost:2427",
          "X-Title": "SillyTavern Character Generator",
        }
      : {};

    // Try Bearer auth first (most common for image APIs)
    let response = await fetch(fullImageUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...additionalHeaders,
      },
      body: JSON.stringify(requestBody),
    });

    // If Bearer fails with 401, try X-API-Key
    if (response.status === 401) {
      console.log("Bearer auth failed for image API, trying X-API-Key...");
      response = await fetch(fullImageUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": apiKey,
          ...additionalHeaders,
        },
        body: JSON.stringify(requestBody),
      });
    }

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Image API error:", response.status, errorText);
      return res.status(response.status).json({
        error: {
          code: response.status.toString(),
          message: `Image API Error: ${response.statusText}`,
          details: errorText,
        },
      });
    }

    const data = await response.json();

    // Handle different response formats flexibly
    // Just pass through whatever the image API returns
    res.json(data);
  } catch (error) {
    console.error("Image proxy error:", error);
    res.status(500).json({
      error: {
        code: "500",
        message: "Internal server error in image proxy",
        details: error.message,
      },
    });
  }
});

// Proxy endpoint for fetching images (CORS bypass)
app.get("/api/proxy-image", requireAuth, async (req, res) => {
  try {
    const imageUrl = req.query.url;

    if (!imageUrl) {
      return res.status(400).json({
        error: {
          code: "400",
          message: "Image URL required",
          details: "Please provide a URL parameter with the image URL",
        },
      });
    }

    console.log("Proxying image request for:", imageUrl);

    const response = await fetch(imageUrl);

    if (!response.ok) {
      console.error(
        "Failed to fetch image:",
        response.status,
        response.statusText,
      );
      return res.status(response.status).json({
        error: {
          code: response.status.toString(),
          message: `Failed to fetch image: ${response.statusText}`,
          details: `Image URL: ${imageUrl}`,
        },
      });
    }

    // Get the image as a buffer
    const imageBuffer = await response.buffer();

    // Set appropriate headers
    const contentType = response.headers.get("content-type") || "image/jpeg";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=31536000");

    // Send the image
    res.send(imageBuffer);
  } catch (error) {
    console.error("Image proxy error:", error);
    res.status(500).json({
      error: {
        code: "500",
        message: "Internal server error in image proxy",
        details: error.message,
      },
    });
  }
});

// ── SillyTavern Bridge ────────────────────────────────────────────────────────
// All ST endpoints expect the X-ST-URL header pointing to the ST container's
// internal URL (e.g. http://sillytavern:8000 — bypasses nginx entirely).

function getStUrl(req, res) {
  const url = req.headers["x-st-url"];
  if (!url) {
    res.status(400).json({ error: "X-ST-URL header is required" });
    return null;
  }
  // Basic sanity — must start with http:// or https://
  if (!/^https?:\/\//i.test(url)) {
    res.status(400).json({ error: "X-ST-URL must be a valid HTTP(S) URL" });
    return null;
  }
  return url;
}

// ST requires a paired session cookie + CSRF token on every API request.
// Cache per base URL (+ optional basic-auth identity) for up to 10 minutes;
// auto-invalidate on 403.
const stCsrfCache = {};

// Per-URL store of the last basic-auth value used.  Allows the thumbnail
// endpoint (which receives stUrl via query param, not a header) to reuse the
// credentials that were established by the most recent non-thumbnail call.
const stBasicAuthStore = {};

// Build an HTTP Basic Authorization header value from the X-ST-USERNAME /
// X-ST-PASSWORD request headers.  Returns null when no username is set.
function getStBasicAuth(req) {
  const username = req.headers["x-st-username"] || "";
  const password = req.headers["x-st-password"] || "";
  if (!username) return null;
  return "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
}

// Extract only the name=value pairs from Set-Cookie headers (strip Path, HttpOnly, etc.)
function parseCookieHeaders(rawHeaders) {
  if (!rawHeaders) return "";
  const list = Array.isArray(rawHeaders) ? rawHeaders : [rawHeaders];
  return list.map(c => c.split(";")[0].trim()).filter(Boolean).join("; ");
}

// basicAuth — "Basic <base64>" string or null.  When provided it is sent on
// every request to ST and is included in the cache key so different users
// do not share CSRF tokens.
async function getStCsrfHeaders(stUrl, basicAuth) {
  const cacheKey = stUrl + "\0" + (basicAuth || "");
  const cached = stCsrfCache[cacheKey];
  if (cached && Date.now() - cached.fetchedAt < 10 * 60 * 1000) {
    return { "X-CSRF-Token": cached.token, "Cookie": cached.cookie };
  }

  const authHeader = basicAuth ? { "Authorization": basicAuth } : {};

  // Step 1: hit the root to establish a session cookie
  const sessionRes = await fetch(`${stUrl}/`, { method: "GET", headers: { ...authHeader } });
  const sessionCookieRaw = sessionRes.headers.raw()["set-cookie"];
  const sessionCookie = parseCookieHeaders(sessionCookieRaw);

  // Step 2: fetch the CSRF token using that session cookie
  const csrfRes = await fetch(`${stUrl}/csrf-token`, {
    method: "GET",
    headers: { ...(sessionCookie ? { "Cookie": sessionCookie } : {}), ...authHeader },
  });
  if (!csrfRes.ok) throw new Error(`Failed to fetch ST CSRF token: ${csrfRes.status}`);

  // Merge any additional cookies set by the csrf-token endpoint
  const csrfCookieRaw = csrfRes.headers.raw()["set-cookie"];
  const csrfCookie = parseCookieHeaders(csrfCookieRaw);
  const cookie = [sessionCookie, csrfCookie].filter(Boolean).join("; ");

  const data = await csrfRes.json();
  stCsrfCache[cacheKey] = { token: data.token, cookie, fetchedAt: Date.now() };
  return { "X-CSRF-Token": data.token, "Cookie": cookie };
}

// List all characters from ST
app.get("/api/st/characters", requireAuth, async (req, res) => {
  const stUrl = getStUrl(req, res);
  if (!stUrl) return;
  const basicAuth = getStBasicAuth(req);
  stBasicAuthStore[stUrl] = basicAuth;
  try {
    const authHeader = basicAuth ? { "Authorization": basicAuth } : {};
    const csrfHeaders = await getStCsrfHeaders(stUrl, basicAuth);
    let response = await fetch(`${stUrl}/api/characters/all`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...csrfHeaders, ...authHeader },
      body: "{}",
    });
    if (response.status === 403) {
      delete stCsrfCache[stUrl + "\0" + (basicAuth || "")];
      const retryHeaders = await getStCsrfHeaders(stUrl, basicAuth);
      response = await fetch(`${stUrl}/api/characters/all`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...retryHeaders, ...authHeader },
        body: "{}",
      });
    }
    if (!response.ok) {
      return res.status(response.status).json({ error: `ST returned ${response.status}` });
    }
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error("ST list characters error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Export (download) a single character PNG from ST
// Pipes the PNG binary directly back — client can treat it like a file drop
app.post("/api/st/export", requireAuth, async (req, res) => {
  const stUrl = getStUrl(req, res);
  if (!stUrl) return;
  const { avatar_url } = req.body;
  if (!avatar_url || typeof avatar_url !== "string") {
    return res.status(400).json({ error: "avatar_url is required" });
  }
  const basicAuth = getStBasicAuth(req);
  stBasicAuthStore[stUrl] = basicAuth;
  try {
    const authHeader = basicAuth ? { "Authorization": basicAuth } : {};
    const csrfHeaders = await getStCsrfHeaders(stUrl, basicAuth);
    let response = await fetch(`${stUrl}/api/characters/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...csrfHeaders, ...authHeader },
      body: JSON.stringify({ format: "png", avatar_url }),
    });
    if (response.status === 403) {
      delete stCsrfCache[stUrl + "\0" + (basicAuth || "")];
      const retryHeaders = await getStCsrfHeaders(stUrl, basicAuth);
      response = await fetch(`${stUrl}/api/characters/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...retryHeaders, ...authHeader },
        body: JSON.stringify({ format: "png", avatar_url }),
      });
    }
    if (!response.ok) {
      return res.status(response.status).json({ error: `ST export returned ${response.status}` });
    }
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Disposition", `attachment; filename="${avatar_url}"`);
    response.body.pipe(res);
  } catch (error) {
    console.error("ST export error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Push a character PNG to ST (create new or update existing)
// Body: { pngBase64: string, preservedName?: string }
//   preservedName — set to the original avatar filename (without .png) to
//   overwrite an existing card; omit to create a new one.
app.post("/api/st/push", requireAuth, async (req, res) => {
  const stUrl = getStUrl(req, res);
  if (!stUrl) return;
  const { pngBase64, preservedName } = req.body;
  if (!pngBase64 || typeof pngBase64 !== "string") {
    return res.status(400).json({ error: "pngBase64 is required" });
  }
  try {
    const pngBuffer = Buffer.from(pngBase64, "base64");

    // Build multipart/form-data body manually.
    // Boundary must NOT start with '--' (those are added as delimiters).
    const boundary = `CardGenBoundary${Date.now()}`;
    const CRLF = Buffer.from("\r\n");
    const DASHDASH = Buffer.from("--");

    function part(headers, body) {
      const headerBuf = Buffer.from(
        headers.map(h => h + "\r\n").join("") + "\r\n",
        "utf8"
      );
      return Buffer.concat([DASHDASH, Buffer.from(boundary), CRLF, headerBuf, body, CRLF]);
    }

    const parts = [
      part(
        [
          'Content-Disposition: form-data; name="avatar"; filename="character.png"',
          "Content-Type: image/png",
        ],
        pngBuffer
      ),
      part(
        ['Content-Disposition: form-data; name="file_type"'],
        Buffer.from("png")
      ),
    ];

    if (preservedName) {
      parts.push(
        part(
          ['Content-Disposition: form-data; name="preserved_name"'],
          Buffer.from(String(preservedName))
        )
      );
    }

    const closing = Buffer.from(`--${boundary}--\r\n`);
    const body = Buffer.concat([...parts, closing]);

    const basicAuth = getStBasicAuth(req);
    stBasicAuthStore[stUrl] = basicAuth;
    const authHeader = basicAuth ? { "Authorization": basicAuth } : {};
    const csrfHeaders = await getStCsrfHeaders(stUrl, basicAuth);
    console.log("ST push: boundary =", boundary, "body size =", body.length, "bytes");
    console.log("ST push: CSRF token present =", !!csrfHeaders["X-CSRF-Token"]);
    console.log("ST push: Cookie present =", !!csrfHeaders["Cookie"]);
    let response = await fetch(`${stUrl}/api/characters/import`, {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length,
        ...csrfHeaders,
        ...authHeader,
      },
      body,
    });
    if (response.status === 403) {
      delete stCsrfCache[stUrl + "\0" + (basicAuth || "")];
      const retryHeaders = await getStCsrfHeaders(stUrl, basicAuth);
      response = await fetch(`${stUrl}/api/characters/import`, {
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length,
          ...retryHeaders,
          ...authHeader,
        },
        body,
      });
    }

    if (!response.ok) {
      const errText = await response.text();
      console.error("ST import error:", response.status, errText);
      return res.status(response.status).json({ error: `ST import returned ${response.status}`, detail: errText });
    }
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error("ST push error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Test ST connection
app.get("/api/st/ping", requireAuth, async (req, res) => {
  const stUrl = getStUrl(req, res);
  if (!stUrl) return;
  const basicAuth = getStBasicAuth(req);
  stBasicAuthStore[stUrl] = basicAuth;
  try {
    const authHeader = basicAuth ? { "Authorization": basicAuth } : {};
    const csrfHeaders = await getStCsrfHeaders(stUrl, basicAuth);
    const response = await fetch(`${stUrl}/api/characters/all`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...csrfHeaders, ...authHeader },
      body: "{}",
      timeout: 5000,
    });
    if (response.ok) {
      const data = await response.json();
      res.json({ ok: true, characterCount: Array.isArray(data) ? data.length : 0 });
    } else {
      res.json({ ok: false, status: response.status });
    }
  } catch (error) {
    res.json({ ok: false, error: error.message });
  }
});

// Proxy ST avatar thumbnails so the browser doesn't need direct access to ST
// GET /api/st/thumbnail?file=CharacterName.png&stUrl=http://sillytavern:8000
app.get("/api/st/thumbnail", requireAuth, async (req, res) => {
  const file = req.query.file;
  const stUrl = req.query.stUrl;
  if (!file || typeof file !== "string") {
    return res.status(400).end();
  }
  if (!stUrl || !/^https?:\/\//i.test(stUrl)) {
    return res.status(400).end();
  }
  const cleanStUrl = stUrl.replace(/\/$/, "");
  // Reuse the basic-auth credentials that were last set for this ST URL
  // (established by a prior characters/ping/export/push call).
  const basicAuth = stBasicAuthStore[cleanStUrl] || null;
  try {
    const authHeader = basicAuth ? { "Authorization": basicAuth } : {};
    const csrfHeaders = await getStCsrfHeaders(cleanStUrl, basicAuth);
    const response = await fetch(
      `${cleanStUrl}/thumbnail?type=avatar&file=${encodeURIComponent(file)}`,
      { method: "GET", headers: { ...csrfHeaders, ...authHeader } }
    );
    if (!response.ok) {
      return res.status(response.status).end();
    }
    const contentType = response.headers.get("content-type") || "image/png";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=300");
    response.body.pipe(res);
  } catch (error) {
    console.error("ST thumbnail error:", error);
    res.status(500).end();
  }
});
// ─────────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`🚀 Proxy server running on http://localhost:${PORT}`);
  console.log(`📡 Ready to proxy requests to configured APIs`);
  console.log(`🔑 API URLs will be provided via request headers`);
});
