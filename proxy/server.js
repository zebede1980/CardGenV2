const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
require("dotenv").config({ path: "../.env" });

const fs = require("fs");
const fsPromises = require("fs").promises;
const path = require("path");
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

async function readJsonStore(filename) {
  try {
    const filePath = path.join(DATA_DIR, filename);
    if (fs.existsSync(filePath)) {
      const data = await fsPromises.readFile(filePath, "utf8");
      return JSON.parse(data);
    }
  } catch (e) {
    console.error(`Error reading ${filename}:`, e);
  }
  return [];
}

async function writeJsonStore(filename, data) {
  const filePath = path.join(DATA_DIR, filename);
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

// Data Endpoints for Settings & Configurations
app.get("/api/config", async (req, res) => {
  try {
    const configPath = path.join(DATA_DIR, "config.json");
    if (fs.existsSync(configPath)) {
      const data = await fsPromises.readFile(configPath, "utf8");
      res.json(JSON.parse(data));
    } else {
      res.json({});
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/config", async (req, res) => {
  try {
    await fsPromises.writeFile(path.join(DATA_DIR, "config.json"), JSON.stringify(req.body, null, 2));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Data Endpoints for Characters/Cards/Prompts
app.get("/api/storage/:type", async (req, res) => {
  const storeName = req.params.type === "cards" ? "cards.json" : "prompts.json";
  const items = await readJsonStore(storeName);
  res.json(items);
});

app.get("/api/storage/:type/:id", async (req, res) => {
  const storeName = req.params.type === "cards" ? "cards.json" : "prompts.json";
  const items = await readJsonStore(storeName);
  const item = items.find(i => i.id == req.params.id);
  if (item) res.json(item);
  else res.status(404).json({ error: "Not found" });
});

app.post("/api/storage/:type", async (req, res) => {
  const storeName = req.params.type === "cards" ? "cards.json" : "prompts.json";
  const record = req.body;
  if (!record.id) record.id = Date.now();
  try {
    const result = await withFileLock(storeName, async () => {
      const items = await readJsonStore(storeName);
      const index = items.findIndex(i => i.id == record.id);
      if (index >= 0) items[index] = record;
      else items.push(record);
      await writeJsonStore(storeName, items);
      return record;
    });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/storage/:type/:id", async (req, res) => {
  const storeName = req.params.type === "cards" ? "cards.json" : "prompts.json";
  try {
    await withFileLock(storeName, async () => {
      let items = await readJsonStore(storeName);
      items = items.filter(i => i.id != req.params.id);
      await writeJsonStore(storeName, items);
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Proxy endpoint for text API
app.post("/api/text/chat/completions", async (req, res) => {
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
app.post("/api/image/free", async (req, res) => {  try {
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
app.post("/api/image/generations", async (req, res) => {
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
app.get("/api/proxy-image", async (req, res) => {
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
// Cache per base URL for up to 10 minutes; auto-invalidate on 403.
const stCsrfCache = {};

// Extract only the name=value pairs from Set-Cookie headers (strip Path, HttpOnly, etc.)
function parseCookieHeaders(rawHeaders) {
  if (!rawHeaders) return "";
  const list = Array.isArray(rawHeaders) ? rawHeaders : [rawHeaders];
  return list.map(c => c.split(";")[0].trim()).filter(Boolean).join("; ");
}

async function getStCsrfHeaders(stUrl) {
  const cached = stCsrfCache[stUrl];
  if (cached && Date.now() - cached.fetchedAt < 10 * 60 * 1000) {
    return { "X-CSRF-Token": cached.token, "Cookie": cached.cookie };
  }
  // Step 1: hit the root to establish a session cookie
  const sessionRes = await fetch(`${stUrl}/`, { method: "GET" });
  const sessionCookieRaw = sessionRes.headers.raw()["set-cookie"];
  const sessionCookie = parseCookieHeaders(sessionCookieRaw);

  // Step 2: fetch the CSRF token using that session cookie
  const csrfRes = await fetch(`${stUrl}/csrf-token`, {
    method: "GET",
    headers: sessionCookie ? { "Cookie": sessionCookie } : {},
  });
  if (!csrfRes.ok) throw new Error(`Failed to fetch ST CSRF token: ${csrfRes.status}`);

  // Merge any additional cookies set by the csrf-token endpoint
  const csrfCookieRaw = csrfRes.headers.raw()["set-cookie"];
  const csrfCookie = parseCookieHeaders(csrfCookieRaw);
  const cookie = [sessionCookie, csrfCookie].filter(Boolean).join("; ");

  const data = await csrfRes.json();
  stCsrfCache[stUrl] = { token: data.token, cookie, fetchedAt: Date.now() };
  return { "X-CSRF-Token": data.token, "Cookie": cookie };
}

// List all characters from ST
app.get("/api/st/characters", async (req, res) => {
  const stUrl = getStUrl(req, res);
  if (!stUrl) return;
  try {
    const csrfHeaders = await getStCsrfHeaders(stUrl);
    let response = await fetch(`${stUrl}/api/characters/all`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...csrfHeaders },
      body: "{}",
    });
    if (response.status === 403) {
      delete stCsrfCache[stUrl];
      const retryHeaders = await getStCsrfHeaders(stUrl);
      response = await fetch(`${stUrl}/api/characters/all`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...retryHeaders },
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
app.post("/api/st/export", async (req, res) => {
  const stUrl = getStUrl(req, res);
  if (!stUrl) return;
  const { avatar_url } = req.body;
  if (!avatar_url || typeof avatar_url !== "string") {
    return res.status(400).json({ error: "avatar_url is required" });
  }
  try {
    const csrfHeaders = await getStCsrfHeaders(stUrl);
    let response = await fetch(`${stUrl}/api/characters/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...csrfHeaders },
      body: JSON.stringify({ format: "png", avatar_url }),
    });
    if (response.status === 403) {
      delete stCsrfCache[stUrl];
      const retryHeaders = await getStCsrfHeaders(stUrl);
      response = await fetch(`${stUrl}/api/characters/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...retryHeaders },
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
app.post("/api/st/push", async (req, res) => {
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
          'Content-Disposition: form-data; name="file"; filename="character.png"',
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

    const csrfHeaders = await getStCsrfHeaders(stUrl);
    let response = await fetch(`${stUrl}/api/characters/import`, {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length,
        ...csrfHeaders,
      },
      body,
    });
    if (response.status === 403) {
      delete stCsrfCache[stUrl];
      const retryHeaders = await getStCsrfHeaders(stUrl);
      response = await fetch(`${stUrl}/api/characters/import`, {
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length,
          ...retryHeaders,
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
app.get("/api/st/ping", async (req, res) => {
  const stUrl = getStUrl(req, res);
  if (!stUrl) return;
  try {
    const csrfHeaders = await getStCsrfHeaders(stUrl);
    const response = await fetch(`${stUrl}/api/characters/all`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...csrfHeaders },
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
app.get("/api/st/thumbnail", async (req, res) => {
  const file = req.query.file;
  const stUrl = req.query.stUrl;
  if (!file || typeof file !== "string") {
    return res.status(400).end();
  }
  if (!stUrl || !/^https?:\/\//i.test(stUrl)) {
    return res.status(400).end();
  }
  const cleanStUrl = stUrl.replace(/\/$/, "");
  try {
    const csrfHeaders = await getStCsrfHeaders(cleanStUrl);
    const response = await fetch(
      `${cleanStUrl}/thumbnail?type=avatar&file=${encodeURIComponent(file)}`,
      { method: "GET", headers: { ...csrfHeaders } }
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
