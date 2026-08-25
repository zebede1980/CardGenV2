const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
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
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || "";

if (!process.env.JWT_SECRET) {
  console.warn("⚠️  JWT_SECRET not set — using insecure default. Set JWT_SECRET in your environment.");
}
if (!process.env.INTERNAL_API_SECRET) {
  console.warn("⚠️  INTERNAL_API_SECRET not set — backend calls will be rejected. Set INTERNAL_API_SECRET in your environment.");
}
const app = express();
const PORT = process.env.PORT || 2426;

// Allowed CORS origins — set FRONTEND_URL in .env to your public domain.
const allowedOrigins = [
  ...new Set([
    "http://localhost:2427",
    "http://127.0.0.1:2427",
    process.env.FRONTEND_URL,
  ].filter(Boolean)),
];

/**
 * Marks a 401 as being about *this app's* session, not some upstream provider's
 * credentials. The browser's authFetch clears the token and bounces the user to
 * the login screen on 401 — so an upstream API rejecting our key would log the
 * user out of CardGen, which is exactly what happened with TTS. Only responses
 * carrying this header should be treated as a session failure.
 */
const SESSION_EXPIRED_HEADER = "X-Session-Expired";

// Enable CORS for the listed origins only.
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow server-to-server requests (no Origin header) and matched origins.
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS: origin '${origin}' not allowed`));
      }
    },
    credentials: true,
    // Without this the browser hides the header on cross-origin replies, and a
    // genuinely expired session would stop redirecting to login.
    exposedHeaders: [SESSION_EXPIRED_HEADER],
  }),
);

// ── Rate limiting — brute-force protection for auth endpoints ─────────────────
const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15-minute window
  max: 15,                   // max 15 attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts from this IP, please try again in 15 minutes." },
});

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
  writeLocks.set(filename, next.catch(() => { }));
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

// ── Per-user history (non-permanent auto-saves) stored as a local flat file ──
const HISTORY_MAX = 30;

async function readHistory(userId) {
  await autoMigrateDataIfNeeded(userId, "system");
  const internalUrl = (process.env.STORY_APP_URL || "http://storywriterbackend:8000").replace(/\/$/, "");
  const url = `${internalUrl}/api/proxy-data/history`;
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-User-Id": String(userId),
        "X-User-Name": "system",
        "X-Internal-Secret": INTERNAL_API_SECRET
      }
    });
    if (!response.ok) return [];
    let items = await response.json();
    return items.map(item => ({ ...item.data, id: item.id, updatedAt: item.data.updatedAt || item.updated_at }));
  } catch (e) {
    return [];
  }
}

async function writeHistory(userId, items) {
  await autoMigrateDataIfNeeded(userId, "system");
  const internalUrl = (process.env.STORY_APP_URL || "http://storywriterbackend:8000").replace(/\/$/, "");

  try {
    // 1. Fetch current history from DB
    const currentRes = await fetch(`${internalUrl}/api/proxy-data/history`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-User-Id": String(userId),
        "X-User-Name": "system",
        "X-Internal-Secret": INTERNAL_API_SECRET
      }
    });

    if (currentRes.ok) {
      const currentItems = await currentRes.json();
      const newIds = new Set(items.map(i => String(i.id)));

      // 2. Delete any items currently in DB that are NOT in the new list
      for (const curr of currentItems) {
        if (!newIds.has(String(curr.id))) {
          await fetch(`${internalUrl}/api/proxy-data/history/${curr.id}`, {
            method: "DELETE",
            headers: {
              "Content-Type": "application/json",
              "X-User-Id": String(userId),
              "X-User-Name": "system",
              "X-Internal-Secret": INTERNAL_API_SECRET
            }
          });
        }
      }
    }

    // 3. Upsert the items that are in the new list
    for (const item of items) {
      await fetch(`${internalUrl}/api/proxy-data/history`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-User-Id": String(userId),
          "X-User-Name": "system",
          "X-Internal-Secret": INTERNAL_API_SECRET
        },
        body: JSON.stringify({ id: String(item.id || Date.now()), data: item })
      });
    }
  } catch (e) {
    console.error("Failed to write history:", e);
  }
}

// Delete all archived history-image files for a card (e.g. ${cardId}_h0.img)
async function deleteCardHistoryImages(imgDir, cardId) {
  let i = 0;
  while (true) {
    const imgFile = path.join(imgDir, `${cardId}_h${i}.img`);
    if (!fs.existsSync(imgFile)) break;
    for (const ext of [".img", ".mime"]) {
      fsPromises.unlink(path.join(imgDir, `${cardId}_h${i}${ext}`)).catch(() => { });
    }
    i++;
  }
}

// Save imageHistory array (base64 data-URLs) to per-card files
async function saveCardHistoryImages(imgDir, cardId, imageHistory) {
  if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });
  // Remove any previously stored history images for this card first
  await deleteCardHistoryImages(imgDir, cardId);
  if (!Array.isArray(imageHistory) || imageHistory.length === 0) return;
  for (let i = 0; i < imageHistory.length; i++) {
    const item = imageHistory[i];
    if (typeof item !== "string") continue;
    const match = item.match(/^data:([^;]+);base64,(.+)$/s);
    if (!match) continue;
    await Promise.all([
      fsPromises.writeFile(path.join(imgDir, `${cardId}_h${i}.img`), Buffer.from(match[2], "base64")),
      fsPromises.writeFile(path.join(imgDir, `${cardId}_h${i}.mime`), match[1]),
    ]);
  }
}

// Load imageHistory array from per-card files, returns array of base64 data-URLs
async function loadCardHistoryImages(imgDir, cardId) {
  const history = [];
  let i = 0;
  while (true) {
    const imgFile = path.join(imgDir, `${cardId}_h${i}.img`);
    const mimeFile = path.join(imgDir, `${cardId}_h${i}.mime`);
    if (!fs.existsSync(imgFile)) break;
    try {
      const [buf, mime] = await Promise.all([
        fsPromises.readFile(imgFile),
        fsPromises.readFile(mimeFile, "utf8"),
      ]);
      history.push(`data:${mime};base64,${buf.toString("base64")}`);
    } catch (e) {
      break;
    }
    i++;
  }
  return history;
}

// Delete all on-disk gallery image files for a card (${cardId}_gallery_{galleryId}.img/.mime)
async function deleteCardGalleryImages(imgDir, cardId, galleryId = null) {
  if (!fs.existsSync(imgDir)) return;
  const prefix = galleryId != null ? `${cardId}_gallery_${galleryId}.` : `${cardId}_gallery_`;
  for (const file of fs.readdirSync(imgDir)) {
    if (file.startsWith(prefix)) {
      fsPromises.unlink(path.join(imgDir, file)).catch(() => { });
    }
  }
}

// ── JWT middleware ────────────────────────────────────────────────────────────

function sessionUnauthorized(res, message) {
  return res.status(401).set(SESSION_EXPIRED_HEADER, "1").json({ error: message });
}

/**
 * Status to report when an upstream provider fails. 401/403 must never be
 * relayed verbatim: at this layer they mean "your CardGen login is invalid",
 * which is a different and much more disruptive claim than "the provider
 * rejected our API key". The real status stays in the message body.
 */
function upstreamFailureStatus(status) {
  return status === 401 || status === 403 ? 502 : status;
}

function requireAuth(req, res, next) {
  // Accept Bearer header OR ?token= query param (needed for <img src> which can't send headers)
  const authHeader = req.headers["authorization"];
  const tokenFromHeader = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const tokenFromQuery = typeof req.query.token === "string" ? req.query.token : null;
  const token = tokenFromHeader || tokenFromQuery;
  if (!token) {
    return sessionUnauthorized(res, "Authentication required");
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload; // { userId, username }
    next();
  } catch (e) {
    return sessionUnauthorized(res, "Invalid or expired token");
  }
}

// ── Auth endpoints ────────────────────────────────────────────────────────────

// Whether registration is currently open (used by the frontend to show/hide the link)
app.get("/api/auth/registration-open", (req, res) => {
  res.json({ open: process.env.ALLOW_REGISTRATION === "true" });
});

app.post("/api/auth/register", authRateLimiter, async (req, res) => {
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

app.post("/api/auth/login", authRateLimiter, async (req, res) => {
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

app.post("/api/auth/change-password", authRateLimiter, requireAuth, async (req, res) => {
  const { currentPassword, newPassword, targetUsername } = req.body || {};

  if (!newPassword || typeof newPassword !== "string" || newPassword.length < 8) {
    return res.status(400).json({ error: "New password must be at least 8 characters" });
  }

  try {
    const result = await withFileLock("users.json", async () => {
      const users = await readUsers();

      // Admin changing someone else's password
      if (targetUsername) {
        if (req.user.username.toLowerCase() !== "admin") {
          return { status: 403, error: "Only the admin user can change other users' passwords" };
        }
        const targetIndex = users.findIndex((u) => u.username.toLowerCase() === targetUsername.toLowerCase());
        if (targetIndex === -1) {
          return { status: 404, error: "Target user not found" };
        }
        users[targetIndex].passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
        await writeUsers(users);
        return { status: 200, message: `Password updated for user ${targetUsername}` };
      }

      // User changing their own password
      if (!currentPassword) {
        return { status: 400, error: "Current password is required to change your own password" };
      }
      const userIndex = users.findIndex((u) => u.id === req.user.userId);
      if (userIndex === -1) {
        return { status: 404, error: "User not found" };
      }

      const valid = await bcrypt.compare(currentPassword, users[userIndex].passwordHash);
      if (!valid) {
        return { status: 401, error: "Incorrect current password" };
      }

      users[userIndex].passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
      await writeUsers(users);
      return { status: 200, message: "Password updated successfully" };
    });

    if (result.error) {
      return res.status(result.status).json({ error: result.error });
    }
    res.json({ success: true, message: result.message });
  } catch (e) {
    console.error("Change password error:", e);
    res.status(500).json({ error: "Failed to change password" });
  }
});

// ── Data Endpoints for Settings & Configurations ─────────────────────────────
// ── Shared helper to proxy proxy-data requests to backend ────────────────────
async function autoMigrateDataIfNeeded(userId, username) {
  const dir = getUserDataDir(userId);
  const filesToMigrate = ["config.json", "prompts.json", "history.json"];
  const internalUrl = (process.env.STORY_APP_URL || "http://storywriterbackend:8000").replace(/\/$/, "");
  const headers = {
    "Content-Type": "application/json",
    "X-User-Id": String(userId),
    "X-User-Name": String(username),
    "X-Internal-Secret": INTERNAL_API_SECRET
  };

  for (const file of filesToMigrate) {
    const filePath = path.join(dir, file);
    if (!fs.existsSync(filePath)) continue;

    try {
      const content = await fsPromises.readFile(filePath, "utf8");
      const parsed = JSON.parse(content);
      let itemsToPush = [];
      let endpoint = "";

      if (file === "config.json") {
        endpoint = "config";
        await fetch(`${internalUrl}/api/proxy-data/${endpoint}`, {
          method: "POST", headers, body: JSON.stringify({ config_data: parsed })
        });
      } else if (file === "prompts.json") {
        endpoint = "prompts";
        itemsToPush = Array.isArray(parsed) ? parsed : [];
      } else if (file === "history.json") {
        endpoint = "history";
        itemsToPush = Array.isArray(parsed) ? parsed : [];
      }

      if (itemsToPush.length > 0) {
        for (const item of itemsToPush) {
          await fetch(`${internalUrl}/api/proxy-data/${endpoint}`, {
            method: "POST", headers, body: JSON.stringify({ id: String(item.id || Date.now()), data: item })
          });
        }
      }

      // Rename to avoid migrating again
      await fsPromises.rename(filePath, `${filePath}.migrated`);
      console.log(`[Migration] Auto-migrated ${file} to PostgreSQL`);
    } catch (e) {
      console.error(`[Migration] Failed for ${file}:`, e);
    }
  }
}

async function forwardProxyData(req, res, endpoint) {
  await autoMigrateDataIfNeeded(req.user.userId, req.user.username);

  const internalUrl = (process.env.STORY_APP_URL || "http://storywriterbackend:8000").replace(/\/$/, "");
  const url = `${internalUrl}/api/proxy-data/${endpoint}`;
  try {
    const response = await fetch(url, {
      method: req.method,
      headers: {
        "Content-Type": "application/json",
        "X-User-Id": String(req.user.userId),
        "X-User-Name": String(req.user.username),
        "X-Internal-Secret": INTERNAL_API_SECRET
      },
      body: req.method !== "GET" && req.method !== "DELETE" ? JSON.stringify(req.body) : undefined
    });
    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: errText });
    }
    let data = await response.json();

    // For GET lists, unwrap the nested data so it looks exactly like local JSON to the frontend
    if (req.method === "GET" && Array.isArray(data)) {
      data = data.map(item => ({ ...item.data, id: item.id, updatedAt: item.updated_at }));
    } else if (req.method === "GET" && data.data) {
      data = { ...data.data, id: data.id, updatedAt: data.updated_at };
    } else if (req.method === "GET" && endpoint === "config") {
      data = data.config_data || {};
    } else if ((req.method === "POST" || req.method === "PUT") && endpoint === "config") {
      data = { success: true };
    }

    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ── Data Endpoints for Settings & Configurations ─────────────────────────────
// Config is now stored per user, ensuring each user has their own API settings
app.get("/api/config", requireAuth, async (req, res) => {
  return forwardProxyData(req, res, "config");
});

app.post("/api/config", requireAuth, async (req, res) => {
  req.body = { config_data: req.body };
  return forwardProxyData(req, res, "config");
});

// ── Per-user Data Endpoints for Prompts (PostgreSQL proxied) ─────────────────────────
app.get("/api/storage/prompts", requireAuth, async (req, res) => {
  return forwardProxyData(req, res, "prompts");
});

app.get("/api/storage/prompts/:id", requireAuth, async (req, res) => {
  return forwardProxyData(req, res, `prompts/${req.params.id}`);
});

app.post("/api/storage/prompts", requireAuth, async (req, res) => {
  const record = req.body;
  if (!record.id) record.id = String(Date.now());
  req.body = { id: record.id, data: record };
  return forwardProxyData(req, res, "prompts");
});

app.delete("/api/storage/prompts/:id", requireAuth, async (req, res) => {
  return forwardProxyData(req, res, `prompts/${req.params.id}`);
});

// ── Shared helper: translate a flat DB card row into the shape the UI expects ─
function translateDbCard(c) {
  let altGreetings = [];
  let charBook = undefined;

  try {
    if (c.alternate_greetings && String(c.alternate_greetings).trim() !== "") {
      const parsed = JSON.parse(c.alternate_greetings);
      if (Array.isArray(parsed)) altGreetings = parsed;
    }
  } catch (e) { console.warn(`[Card Storage] Failed to parse alternate_greetings for card ${c.id}`); }

  try {
    if (c.character_book && String(c.character_book).trim() !== "") {
      charBook = JSON.parse(c.character_book);
    }
  } catch (e) { console.warn(`[Card Storage] Failed to parse character_book for card ${c.id}`); }

  // The nested `character` object is what handleLibraryCardClick expects (card.character.name etc.)
  const character = {
    name: c.name || "Unnamed",
    description: c.description || "",
    personality: c.personality || "",
    scenario: c.scenario || "",
    firstMessage: c.first_mes || "",
    mesExample: c.mes_example || "",
    creatorNotes: c.creatorcomment || "",
    tags: c.tags ? String(c.tags).split(",").map(t => t.trim()).filter(Boolean) : [],
    creator: c.creator || "",
    character_version: c.character_version || "",
    alternateGreetings: altGreetings,
    system_prompt: c.system_prompt || "",
    post_history_instructions: c.post_history_instructions || "",
    character_book: charBook,
  };

  return {
    id: c.id,
    // Library list renderer uses characterName and isPermanent
    characterName: c.name || "Unnamed Character",
    isPermanent: true,
    updatedAt: c.updated_at || c.created_at || new Date().toISOString(),
    createdAt: c.created_at || new Date().toISOString(),
    // Nested object for the load handler
    character,
    // Also spread flat fields so the StoryWriter card picker can read them directly
    ...character,
    image_path: c.image_path || "",
  };
}

// ── Per-user Data Endpoints for Cards (PostgreSQL Database Bridge) ───────────

// Thumbnail endpoint MUST be registered before /:id so Express doesn't treat "thumbnail" as an ID
app.get("/api/storage/cards/thumbnail", requireAuth, async (req, res) => {
  const cardId = req.query.cardId;
  if (!cardId || typeof cardId !== "string") {
    return res.status(400).end();
  }
  const imgDir = path.join(getUserDataDir(req.user.userId), "card-images");
  const imgFile = path.join(imgDir, `${cardId}.img`);
  const mimeFile = path.join(imgDir, `${cardId}.mime`);

  if (!fs.existsSync(imgFile) || !fs.existsSync(mimeFile)) {
    return res.status(404).end();
  }

  try {
    const [imgBuf, mime] = await Promise.all([
      fsPromises.readFile(imgFile),
      fsPromises.readFile(mimeFile, "utf8"),
    ]);
    res.setHeader("Content-Type", mime);
    res.setHeader("Cache-Control", "public, max-age=300");
    res.send(imgBuf);
  } catch (error) {
    console.error("Card thumbnail error:", error);
    res.status(500).end();
  }
});

app.get("/api/storage/cards", requireAuth, async (req, res) => {
  try {
    const internalUrl = (process.env.STORY_APP_URL || "http://storywriterbackend:8000").replace(/\/$/, "");
    const [dbResponse, histItems] = await Promise.all([
      fetch(`${internalUrl}/api/cards/`, {
        headers: { "X-User-Id": String(req.user.userId), "X-User-Name": String(req.user.username), "X-Internal-Secret": INTERNAL_API_SECRET }
      }),
      readHistory(req.user.userId),
    ]);

    if (!dbResponse.ok) {
      const errText = await dbResponse.text();
      console.error(`[Card Storage] GET Database returned ${dbResponse.status}: ${errText}`);
      throw new Error(`Database returned ${dbResponse.status}`);
    }

    const dbCards = await dbResponse.json();

    const extFile = path.join(getUserDataDir(req.user.userId), "card_extensions.json");
    const extensions = await readJsonStore(extFile) || {};

    const translatedCards = dbCards.map(c => {
      const translated = translateDbCard(c);
      if (extensions[translated.id]) {
        translated.character.imagePrompt = extensions[translated.id].imagePrompt || "";
        translated.character.imageGuidance = extensions[translated.id].imageGuidance || "";
      }
      return translated;
    });
    res.json([...translatedCards, ...histItems]);
  } catch (e) {
    console.error("[Card Storage] GET /api/storage/cards Error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Individual card fetch — used by storage.getCard(id) when Load is clicked
app.get("/api/storage/cards/:id", requireAuth, async (req, res) => {
  const cardId = req.params.id;
  console.log(`[Card Storage] GET /:id → fetching card ${cardId} for user ${req.user.userId}`);

  // ── History card (non-permanent, stored locally) ────────────────────────
  if (String(cardId).startsWith("h_")) {
    try {
      const histItems = await readHistory(req.user.userId);
      const card = histItems.find(c => String(c.id) === String(cardId));
      if (!card) return res.status(404).json({ error: "History card not found" });
      const imgDir = path.join(getUserDataDir(req.user.userId), "card-images");
      const imgFile = path.join(imgDir, `${cardId}.img`);
      const mimeFile = path.join(imgDir, `${cardId}.mime`);
      const imageHistory = await loadCardHistoryImages(imgDir, cardId);
      if (fs.existsSync(imgFile) && fs.existsSync(mimeFile)) {
        const [imgBuf, mime] = await Promise.all([
          fsPromises.readFile(imgFile),
          fsPromises.readFile(mimeFile, "utf8"),
        ]);
        return res.json({ ...card, imageBase64: `data:${mime};base64,${imgBuf.toString("base64")}`, imageHistory });
      }
      return res.json({ ...card, imageHistory });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Permanent (DB) card ──────────────────────────────────────────────────
  try {
    const internalUrl = (process.env.STORY_APP_URL || "http://storywriterbackend:8000").replace(/\/$/, "");
    const response = await fetch(`${internalUrl}/api/cards/${cardId}`, {
      headers: { "X-User-Id": String(req.user.userId), "X-User-Name": String(req.user.username), "X-Internal-Secret": INTERNAL_API_SECRET }
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[Card Storage] GET /:id DB returned ${response.status}: ${errText}`);
      return res.status(response.status).json({ error: errText });
    }

    const translated = translateDbCard(await response.json());
    console.log(`[Card Storage] GET /:id translated card: name="${translated.characterName}", image_path="${translated.image_path}"`);

    const extFile = path.join(getUserDataDir(req.user.userId), "card_extensions.json");
    const extensions = await readJsonStore(extFile) || {};
    if (extensions[translated.id]) {
      translated.character.imagePrompt = extensions[translated.id].imagePrompt || "";
      translated.character.imageGuidance = extensions[translated.id].imageGuidance || "";
    }

    // ── Image resolution: three-tier lookup ──────────────────────────────────
    const imgDir = path.join(getUserDataDir(req.user.userId), "card-images");
    const imgFile = path.join(imgDir, `${cardId}.img`);
    const mimeFile = path.join(imgDir, `${cardId}.mime`);

    if (fs.existsSync(imgFile) && fs.existsSync(mimeFile)) {
      // Tier 1: proxy-local cached image (fastest, most common path)
      const [imgBuf, mime] = await Promise.all([
        fsPromises.readFile(imgFile),
        fsPromises.readFile(mimeFile, "utf8"),
      ]);
      translated.imageBase64 = `data:${mime};base64,${imgBuf.toString("base64")}`;
      console.log(`[Card Storage] GET /:id image loaded from local cache (${imgBuf.length} bytes)`);

    } else if (translated.image_path) {
      // Tier 2: image stored on storywriterbackend (e.g. uploaded via migration Path A)
      try {
        const imgUrl = `${internalUrl}/${translated.image_path.replace(/^\//, "")}`;
        console.log(`[Card Storage] GET /:id fetching image from backend: ${imgUrl}`);
        const imgRes = await fetch(imgUrl);
        if (imgRes.ok) {
          const imgBuf = Buffer.from(await imgRes.arrayBuffer());
          const mime = imgRes.headers.get("content-type") || "image/png";
          translated.imageBase64 = `data:${mime};base64,${imgBuf.toString("base64")}`;
          // Cache locally so future loads are instant
          if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });
          await Promise.all([
            fsPromises.writeFile(imgFile, imgBuf),
            fsPromises.writeFile(mimeFile, mime),
          ]);
          console.log(`[Card Storage] GET /:id image fetched from backend and cached (${imgBuf.length} bytes)`);
        } else {
          console.warn(`[Card Storage] GET /:id backend image fetch failed: ${imgRes.status}`);
        }
      } catch (imgErr) {
        console.warn(`[Card Storage] GET /:id image fetch error: ${imgErr.message}`);
      }

    } else {
      console.log(`[Card Storage] GET /:id no image found for card ${cardId}`);
    }

    // Load archived image history for this card
    translated.imageHistory = await loadCardHistoryImages(imgDir, cardId);

    res.json(translated);
  } catch (e) {
    console.error(`[Card Storage] GET /api/storage/cards/:id Error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/storage/cards", requireAuth, async (req, res) => {
  try {
    const record = req.body;
    // saveCardToLibrary wraps all data in a nested `character` object — unwrap it
    const char = record.character || record;
    const name = record.characterName || char.name || "Unnamed";

    // ── Non-permanent (history/auto-save) → flat file, skip DB ───────────────
    if (record.isPermanent === false) {
      const histId = `h_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const now = new Date().toISOString();
      const histCard = {
        id: histId,
        characterName: name,
        isPermanent: false,
        createdAt: record.createdAt || now,
        updatedAt: now,
        // Store the full character object so it can be loaded later
        character: typeof record.character === "object" && record.character ? record.character : char,
      };
      // Save portrait image locally (same mechanism as DB cards)
      const imageBase64 = record.imageBase64 || "";
      const imgDir = path.join(getUserDataDir(req.user.userId), "card-images");
      if (imageBase64.startsWith("data:")) {
        const match = imageBase64.match(/^data:([^;]+);base64,(.+)$/s);
        if (match) {
          if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });
          await Promise.all([
            fsPromises.writeFile(path.join(imgDir, `${histId}.img`), Buffer.from(match[2], "base64")),
            fsPromises.writeFile(path.join(imgDir, `${histId}.mime`), match[1]),
          ]);
        }
      }
      // Save archived image history alongside the portrait
      await saveCardHistoryImages(imgDir, histId, record.imageHistory);
      // Persist and trim oldest items if over the cap
      const histItems = await readHistory(req.user.userId);
      histItems.push(histCard);
      if (histItems.length > HISTORY_MAX) {
        const removed = histItems.splice(0, histItems.length - HISTORY_MAX);
        // Clean up portrait and history images for evicted entries
        for (const old of removed) {
          for (const ext of [".img", ".mime"]) {
            const f = path.join(imgDir, `${old.id}${ext}`);
            if (fs.existsSync(f)) fsPromises.unlink(f).catch(() => { });
          }
          deleteCardHistoryImages(imgDir, old.id);
        }
      }
      await writeHistory(req.user.userId, histItems);
      return res.json({ ...record, id: histId });
    }

    // ── Permanent → save to PostgreSQL database ───────────────────────────────
    const dbPayload = {
      name,
      description: char.description || "",
      personality: char.personality || "",
      scenario: char.scenario || "",
      first_mes: char.firstMessage || char.first_mes || "",
      mes_example: char.mesExample || char.mes_example || "",
      creatorcomment: char.creatorNotes || char.creatorcomment || "",
      tags: Array.isArray(char.tags) ? char.tags.join(",") : (char.tags || ""),
      creator: char.creator || "",
      character_version: char.character_version || "",
      alternate_greetings: Array.isArray(char.alternateGreetings) ? JSON.stringify(char.alternateGreetings) : (char.alternateGreetings || "[]"),
      system_prompt: char.system_prompt || "",
      post_history_instructions: char.post_history_instructions || "",
      character_book: typeof char.character_book === "object" && char.character_book
        ? JSON.stringify(char.character_book)
        : (char.character_book || ""),
      image_path: "",
    };

    const internalUrl = (process.env.STORY_APP_URL || "http://storywriterbackend:8000").replace(/\/$/, "");
    let url = `${internalUrl}/api/cards/`;
    let method = "POST";

    // Use PUT if the record has a numeric DB ID (not a legacy Date.now() string)
    const recordId = record.id;
    if (recordId !== undefined && recordId !== null && Number.isInteger(Number(recordId)) && !isNaN(Number(recordId)) && String(recordId).length < 13) {
      url = `${internalUrl}/api/cards/${record.id}`;
      method = "PUT";
    }

    const response = await fetch(url, {
      method: method,
      headers: {
        "Content-Type": "application/json",
        "X-User-Id": String(req.user.userId),
        "X-User-Name": String(req.user.username),
        "X-Internal-Secret": INTERNAL_API_SECRET
      },
      body: JSON.stringify(dbPayload)
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[Card Storage] POST/PUT Database returned ${response.status}: ${errText}`);
      throw new Error(`Database returned ${response.status}`);
    }

    const dbCard = await response.json();

    // Save portrait image to proxy filesystem keyed by card DB id
    const imageBase64 = record.imageBase64 || "";
    const permImgDir = path.join(getUserDataDir(req.user.userId), "card-images");
    if (imageBase64.startsWith("data:")) {
      const match = imageBase64.match(/^data:([^;]+);base64,(.+)$/s);
      if (match) {
        if (!fs.existsSync(permImgDir)) fs.mkdirSync(permImgDir, { recursive: true });
        await Promise.all([
          fsPromises.writeFile(path.join(permImgDir, `${dbCard.id}.img`), Buffer.from(match[2], "base64")),
          fsPromises.writeFile(path.join(permImgDir, `${dbCard.id}.mime`), match[1]),
        ]);
      }
    }
    // Save archived image history alongside the portrait
    await saveCardHistoryImages(permImgDir, dbCard.id, record.imageHistory);

    const extFile = path.join(getUserDataDir(req.user.userId), "card_extensions.json");
    await withFileLock(`user-${req.user.userId}-ext`, async () => {
      const extensions = await readJsonStore(extFile) || {};
      extensions[dbCard.id] = {
        imagePrompt: char.imagePrompt || "",
        imageGuidance: char.imageGuidance || ""
      };
      await writeJsonStore(extFile, extensions);
    });

    res.json({ ...record, id: dbCard.id });
  } catch (e) {
    console.error("[Card Storage] POST /api/storage/cards Error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/storage/cards/:id", requireAuth, async (req, res) => {
  const cardId = req.params.id;
  const imgDir = path.join(getUserDataDir(req.user.userId), "card-images");

  // ── History card (stored locally) ─────────────────────────────────────────
  if (String(cardId).startsWith("h_")) {
    try {
      const histItems = await readHistory(req.user.userId);
      await writeHistory(req.user.userId, histItems.filter(c => String(c.id) !== String(cardId)));
      for (const ext of [".img", ".mime"]) {
        const f = path.join(imgDir, `${cardId}${ext}`);
        if (fs.existsSync(f)) fsPromises.unlink(f).catch(() => { });
      }
      deleteCardHistoryImages(imgDir, cardId);
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Permanent (DB) card ────────────────────────────────────────────────────
  try {
    const internalUrl = (process.env.STORY_APP_URL || "http://storywriterbackend:8000").replace(/\/$/, "");
    const response = await fetch(`${internalUrl}/api/cards/${cardId}`, {
      method: "DELETE",
      headers: { "X-User-Id": String(req.user.userId), "X-User-Name": String(req.user.username), "X-Internal-Secret": INTERNAL_API_SECRET }
    });
    if (!response.ok) throw new Error("Failed to delete card from database");
    deleteCardHistoryImages(imgDir, cardId);
    deleteCardGalleryImages(imgDir, cardId);
    for (const ext of [".img", ".mime"]) {
      const f = path.join(imgDir, `${cardId}${ext}`);
      if (fs.existsSync(f)) fsPromises.unlink(f).catch(() => { });
    }

    const extFile = path.join(getUserDataDir(req.user.userId), "card_extensions.json");
    await withFileLock(`user-${req.user.userId}-ext`, async () => {
      const extensions = await readJsonStore(extFile) || {};
      if (extensions[cardId]) {
        delete extensions[cardId];
        await writeJsonStore(extFile, extensions);
      }
    });

    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Character gallery (extra linked images, separate from the single portrait) ──

function galleryInternalHeaders(req) {
  return {
    "Content-Type": "application/json",
    "X-User-Id": String(req.user.userId),
    "X-User-Name": String(req.user.username),
    "X-Internal-Secret": INTERNAL_API_SECRET,
  };
}

app.get("/api/storage/cards/:id/gallery", requireAuth, async (req, res) => {
  const cardId = req.params.id;
  try {
    const internalUrl = (process.env.STORY_APP_URL || "http://storywriterbackend:8000").replace(/\/$/, "");
    const response = await fetch(`${internalUrl}/api/cards/${cardId}/gallery`, { headers: galleryInternalHeaders(req) });
    if (!response.ok) throw new Error(`Database returned ${response.status}`);
    const rows = await response.json();
    const images = rows.map((row) => ({
      id: row.id,
      order: row.order_index,
      url: `/api/storage/cards/${cardId}/gallery/${row.id}/image`,
    }));
    res.json(images);
  } catch (e) {
    console.error("[Gallery] GET Error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/storage/cards/:id/gallery", requireAuth, async (req, res) => {
  const cardId = req.params.id;
  const imageBase64 = req.body?.imageBase64 || "";
  const match = imageBase64.match(/^data:([^;]+);base64,(.+)$/s);
  if (!match) {
    return res.status(400).json({ error: "imageBase64 must be a data: URL" });
  }
  try {
    const internalUrl = (process.env.STORY_APP_URL || "http://storywriterbackend:8000").replace(/\/$/, "");
    const response = await fetch(`${internalUrl}/api/cards/${cardId}/gallery`, {
      method: "POST",
      headers: galleryInternalHeaders(req),
    });
    if (!response.ok) throw new Error(`Database returned ${response.status}`);
    const row = await response.json();

    const imgDir = path.join(getUserDataDir(req.user.userId), "card-images");
    if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });
    await Promise.all([
      fsPromises.writeFile(path.join(imgDir, `${cardId}_gallery_${row.id}.img`), Buffer.from(match[2], "base64")),
      fsPromises.writeFile(path.join(imgDir, `${cardId}_gallery_${row.id}.mime`), match[1]),
    ]);

    res.json({ id: row.id, order: row.order_index, url: `/api/storage/cards/${cardId}/gallery/${row.id}/image` });
  } catch (e) {
    console.error("[Gallery] POST Error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.put("/api/storage/cards/:id/gallery/reorder", requireAuth, async (req, res) => {
  const cardId = req.params.id;
  try {
    const internalUrl = (process.env.STORY_APP_URL || "http://storywriterbackend:8000").replace(/\/$/, "");
    const response = await fetch(`${internalUrl}/api/cards/${cardId}/gallery/reorder`, {
      method: "PUT",
      headers: galleryInternalHeaders(req),
      body: JSON.stringify({ ordered_ids: req.body?.orderedIds || [] }),
    });
    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: errText });
    }
    res.json({ success: true });
  } catch (e) {
    console.error("[Gallery] Reorder Error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/storage/cards/:id/gallery/:galleryId", requireAuth, async (req, res) => {
  const { id: cardId, galleryId } = req.params;
  try {
    const internalUrl = (process.env.STORY_APP_URL || "http://storywriterbackend:8000").replace(/\/$/, "");
    const response = await fetch(`${internalUrl}/api/cards/${cardId}/gallery/${galleryId}`, {
      method: "DELETE",
      headers: galleryInternalHeaders(req),
    });
    if (!response.ok) throw new Error(`Database returned ${response.status}`);

    const imgDir = path.join(getUserDataDir(req.user.userId), "card-images");
    await deleteCardGalleryImages(imgDir, cardId, galleryId);

    res.json({ success: true });
  } catch (e) {
    console.error("[Gallery] DELETE Error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/storage/cards/:id/gallery/:galleryId/image", requireAuth, async (req, res) => {
  const { id: cardId, galleryId } = req.params;
  const imgDir = path.join(getUserDataDir(req.user.userId), "card-images");
  const imgFile = path.join(imgDir, `${cardId}_gallery_${galleryId}.img`);
  const mimeFile = path.join(imgDir, `${cardId}_gallery_${galleryId}.mime`);

  if (!fs.existsSync(imgFile) || !fs.existsSync(mimeFile)) {
    return res.status(404).end();
  }
  try {
    const [imgBuf, mime] = await Promise.all([
      fsPromises.readFile(imgFile),
      fsPromises.readFile(mimeFile, "utf8"),
    ]);
    res.setHeader("Content-Type", mime);
    res.setHeader("Cache-Control", "public, max-age=300");
    res.send(imgBuf);
  } catch (error) {
    console.error("[Gallery] Image serve error:", error);
    res.status(500).end();
  }
});

// ── Migrate JSON configuration files to PostgreSQL (Config, Prompts, History, etc.) ─
app.post("/api/storage/migrate-all", requireAuth, async (req, res) => {
  const dir = getUserDataDir(req.user.userId);
  const filesToMigrate = ["config.json", "prompts.json", "history.json"];
  let results = { migrated: [], errors: [] };

  const internalUrl = (process.env.STORY_APP_URL || "http://storywriterbackend:8000").replace(/\/$/, "");
  const headers = {
    "Content-Type": "application/json",
    "X-User-Id": String(req.user.userId),
    "X-User-Name": String(req.user.username),
    "X-Internal-Secret": INTERNAL_API_SECRET
  };

  for (const file of filesToMigrate) {
    const filePath = path.join(dir, file);
    if (!fs.existsSync(filePath)) continue;

    try {
      const content = await fsPromises.readFile(filePath, "utf8");
      const parsed = JSON.parse(content);
      let itemsToPush = [];
      let endpoint = "";

      if (file === "config.json") {
        endpoint = "config";
        await fetch(`${internalUrl}/api/proxy-data/${endpoint}`, {
          method: "POST", headers, body: JSON.stringify({ config_data: parsed })
        });
      } else if (file === "prompts.json") {
        endpoint = "prompts";
        itemsToPush = Array.isArray(parsed) ? parsed : [];
      } else if (file === "history.json") {
        endpoint = "history";
        itemsToPush = Array.isArray(parsed) ? parsed : [];
      }

      if (itemsToPush.length > 0) {
        for (const item of itemsToPush) {
          await fetch(`${internalUrl}/api/proxy-data/${endpoint}`, {
            method: "POST", headers, body: JSON.stringify({ id: String(item.id || Date.now()), data: item })
          });
        }
      }

      // Rename to avoid migrating again
      await fsPromises.rename(filePath, `${filePath}.migrated`);
      results.migrated.push(file);
    } catch (e) {
      console.error(`Migration failed for ${file}:`, e);
      results.errors.push({ file, error: e.message });
    }
  }

  res.json(results);
});

// ── Migrate cards from legacy cards.json to PostgreSQL ───────────────────────
// ?purge=true  → delete all existing DB cards for this user before migrating
app.post("/api/storage/migrate-cards", requireAuth, async (req, res) => {
  const storeFile = path.join(getUserDataDir(req.user.userId), "cards.json");

  if (!fs.existsSync(storeFile)) {
    return res.json({ total: 0, migrated: 0, skipped: 0, errors: [], message: "No cards.json found — nothing to migrate." });
  }

  let cards;
  try {
    cards = await readJsonStore(storeFile);
  } catch (e) {
    return res.status(500).json({ error: "Failed to read cards.json: " + e.message });
  }

  if (!Array.isArray(cards) || cards.length === 0) {
    return res.json({ total: 0, migrated: 0, skipped: 0, errors: [], message: "cards.json is empty." });
  }

  const internalUrl = (process.env.STORY_APP_URL || "http://storywriterbackend:8000").replace(/\/$/, "");
  const internalHeaders = {
    "X-User-Id": String(req.user.userId),
    "X-User-Name": String(req.user.username),
    "X-Internal-Secret": INTERNAL_API_SECRET,
  };

  // ── Optional purge: wipe existing DB cards + local cached images first ──────
  if (req.query.purge === "true") {
    console.log(`[Migration] Purging existing cards for user ${req.user.userId}`);
    try {
      const listRes = await fetch(`${internalUrl}/api/cards/`, { headers: internalHeaders });
      if (listRes.ok) {
        const existing = await listRes.json();
        for (const ec of existing) {
          await fetch(`${internalUrl}/api/cards/${ec.id}`, { method: "DELETE", headers: internalHeaders }).catch(() => { });
          const ecImgDir = path.join(getUserDataDir(req.user.userId), "card-images");
          for (const ext of [".img", ".mime"]) {
            const f = path.join(ecImgDir, `${ec.id}${ext}`);
            if (fs.existsSync(f)) await fsPromises.unlink(f).catch(() => { });
          }
        }
        console.log(`[Migration] Purged ${existing.length} existing cards`);
      }
    } catch (e) {
      console.error(`[Migration] Purge error: ${e.message}`);
    }
  }

  let migrated = 0, skipped = 0;
  const errors = [];
  const imgDir = path.join(getUserDataDir(req.user.userId), "card-images");

  // Helper: write imageBase64 to proxy card-images keyed by DB card id
  async function cacheImage(dbId, imageBase64) {
    if (!imageBase64 || !imageBase64.startsWith("data:")) return;
    const m = imageBase64.match(/^data:([^;]+);base64,(.+)$/s);
    if (!m) return;
    try {
      if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });
      await Promise.all([
        fsPromises.writeFile(path.join(imgDir, `${dbId}.img`), Buffer.from(m[2], "base64")),
        fsPromises.writeFile(path.join(imgDir, `${dbId}.mime`), m[1]),
      ]);
      console.log(`[Migration] Cached image for DB card ${dbId}`);
    } catch (e) {
      console.warn(`[Migration] Image cache failed for DB card ${dbId}: ${e.message}`);
    }
  }

  for (const card of cards) {
    // Old cards.json format: { characterName, character: {name, description,...}, imageBase64, isPermanent }
    // Fields live under card.character — unwrap it
    const ch = card.character || card;
    const cardName = card.characterName || ch.name || "Unnamed";
    console.log(`[Migration] Processing: "${cardName}" (has image: ${!!(card.imageBase64 || card.image_base64)})`);

    try {
      let saved = false;
      const imageBase64 = card.imageBase64 || card.image_base64 || "";

      // ── Path A: PNG with embedded chara spec — let the backend parse it ─────
      if (imageBase64.startsWith("data:")) {
        const match = imageBase64.match(/^data:([^;]+);base64,(.+)$/s);
        if (match) {
          const mimeType = match[1];
          const imageBuffer = Buffer.from(match[2], "base64");
          const filename = `${cardName.replace(/[^a-zA-Z0-9_-]/g, "_")}.png`;
          const boundary = `----CardMigration${Date.now()}${Math.random().toString(36).slice(2)}`;
          const partHeader = Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`
          );
          const partFooter = Buffer.from(`\r\n--${boundary}--\r\n`);
          const body = Buffer.concat([partHeader, imageBuffer, partFooter]);

          const uploadRes = await fetch(`${internalUrl}/api/cards/upload`, {
            method: "POST",
            headers: {
              ...internalHeaders,
              "Content-Type": `multipart/form-data; boundary=${boundary}`,
              "Content-Length": String(body.length),
            },
            body,
          });

          if (uploadRes.ok) {
            const created = await uploadRes.json();
            await cacheImage(created.id, imageBase64);
            migrated++;
            saved = true;
            console.log(`[Migration] Path A success: "${cardName}" → DB id ${created.id}`);
          } else {
            const errText = await uploadRes.text();
            console.warn(`[Migration] Path A failed for "${cardName}" (${uploadRes.status}): ${errText} — trying Path B`);
          }
        }
      }

      // ── Path B: text fields create + separately cache image ─────────────────
      if (!saved) {
        const dbPayload = {
          name: cardName,
          description: ch.description || "",
          personality: ch.personality || "",
          scenario: ch.scenario || "",
          first_mes: ch.firstMessage || ch.first_mes || "",
          mes_example: ch.mesExample || ch.mes_example || "",
          creatorcomment: ch.creatorNotes || ch.creatorcomment || "",
          tags: Array.isArray(ch.tags) ? ch.tags.join(",") : (ch.tags || ""),
          creator: ch.creator || "",
          character_version: ch.character_version || "",
          alternate_greetings: Array.isArray(ch.alternateGreetings)
            ? JSON.stringify(ch.alternateGreetings)
            : (ch.alternateGreetings || "[]"),
          system_prompt: ch.system_prompt || "",
          post_history_instructions: ch.post_history_instructions || "",
          character_book: typeof ch.character_book === "object" && ch.character_book
            ? JSON.stringify(ch.character_book)
            : (ch.character_book || ""),
          image_path: "",
        };

        console.log(`[Migration] Path B: "${cardName}" description="${dbPayload.description.slice(0, 50)}"`);

        const createRes = await fetch(`${internalUrl}/api/cards/`, {
          method: "POST",
          headers: { ...internalHeaders, "Content-Type": "application/json" },
          body: JSON.stringify(dbPayload),
        });

        if (createRes.ok) {
          const created = await createRes.json();
          await cacheImage(created.id, imageBase64);
          migrated++;
          console.log(`[Migration] Path B success: "${cardName}" → DB id ${created.id}`);
        } else {
          skipped++;
          const errText = await createRes.text();
          errors.push(`"${cardName}": ${errText}`);
          console.error(`[Migration] Path B failed for "${cardName}": ${errText}`);
        }
      }
    } catch (e) {
      skipped++;
      errors.push(`"${cardName}": ${e.message}`);
      console.error(`[Migration] Exception for "${cardName}": ${e.message}`);
    }
  }

  console.log(`[Migration] Done — user ${req.user.userId}: ${migrated}/${cards.length} migrated, ${skipped} failed`);
  res.json({ total: cards.length, migrated, skipped, errors });
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ── Story Writer availability check ──────────────────────────────────────────
// Probes the JoeAnory backend container-to-container over the shared Docker
// network.  Returns the public URL for the browser tab if reachable.
// requireAuth: only authenticated users need to know if the Story Writer is available.
// The internal container URL is never returned to the client — only the public URL (if set).
app.get("/api/story-app/status", requireAuth, async (req, res) => {
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
      // Return publicUrl if configured; omit the field entirely if not (never expose internal URL).
      const result = { available: true };
      if (publicUrl) result.url = publicUrl;
      console.log(`Story Writer connection check: Success! Returning: ${JSON.stringify(result)}`);
      return res.json(result);
    }
    const errorText = await response.text();
    console.log(`Story Writer connection check: Response not ok. Body: ${errorText}`);
    return res.json({ available: false });
  } catch (err) {
    console.error("Story Writer connection check: Network error or timeout:", err.message);
    return res.json({ available: false });
  }
});

// ── Story Writer Backend Proxy ───────────────────────────────────────────────
app.all("/api/sw/*", requireAuth, async (req, res) => {
  const internalUrl = (process.env.STORY_APP_URL || "http://storywriterbackend:8000").replace(/\/$/, "");
  // Strip /api/sw from the browser path, then prepend /api since FastAPI mounts all routers under /api
  const targetPath = "/api" + req.originalUrl.replace("/api/sw", "");
  const targetUrl = internalUrl + targetPath;

  try {
    const fetchOptions = {
      method: req.method,
      headers: {
        "Content-Type": req.headers["content-type"] || "application/json",
        "X-User-Id": String(req.user.userId),
        "X-User-Name": String(req.user.username),
        "X-Internal-Secret": INTERNAL_API_SECRET
      }
    };

    // Only pass bodies for methods that allow them
    if (["POST", "PUT", "PATCH"].includes(req.method) && req.body && Object.keys(req.body).length > 0) {
      fetchOptions.body = JSON.stringify(req.body);
    }

    const response = await fetch(targetUrl, fetchOptions);

    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      // node-fetch v2 returns a Node.js PassThrough stream — pipe it directly
      response.body.pipe(res);
      return;
    }

    const text = await response.text();
    // The StoryWriter backend rejecting an internal call is not the browser's
    // session expiring — relaying its 401 verbatim would log the user out.
    res.status(upstreamFailureStatus(response.status)).send(text);
  } catch (error) { res.status(500).json({ error: "StoryWriter backend unreachable: " + error.message }); }
});

app.get("/api/tts/voices", async (req, res) => {
  try {
    const provider = req.query.provider;
    
    if (provider === "kokoro") {
      const kokoroVoices = [
        "af_heart", "af_alloy", "af_aoede", "af_bella", "af_jessica", "af_kore", "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
        "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael", "am_onyx", "am_puck", "am_santa",
        "bf_alice", "bf_emma", "bf_isabella", "bf_lily", "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
        "jf_alpha", "jf_gongitsune", "jf_nezumi", "jf_tebukuro", "jm_kumo",
        "zf_xiaobei", "zf_xiaoni", "zf_xiaoxiao", "zf_xiaoyi", "zm_yunjian", "zm_yunxi", "zm_yunxia", "zm_yunyang",
        "ef_dora", "em_alex", "em_santa", "ff_siwis", "hf_alpha", "hf_beta", "hm_omega", "hm_psi",
        "if_sara", "im_nicola", "pf_dora", "pm_alex", "pm_santa"
      ];
      return res.json({ status: "ready", speakers: kokoroVoices });
    }

    res.json({ status: "ready", speakers: [] });
  } catch (error) {
    res.status(503).json({ status: "error", error: error.message, speakers: [] });
  }
});

app.post("/api/tts/synthesize", async (req, res) => {
  try {
    const { text, voice, speed, provider, googleApiKey, nanogptKey, nanogptModel, nanogptVoice } = req.body;
    console.log(`[Proxy] /api/tts/synthesize called. Provider: ${provider}, Voice requested: ${voice}`);

    // Branch: Kokoro TTS
    if (provider === "kokoro") {
      const kokoroUrl = (process.env.KOKORO_TTS_URL || "http://kokoro-tts:8880").replace(/\/$/, "");
      const requestUrl = `${kokoroUrl}/v1/audio/speech`;
      
      const response = await fetch(requestUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "kokoro",
          input: text,
          voice: voice || "af_heart",
          response_format: "wav",
          speed: speed || 1.0
        })
      });

      if (!response.ok) {
        const errData = await response.text();
        return res.status(upstreamFailureStatus(response.status))
          .send(`Kokoro TTS Error (${response.status}): ${errData}`);
      }

      res.setHeader("Content-Type", "audio/wav");
      res.setHeader("Cache-Control", "no-cache");
      
      // Attempt to copy the duration header if available, but kokoro server might not provide it.
      // Usually standard OpenAI APIs don't provide x-tts-duration-seconds.
      const duration = response.headers.get("x-tts-duration-seconds");
      if (duration) {
        res.setHeader("X-TTS-Duration-Seconds", duration);
      }
      
      response.body.pipe(res);
      return;
    }

    // Branch: Nano-GPT TTS
    if (provider === "nanogpt") {
      const modelName = nanogptModel || "tts-1";
      const isStandardModel = modelName.startsWith("tts-") || modelName.startsWith("openai/");

      if (isStandardModel) {
        // Standard OpenAI-compatible endpoint
        const requestUrl = "https://api.nano-gpt.com/v1/audio/speech";
        const headers = { "Content-Type": "application/json" };
        if (nanogptKey) {
          headers["Authorization"] = `Bearer ${nanogptKey}`;
        }

        const response = await fetch(requestUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: modelName,
            input: text,
            voice: nanogptVoice || "alloy",
            response_format: "mp3",
            speed: speed || 1.0
          }),
        });

        if (!response.ok) {
          const errData = await response.text();
          return res.status(upstreamFailureStatus(response.status))
            .send(`Nano-GPT TTS Error (${response.status}): ${errData}`);
        }

        res.setHeader("Content-Type", "audio/mpeg");
        res.setHeader("Cache-Control", "no-cache");
        response.body.pipe(res);
        return;
      } else {
        // Proprietary Nano-GPT endpoint (for Kokoro, ElevenLabs, etc.)
        const requestUrl = "https://nano-gpt.com/api/tts";
        const headers = { "Content-Type": "application/json" };
        if (nanogptKey) {
          headers["x-api-key"] = nanogptKey;
        }

        const response = await fetch(requestUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({
            text: text,
            model: modelName,
            voice: nanogptVoice || "af_bella",
            speed: speed || 1.0
          }),
        });

        if (!response.ok) {
          const errData = await response.text();
          return res.status(upstreamFailureStatus(response.status))
            .send(`Nano-GPT Custom TTS Error (${response.status}): ${errData}`);
        }

        const contentType = response.headers.get('content-type') || "";
        
        if (contentType.includes("application/json")) {
          let data = await response.json();
          
          // If the job is pending, we must poll for completion
          if (data.status === "pending" && data.runId) {
            let maxAttempts = 60;
            while (data.status !== "completed" && maxAttempts > 0) {
              if (data.status === "error") {
                return res.status(500).send(`Nano-GPT Custom TTS Generation Failed: ${data.error || 'Unknown error'}`);
              }
              
              await new Promise(resolve => setTimeout(resolve, 3000));
              const qs = new URLSearchParams({ runId: data.runId, model: modelName });
              const pollRes = await fetch(`https://nano-gpt.com/api/tts/status?${qs.toString()}`, {
                headers: { 'x-api-key': nanogptKey }
              });
              
              if (!pollRes.ok) {
                const errText = await pollRes.text();
                return res.status(pollRes.status).send(`Nano-GPT Polling Failed: ${errText}`);
              }
              data = await pollRes.json();
              maxAttempts--;
            }
            if (data.status !== "completed") {
              return res.status(500).send("Nano-GPT Custom TTS Polling Timeout.");
            }
          }

          if (data.audioUrl) {
            // Fetch the actual audio file
            const audioRes = await fetch(data.audioUrl);
            if (!audioRes.ok) {
              return res.status(audioRes.status).send(`Nano-GPT Audio Fetch Error: ${audioRes.statusText}`);
            }
            res.setHeader("Content-Type", "audio/mpeg");
            res.setHeader("Cache-Control", "no-cache");
            audioRes.body.pipe(res);
            return;
          } else {
            return res.status(500).json({ error: "No audioUrl returned from Nano-GPT", data });
          }
        } else {
          // Binary audio directly returned
          res.setHeader("Content-Type", "audio/mpeg");
          res.setHeader("Cache-Control", "no-cache");
          response.body.pipe(res);
          return;
        }
      }
    }

    // Branch: Google Cloud TTS
    if (provider && provider.startsWith("google")) {
      if (!googleApiKey) {
        return res.status(401).json({ error: "Google API key is required for Google TTS" });
      }

      const googleUrl = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${googleApiKey}`;
      const languageCode = voice.substring(0, 5) || "en-US"; // e.g., extract 'en-US' from 'en-US-Neural2-F'

      const response = await fetch(googleUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: { text },
          voice: { name: voice, languageCode: languageCode },
          audioConfig: { audioEncoding: "LINEAR16", speakingRate: speed || 1.0 }
        }),
      });

      if (!response.ok) {
        const errData = await response.text();
        return res.status(upstreamFailureStatus(response.status))
          .send(`Google TTS Error (${response.status}): ${errData}`);
      }

      const data = await response.json();
      // Google returns base64 encoded audio in the 'audioContent' field
      const audioBuffer = Buffer.from(data.audioContent, 'base64');
      res.setHeader("Content-Type", "audio/wav");
      res.setHeader("Cache-Control", "no-cache");
      return res.send(audioBuffer);
    }

    return res.status(400).json({ error: "Invalid or unsupported TTS provider selected." });
  } catch (error) {
    res.status(503).json({ error: "TTS service unreachable: " + error.message });
  }
});

// Fetch Google Voices
app.get("/api/tts/google-voices", async (req, res) => {
  try {
    const apiKey = req.query.key;
    const tier = req.query.tier || 'premium';
    if (!apiKey) return res.status(401).json({ error: "API Key required" });

    const response = await fetch(`https://texttospeech.googleapis.com/v1/voices?key=${apiKey}`);
    if (!response.ok) {
      return res.status(upstreamFailureStatus(response.status))
      .json({ error: `Failed to fetch Google voices (upstream ${response.status})` });
    }

    const data = await response.json();
    // Filter to only include English voices based on tier to keep the list clean
    let voices = [];
    if (tier === 'standard') {
      voices = data.voices
        .filter(v => v.languageCodes[0].startsWith("en-") && v.name.includes("Standard"))
        .map(v => v.name)
        .sort();
    } else {
      voices = data.voices
        .filter(v => v.languageCodes[0].startsWith("en-") && (v.name.includes("Neural2") || v.name.includes("Wavenet")))
        .map(v => v.name)
        .sort();
    }

    res.json({ status: "ready", speakers: voices });
  } catch (error) {
    res.status(503).json({ error: "Failed to fetch voices: " + error.message });
  }
});


// Sampling / formatting parameters forwarded verbatim to the upstream text API
// when the caller supplies them. Previously only model/messages/max_tokens/
// temperature/stream were forwarded, so anything else was silently discarded —
// notably `response_format: {type:"json_object"}`, which several callers send
// believing they get API-level JSON enforcement.
const TEXT_PASSTHROUGH_PARAMS = [
  "top_p",
  "top_k",
  "min_p",
  "typical_p",
  "repetition_penalty",
  "frequency_penalty",
  "presence_penalty",
  "seed",
  "stop",
  "logit_bias",
  "response_format",
  "reasoning_effort",
];

// Nucleus-sampling default. Without it the provider default of 1.0 applies,
// leaving the whole vocabulary tail reachable — at higher temperatures a single
// junk token derails everything generated after it, because the model then
// writes conditioned on that token. Callers may override by sending their own.
const DEFAULT_TEXT_TOP_P = 0.95;

// Upper bound on a single upstream text generation. Streaming replies with
// long reasoning can legitimately run for minutes, so this is deliberately
// generous — it exists to stop a black-holed connection hanging forever.
const TEXT_UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;

// ── Resumable generation jobs ────────────────────────────────────────────────
//
// A CardGen generation is a single streaming HTTP request with nothing
// persisted anywhere. When an iPhone locks, iOS tears the socket down and the
// in-flight character is unrecoverable — the tokens are spent and the result is
// gone. Roleplay Chat, Story Writer and Adventure avoid this because the Python
// backend detaches generation from the response and commits to Postgres.
//
// This gives CardGen the equivalent without moving it onto that backend: when a
// request opts in with `resumable: true`, the upstream read loop writes into a
// job buffer *unconditionally* and forwarding to the client becomes best-effort.
// A client that comes back can replay from a byte it has not seen yet.
//
// Deliberately in-memory: a generation lasts under a minute, so a proxy restart
// mid-flight is rare and acceptable (the client treats it as an eviction).

const { randomUUID } = require("crypto");
const { StringDecoder } = require("string_decoder");

const envInt = (name, fallback) => {
  const raw = process.env[name];
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// Overridable so retention can be tuned in production without a code change,
// and so the bounds are testable without waiting out minute-long timers.
const JOB_LIMITS = {
  // "Generate 4" uses four at once; this leaves headroom without letting a
  // runaway client pin unbounded memory.
  MAX_RUNNING_PER_USER: envInt("JOB_MAX_RUNNING_PER_USER", 8),
  // A character card is ~10 KB. This is a runaway guard, not a working limit.
  MAX_CONTENT_CHARS: envInt("JOB_MAX_CONTENT_CHARS", 1024 * 1024),
  // Long enough for a phone left locked for a while.
  RETENTION_MS: envInt("JOB_RETENTION_MS", 10 * 60 * 1000),
  // Slack over the 10-minute upstream timeout.
  MAX_RUN_MS: envInt("JOB_MAX_RUN_MS", 20 * 60 * 1000),
  SWEEP_INTERVAL_MS: envInt("JOB_SWEEP_INTERVAL_MS", 60 * 1000),
};

/** jobId -> job record */
const generationJobs = new Map();

function jobIsExpired(job, now = Date.now()) {
  if (job.status === "running") return now - job.createdAt > JOB_LIMITS.MAX_RUN_MS;
  return now - (job.completedAt || job.createdAt) > JOB_LIMITS.RETENTION_MS;
}

function countRunningJobsForUser(userId) {
  let n = 0;
  for (const job of generationJobs.values()) {
    if (job.userId === userId && job.status === "running" && !jobIsExpired(job)) n++;
  }
  return n;
}

/**
 * `clientRef` is an id the browser generates *before* sending the request. It
 * exists because the server-assigned id arrives in the first SSE frame, which
 * is too late if the socket dies during the initial upstream wait — the job
 * would be running and billing with the client unable to name it. Lookup is
 * always scoped to the authenticated user, so a guessed ref reveals nothing.
 */
function createGenerationJob(userId, abortController, clientRef = null) {
  const job = {
    id: randomUUID(),
    clientRef: typeof clientRef === "string" ? clientRef.slice(0, 100) : null,
    userId,
    status: "running",
    content: "",
    result: null, // full upstream JSON, for non-streaming jobs
    finishReason: null,
    error: null,
    createdAt: Date.now(),
    completedAt: null,
    subscribers: 1, // the request that created it is already attached
    listeners: new Set(), // fn(event) for clients tailing this job live
    abort: abortController,
  };
  generationJobs.set(job.id, job);
  return job;
}

function emitToJobListeners(job, event) {
  for (const listener of job.listeners) {
    try {
      listener(event);
    } catch (err) {
      console.error("[jobs] listener failed:", err.message);
    }
  }
}

/** Append assembled text, enforcing the per-job cap. Returns false if capped. */
function appendJobContent(job, text) {
  if (job.status !== "running" || !text) return true;

  if (job.content.length + text.length > JOB_LIMITS.MAX_CONTENT_CHARS) {
    finishGenerationJob(job, "error", {
      error: `Generation exceeded the ${JOB_LIMITS.MAX_CONTENT_CHARS} character buffer limit`,
    });
    if (job.abort && !job.abort.signal.aborted) job.abort.abort();
    return false;
  }

  job.content += text;
  emitToJobListeners(job, { type: "delta", text });
  return true;
}

function finishGenerationJob(job, status, { finishReason, error } = {}) {
  if (job.status !== "running") return; // already terminal — first result wins
  job.status = status;
  job.completedAt = Date.now();
  if (finishReason) job.finishReason = finishReason;
  if (error) job.error = error;
  emitToJobListeners(job, {
    type: status === "error" ? "error" : "done",
    finishReason: job.finishReason,
    error: job.error,
  });
  job.listeners.clear();
}

/**
 * Incremental SSE parser that pulls assembled text out of the provider's
 * stream. The proxy was previously a dumb byte pipe; buffering by *assembled
 * content* rather than raw bytes is what lets a resume offset survive differing
 * chunk boundaries between the original stream and the replayed one.
 */
function makeSseContentExtractor({ onContent, onFinishReason }) {
  let buffer = "";
  // Multi-byte UTF-8 characters can straddle a chunk boundary; decoding each
  // chunk independently would corrupt them.
  const decoder = new StringDecoder("utf8");

  return function feed(chunk) {
    buffer += decoder.write(chunk);
    const lines = buffer.split("\n");
    buffer = lines.pop() || ""; // keep the incomplete trailing line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      let payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") continue;
      // Some providers double-wrap: "data: data: {...}"
      if (payload.startsWith("data:")) payload = payload.slice(5).trim();

      try {
        const parsed = JSON.parse(payload);
        const content = parsed.choices?.[0]?.delta?.content;
        if (content) onContent(content);
        const reason = parsed.choices?.[0]?.finish_reason;
        if (reason) onFinishReason(reason);
      } catch (_) {
        /* keep-alive comments and non-JSON frames are not errors */
      }
    }
  };
}

/** SSE frames shaped like the provider's, so the client parser needs no changes. */
function sseDeltaFrame(text) {
  return `data: ${JSON.stringify({
    choices: [{ index: 0, delta: { content: text } }],
  })}\n\n`;
}

function sseFinishFrame(finishReason) {
  return `data: ${JSON.stringify({
    choices: [{ index: 0, delta: {}, finish_reason: finishReason || "stop" }],
  })}\n\n`;
}

function sseErrorFrame(message) {
  return `data: ${JSON.stringify({ error: { message } })}\n\n`;
}

const jobSweeper = setInterval(() => {
  const now = Date.now();
  for (const [id, job] of generationJobs) {
    if (!jobIsExpired(job, now)) continue;
    if (job.status === "running") {
      // Blew the hard cap on running duration — stop billing for it.
      console.warn(`[jobs] hard-capping runaway job ${id}`);
      finishGenerationJob(job, "error", { error: "Generation exceeded the maximum run time" });
      if (job.abort && !job.abort.signal.aborted) job.abort.abort();
      continue; // keep the terminal record around for its retention window
    }
    generationJobs.delete(id);
  }
}, JOB_LIMITS.SWEEP_INTERVAL_MS);
// Don't hold the event loop open on shutdown.
if (jobSweeper.unref) jobSweeper.unref();

/**
 * Resume a generation, replaying everything after `from` and then tailing live.
 * `from` is a character count of assembled content, not a chunk index.
 */
app.get("/api/text/jobs/:jobId/stream", requireAuth, (req, res) => {
  const job = generationJobs.get(req.params.jobId);

  if (!job || jobIsExpired(job)) {
    return res.status(404).json({
      error: { code: "404", message: "Job not found or expired" },
    });
  }
  if (job.userId !== req.user.userId) {
    return res.status(403).json({
      error: { code: "403", message: "Job belongs to another user" },
    });
  }

  const from = Math.max(0, parseInt(req.query.from, 10) || 0);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  // SSE needs unbuffered proxying; streaming already works through NPM, but the
  // resume endpoint is new and should not rely on that config being inherited.
  res.setHeader("X-Accel-Buffering", "no");
  if (res.flushHeaders) res.flushHeaders();

  // No await between reading the backlog and attaching the listener, so a chunk
  // cannot slip through the gap and be lost or duplicated.
  const backlog = job.content.slice(from);
  if (backlog) res.write(sseDeltaFrame(backlog));

  if (job.status !== "running") {
    if (job.status === "error" && job.error) res.write(sseErrorFrame(job.error));
    else res.write(sseFinishFrame(job.finishReason));
    res.write("data: [DONE]\n\n");
    return res.end();
  }

  job.subscribers++;
  const listener = (event) => {
    try {
      if (event.type === "delta") {
        res.write(sseDeltaFrame(event.text));
      } else if (event.type === "error") {
        res.write(sseErrorFrame(event.error || "Generation failed"));
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        res.write(sseFinishFrame(event.finishReason));
        res.write("data: [DONE]\n\n");
        res.end();
      }
    } catch (_) {
      /* client vanished mid-write; the close handler cleans up */
    }
  };
  job.listeners.add(listener);

  res.on("close", () => {
    job.listeners.delete(listener);
    job.subscribers = Math.max(0, job.subscribers - 1);
  });
});

/**
 * Collect the finished result of a non-streaming job.
 *
 * A non-streaming call cannot be resumed partway through — there is no partial
 * output to replay — but it can still be *collected*. Without this the client's
 * retry regenerates the whole thing, which is the remaining half of the
 * double-billing bug that resumable streaming already fixed.
 *
 * 202 while still running, so the caller can poll rather than give up.
 */
app.get("/api/text/jobs/:jobId/result", requireAuth, (req, res) => {
  const job = generationJobs.get(req.params.jobId);

  if (!job || jobIsExpired(job)) {
    return res.status(404).json({
      error: { code: "404", message: "Job not found or expired" },
    });
  }
  if (job.userId !== req.user.userId) {
    return res.status(403).json({
      error: { code: "403", message: "Job belongs to another user" },
    });
  }

  if (job.status === "running") {
    return res.status(202).json({ status: "running", length: job.content.length });
  }
  if (job.status === "error") {
    return res.status(200).json({ status: "error", error: job.error });
  }

  return res.json({
    status: "done",
    finishReason: job.finishReason,
    // The original provider payload where we have it, so the client's existing
    // response handling works unchanged; streaming jobs fall back to the text.
    result:
      job.result ||
      { choices: [{ index: 0, message: { content: job.content }, finish_reason: job.finishReason }] },
  });
});

/**
 * List the caller's live jobs. The safety net for when Safari discards the tab
 * entirely, or the stored jobId turns out to be stale.
 */
app.get("/api/text/jobs", requireAuth, (req, res) => {
  const now = Date.now();
  const wantRef = req.query.clientRef;
  const list = [];
  for (const job of generationJobs.values()) {
    if (job.userId !== req.user.userId || jobIsExpired(job, now)) continue;
    if (wantRef && job.clientRef !== wantRef) continue;
    list.push({
      id: job.id,
      clientRef: job.clientRef,
      status: job.status,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      length: job.content.length,
      finishReason: job.finishReason,
      subscribers: job.subscribers,
    });
  }
  list.sort((a, b) => b.createdAt - a.createdAt);
  res.json({ jobs: list });
});

// Proxy endpoint for text API
app.post("/api/text/chat/completions", requireAuth, async (req, res) => {
  // Declared outside the try so the catch below can distinguish a deliberate
  // client-disconnect abort from a genuine server error.
  let clientGone = false;
  // Set when the caller opts into resumable buffering; see the job registry above.
  let job = null;
  try {
    const { model, messages, max_tokens, temperature, stream, resumable, clientRef } =
      req.body;

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

    // Note: `??` not `||` — a caller asking for temperature: 0 (deterministic
    // decoding) must not be silently coerced to 0.7 because 0 is falsy.
    const requestBody = {
      model,
      messages,
      max_tokens: max_tokens ?? 1000,
      temperature: temperature ?? 0.7,
      stream: stream ?? false,
    };

    for (const key of TEXT_PASSTHROUGH_PARAMS) {
      if (req.body[key] !== undefined) requestBody[key] = req.body[key];
    }
    if (requestBody.top_p === undefined) requestBody.top_p = DEFAULT_TEXT_TOP_P;

    const upstreamAbort = new AbortController();

    // Opting in creates a server-side buffer the generation can outlive the
    // socket into. Streaming jobs resume partway through; non-streaming ones
    // cannot be resumed mid-flight, but the finished result is still held so a
    // returning client collects it instead of paying to generate it again.
    if (resumable) {
      const running = countRunningJobsForUser(req.user.userId);
      if (running >= JOB_LIMITS.MAX_RUNNING_PER_USER) {
        return res.status(429).json({
          error: {
            code: "429",
            message: `Too many generations in flight (limit ${JOB_LIMITS.MAX_RUNNING_PER_USER}). Wait for one to finish.`,
          },
        });
      }
      job = createGenerationJob(req.user.userId, upstreamAbort, clientRef);
    }

    // Abort the upstream generation if the browser goes away. Without this the
    // provider keeps generating — and billing — into a socket nobody is reading.
    // Resumable jobs are the deliberate exception: there the whole point is to
    // let generation finish into the buffer so the client can come back for it.
    const onClientClose = () => {
      clientGone = true;
      if (job && job.status === "running") {
        job.subscribers = Math.max(0, job.subscribers - 1);
        console.log(`[jobs] client detached from job ${job.id}; continuing into buffer`);
        return;
      }
      upstreamAbort.abort();
    };
    res.on("close", onClientClose);

    const fetchOpts = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...additionalHeaders,
      },
      body: JSON.stringify(requestBody),
      signal: upstreamAbort.signal,
      // Bound the wait on a hung provider. Streaming replies can legitimately
      // take minutes, so this is generous; every other upstream fetch in this
      // file already sets one.
      timeout: TEXT_UPSTREAM_TIMEOUT_MS,
    };

    // Try Bearer auth first (most common)
    let response = await fetch(fullTextUrl, fetchOpts);

    // If Bearer fails with 401, try X-API-Key
    if (response.status === 401) {
      console.log("Bearer auth failed, trying X-API-Key...");
      response = await fetch(fullTextUrl, {
        ...fetchOpts,
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": apiKey,
          ...additionalHeaders,
        },
      });
    }

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Text API error:", response.status, errorText);
      if (job) {
        finishGenerationJob(job, "error", {
          error: `API Error: ${response.status} ${response.statusText}`,
        });
      }
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
      if (job) res.setHeader("X-Accel-Buffering", "no");

      // The client must learn the job id before any content arrives, so it can
      // persist it and still resume if the socket dies on the very next chunk.
      let extractContent = null;
      if (job) {
        if (!clientGone && !res.writableEnded) {
          res.write(`data: ${JSON.stringify({ type: "job", jobId: job.id })}\n\n`);
        }
        extractContent = makeSseContentExtractor({
          onContent: (text) => appendJobContent(job, text),
          onFinishReason: (reason) => {
            job.finishReason = reason;
          },
        });
      }

      response.body.on("data", (chunk) => {
        // Buffer first and unconditionally — the job must complete whether or
        // not anyone is still listening. Forwarding is the side effect now.
        if (extractContent) extractContent(chunk);

        if (clientGone || res.writableEnded) return;

        // Respect backpressure: if the client socket is full, pause the
        // upstream rather than buffering it all in memory for a slow reader.
        if (res.write(chunk) === false) {
          response.body.pause();
          // If the client disappears while paused, 'drain' never fires and a
          // resumable job would stall forever — so resume on close too, and
          // detach both listeners whichever one wins (otherwise repeated
          // backpressure piles up 'close' handlers on res).
          const resume = () => {
            res.off("drain", resume);
            res.off("close", resume);
            response.body.resume();
          };
          res.once("drain", resume);
          res.once("close", resume);
        }
      });

      // Without this listener an upstream failure mid-stream emits an
      // unhandled 'error' event, which can take the whole process down. The
      // headers are already sent by now, so the status code cannot be changed —
      // emit an SSE error frame so the client learns the stream was cut short
      // instead of silently treating a truncated reply as complete.
      response.body.on("error", (err) => {
        console.error("Text API stream error:", err.message);
        // Record on the job even with nobody attached, so a returning client is
        // told the generation failed rather than waiting on a dead stream.
        if (job) {
          finishGenerationJob(job, "error", {
            error: `Upstream stream failed: ${err.message}`,
          });
        }
        if (clientGone || res.writableEnded) return;
        try {
          res.write(
            `data: ${JSON.stringify({
              error: { message: `Upstream stream failed: ${err.message}` },
            })}\n\n`,
          );
        } catch (_) {
          /* client already gone */
        }
        res.end();
      });

      response.body.on("end", () => {
        if (job) {
          finishGenerationJob(job, "done", { finishReason: job.finishReason || "stop" });
          console.log(
            `[jobs] job ${job.id} complete (${job.content.length} chars, ` +
            `${clientGone ? "client had detached" : "client attached"})`,
          );
        }
        if (!res.writableEnded) res.end();
      });
    } else {
      const data = await response.json();
      if (job) {
        const message = data.choices?.[0]?.message;
        job.content = message?.content || message?.reasoning_content || "";
        job.result = data;
        finishGenerationJob(job, "done", {
          finishReason: data.choices?.[0]?.finish_reason || "stop",
        });
        if (clientGone) {
          console.log(
            `[jobs] job ${job.id} finished after the client had detached ` +
            `(${job.content.length} chars held for collection)`,
          );
        }
      }
      if (!res.writableEnded) res.json(data);
    }
  } catch (error) {
    // A client disconnect aborts the upstream fetch on purpose — that is not a
    // server error and the response is already gone.
    if (clientGone || error.name === "AbortError") {
      console.log("Text request aborted (client disconnected)");
      // A resumable job whose fetch died still needs a terminal state, or a
      // returning client would tail a stream that will never produce anything.
      if (job) {
        finishGenerationJob(job, "error", { error: "Generation was interrupted" });
      }
      return;
    }
    console.error("Proxy error:", error);
    if (job) finishGenerationJob(job, "error", { error: error.message });
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
app.post("/api/image/free", requireAuth, async (req, res) => {
  try {
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

// Proxy endpoint for local WebUI Forge image generation
// Accepts { prompt, forge_url } — returns the generated image as an image/png blob
app.post("/api/image/forge", requireAuth, async (req, res) => {
  try {
    const { prompt, forge_url } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: { code: "400", message: "prompt is required" } });
    }

    const forgeHost = (forge_url || "http://127.0.0.1:7860").replace(/\/$/, "");
    const txt2imgUrl = `${forgeHost}/sdapi/v1/txt2img`;

    console.log("Local Forge image request →", txt2imgUrl);
    console.log("Prompt length:", prompt.length);

    const forgePayload = {
      prompt,
      steps: 25,
      cfg_scale: 1,
      width: 896,
      height: 1152,
      sampler_name: "Euler",
    };

    let forgeRes;
    try {
      forgeRes = await fetch(txt2imgUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(forgePayload),
        timeout: 300000, // 5 min — local GPU can be slow on first run
      });
    } catch (connErr) {
      console.error("Forge connection error:", connErr.message);
      return res.status(503).json({
        error: {
          code: "503",
          message: "Cannot connect to WebUI Forge",
          details: `Make sure Forge is running with the --api flag at ${forgeHost}. (${connErr.message})`,
        },
      });
    }

    if (forgeRes.status === 404) {
      return res.status(502).json({
        error: {
          code: "502",
          message: "WebUI Forge API not found (404)",
          details: "Make sure Forge is launched with the --api flag: python webui.py --api",
        },
      });
    }

    if (!forgeRes.ok) {
      const errText = await forgeRes.text().catch(() => forgeRes.statusText);
      console.error("Forge API error:", forgeRes.status, errText);
      return res.status(forgeRes.status).json({
        error: { code: forgeRes.status.toString(), message: `Forge returned ${forgeRes.status}`, details: errText },
      });
    }

    const forgeData = await forgeRes.json();
    const images = forgeData.images;
    if (!images || images.length === 0) {
      return res.status(500).json({ error: { code: "500", message: "Forge returned no images in response" } });
    }

    // images[0] is a raw base64 string (no data URI prefix)
    const imgBuffer = Buffer.from(images[0], "base64");
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Length", imgBuffer.length);
    res.send(imgBuffer);
  } catch (error) {
    console.error("Forge proxy error:", error);
    res.status(500).json({ error: { code: "500", message: "Forge proxy error", details: error.message } });
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

// Proxy endpoint for combining multiple reference images into one generation
// (Playground's Combine tab). Distinct from /api/image/generations: nano-gpt's
// docs describe this as a separate "normalized" endpoint — POST {base}/images
// with an `input_references` array — not part of the OpenAI-compatible
// /images/generations shape that endpoint already forwards, so this can't
// just reuse it.
app.post("/api/image/combine", requireAuth, async (req, res) => {
  try {
    const { model, prompt, input_references } = req.body;

    const apiKey = req.headers["x-api-key"];
    const apiUrl = req.headers["x-api-url"];

    if (!apiKey) {
      return res.status(401).json({
        error: { code: "401", message: "Image API key required", details: "Please configure your Image API key in the settings" },
      });
    }
    if (!apiUrl) {
      return res.status(400).json({
        error: { code: "400", message: "Image API URL required", details: "Please configure your Image API Base URL in the settings" },
      });
    }
    if (!Array.isArray(input_references) || input_references.length < 2) {
      return res.status(400).json({
        error: { code: "400", message: "At least two input_references images are required" },
      });
    }

    const targetUrl = apiUrl.endsWith("/images") ? apiUrl : `${apiUrl.replace(/\/$/, "")}/images`;

    console.log("Proxying image combine request to:", targetUrl);
    console.log("Model:", model);
    console.log("Reference image count:", input_references.length);

    const requestBody = { model, prompt, input_references, n: 1, ...req.body };

    let response = await fetch(targetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(requestBody),
    });

    if (response.status === 401) {
      console.log("Bearer auth failed for image combine API, trying X-API-Key...");
      response = await fetch(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
        body: JSON.stringify(requestBody),
      });
    }

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Image combine API error:", response.status, errorText);
      return res.status(response.status).json({
        error: { code: response.status.toString(), message: `Image Combine API Error: ${response.statusText}`, details: errorText },
      });
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error("Image combine proxy error:", error);
    res.status(500).json({
      error: { code: "500", message: "Internal server error in image combine proxy", details: error.message },
    });
  }
});

// Reject URLs that resolve to the host itself or to private/internal network
// ranges. Without this the proxy is an SSRF primitive: any signed-in user could
// have the server fetch cloud metadata (169.254.169.254) or internal services
// on localhost and read the response back as an "image".
const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,                                  // loopback
  /^0\./,                                    // "this" network
  /^10\./,                                   // RFC1918
  /^192\.168\./,                             // RFC1918
  /^172\.(1[6-9]|2[0-9]|3[01])\./,           // RFC1918
  /^169\.254\./,                             // link-local / cloud metadata
  /^\[?::1\]?$/,                             // IPv6 loopback
  /^\[?f[cd][0-9a-f]{2}:/i,                  // IPv6 unique-local
  /^\[?fe80:/i,                              // IPv6 link-local
  /\.internal$/i,
  /\.local$/i,
];

const MAX_PROXIED_IMAGE_BYTES = 25 * 1024 * 1024; // 25 MB

function assertSafeFetchUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_) {
    throw new Error("Malformed URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported protocol: ${parsed.protocol}`);
  }
  const host = parsed.hostname;
  if (BLOCKED_HOST_PATTERNS.some((re) => re.test(host))) {
    throw new Error("Refusing to fetch from a private or internal address");
  }
  return parsed;
}

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

    let parsedUrl;
    try {
      parsedUrl = assertSafeFetchUrl(imageUrl);
    } catch (err) {
      console.warn("Blocked proxy-image request:", imageUrl, "-", err.message);
      return res.status(400).json({
        error: { code: "400", message: "Invalid image URL", details: err.message },
      });
    }

    console.log("Proxying image request for:", imageUrl);

    const response = await fetch(imageUrl, {
      timeout: 30000,
      size: MAX_PROXIED_IMAGE_BYTES, // node-fetch aborts past this many bytes
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "image/webp,image/apng,image/*,*/*;q=0.8",
        "Referer": parsedUrl.origin + "/"
      }
    });

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
    // Sanitise the filename — old card names may contain characters that are
    // illegal in HTTP header values (commas, non-ASCII, quotes, etc.)
    const safeFilename = (avatar_url || "character.png")
      .replace(/[^\x20-\x7E]/g, "_")   // strip non-printable / non-ASCII
      .replace(/[",\\\r\n]/g, "_")      // strip quotes, commas, backslashes
      .trim() || "character.png";
    try {
      res.setHeader("Content-Disposition", `attachment; filename="${safeFilename}"`);
    } catch (_) {
      res.setHeader("Content-Disposition", "attachment; filename=\"character.png\"");
    }
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
  console.log("ST push proxy: received preservedName =", preservedName, "type =", typeof preservedName);
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
      console.log("ST push proxy: including preserved_name part =", String(preservedName));
    } else {
      console.log("ST push proxy: NO preserved_name part included");
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
    console.log("ST push proxy: ST response =", JSON.stringify(data));
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

// ── URL Import — Scrape JannyAi character pages ──────────────────
const ALLOWED_IMPORT_DOMAINS = [
  "jannyai.com",
  "www.jannyai.com",
  "api.jannyai.com",
];

function isAllowedImportUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    return ALLOWED_IMPORT_DOMAINS.includes(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

app.post("/api/import/url", requireAuth, async (req, res) => {
  try {
    const { url, token } = req.body;
    if (!url || typeof url !== "string") {
      return res.status(400).json({ success: false, error: "URL is required" });
    }

    if (!isAllowedImportUrl(url)) {
      return res.status(400).json({
        success: false,
        error: `URL domain not allowed. Supported domains: ${ALLOWED_IMPORT_DOMAINS.join(", ")}`,
      });
    }

    console.log(`[URL Import] Fetching: ${url}`);

    let character = null;
    const fetchOptions = {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json, text/html, */*"
      },
    };

    // Direct API fetch for JannyAI
    const jannyMatch = url.match(/(?:api\.)?jannyai\.com\/characters\/([^\/?#]+)/i);
    if (jannyMatch) {
      try {
        const apiRes = await fetch(`https://api.jannyai.com/characters/${jannyMatch[1]}`, fetchOptions);
        if (apiRes.ok) {
          const data = await apiRes.json();
          if (data && (data.name || data.description || data.first_mes || data.firstMessage)) {
            character = normalizeCharacterFields(data, url);
          }
        }
      } catch (e) { console.warn("[URL Import] JannyAI API direct fetch failed:", e.message); }
    }

    // 15-second timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    if (!character) {
      let response;
      try {
        response = await fetch(url, { ...fetchOptions, signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        return res.status(502).json({ success: false, error: `Site returned HTTP ${response.status}` });
      }

      const html = await response.text();
      const MAX_HTML = 5 * 1024 * 1024; // 5 MB cap
      if (html.length > MAX_HTML) {
        return res.status(413).json({ success: false, error: "Page too large (max 5 MB)" });
      }

      character = extractCharacterFromHtml(html, url);
    }

    if (!character) {
      return res.status(422).json({
        success: false,
        error: "Could not extract character data from this page. The page may not contain a character card, or the format may not be supported.",
      });
    }

    console.log(`[URL Import] Extracted: name="${character.name}", desc=${(character.description || "").length} chars`);
    res.json({ success: true, character });
  } catch (e) {
    console.error("[URL Import] Error:", e.message);
    if (e.name === "AbortError") {
      return res.status(504).json({ success: false, error: "Request timed out after 15 seconds" });
    }
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Character Web Search (Brave Search API) ────────────────────────────────────
const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";
const BRAVE_SEARCH_API_KEY = process.env.BRAVE_SEARCH_API_KEY || "";
const BRAVE_SEARCH_ENABLED = process.env.BRAVE_SEARCH_ENABLED !== "false" && !!BRAVE_SEARCH_API_KEY;

if (!BRAVE_SEARCH_ENABLED && process.env.BRAVE_SEARCH_API_KEY) {
  console.warn("⚠️  BRAVE_SEARCH_ENABLED is explicitly 'false' — web search disabled.");
}
if (!BRAVE_SEARCH_API_KEY && process.env.BRAVE_SEARCH_ENABLED !== "false") {
  console.warn("⚠️  BRAVE_SEARCH_API_KEY not set — Character Web Search will be skipped. Set BRAVE_SEARCH_API_KEY in your .env.");
}

/**
 * Perform a single search query via Brave Search API
 */
async function braveWebSearch(query, count = 5) {
  if (!BRAVE_SEARCH_ENABLED || !BRAVE_SEARCH_API_KEY) {
    return null;
  }
  const params = new URLSearchParams({
    q: query,
    count: String(count),
    search_lang: "en",
    text_decorations: "false",
  });
  const url = `${BRAVE_SEARCH_URL}?${params.toString()}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "Accept": "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": BRAVE_SEARCH_API_KEY,
      },
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      console.warn(`[Brave Search] HTTP ${response.status}: ${response.statusText}`);
      return null;
    }
    const data = await response.json();
    if (!data && !data.web || !data.web.results) {
      return { results: [] };
    }
    return data;
  } catch (err) {
    clearTimeout(timeoutId);
    console.warn("[Brave Search] Error:", err.message);
    return null;
  }
}

/**
 * Aggregate multiple search queries into structured character data
 */
async function searchCharacterDetails(name, isFictional) {
  const queries = [
    `"${name}" biography`,
    `"${name}" personality traits character`,
    `"${name}" physical appearance description looks`,
  ];
  if (isFictional) {
    queries.push(`"${name}" fandom wiki character profile appearance personality`);
    queries.push(`"${name}" Wikipedia character biography appearance`);
  } else {
    queries.push(`"${name}" Wikipedia biography`);
    queries.push(`"${name}" real person profile description`);
  }

  const allResults = [];
  for (const q of queries) {
    const result = await braveWebSearch(q, 3);
    if (result && result.web && result.web.results) {
      allResults.push(...result.web.results);
    }
  }

  if (allResults.length === 0) {
    return null;
  }

  // Deduplicate by URL
  const seenUrls = new Set();
  const deduped = allResults.filter((r) => {
    if (!r.url || seenUrls.has(r.url)) return false;
    seenUrls.add(r.url);
    return true;
  });

  // Aggregate snippets into character data fields
  const biographical = [];
  const appearance = [];
  const personality = [];
  const keyFacts = [];
  const sourceUrls = deduped.map((r) => r.url).slice(0, 6);

  for (const r of deduped) {
    const text = ((r.title || "") + " " + (r.description || "")).toLowerCase();
    const snippetFull = ((r.title || "") + ". " + (r.description || "")).trim();
    if (!snippetFull) continue;

    if (/\b(physical )?appearance\b|\b(look|height|build|hair|eye|face|body|skin|outfit)/.test(text) && appearance.length < 3) {
      appearance.push(snippetFull);
    } else if (/\b(personality|trait|temperament|attitude|behaviour|behavior|arrogant|shy|confident|cold|warm)\b/.test(text) && personality.length < 3) {
      personality.push(snippetFull);
    } else if (/\b(biography|backstory|early life|childhood|born|raised|origin|family|career|history)\b/.test(text) && biographical.length < 4) {
      biographical.push(snippetFull);
    } else if (keyFacts.length < 3) {
      keyFacts.push(snippetFull);
    }
  }

  // If nothing was classified, dump all snippets into biographical as fallback
  if (biographical.length === 0 && appearance.length === 0 && personality.length === 0) {
    const allSnippets = deduped.map((r) => ((r.title || "") + ". " + (r.description || "")).trim()).filter(Boolean);
    biographical.push(...allSnippets.slice(0, 5));
  }

  return {
    biographical: biographical.join("\n"),
    appearance: appearance.join("\n"),
    personality: personality.join("\n"),
    keyFacts: keyFacts.join("\n"),
    sourceUrls,
  };
}

/**
 * POST /api/search/character
 * Body: { name: string, isFictional: boolean }
 */
app.post("/api/search/character", requireAuth, async (req, res) => {
  try {
    const { name, isFictional } = req.body;
    if (!name || typeof name !== "string") {
      return res.status(400).json({ success: false, error: "name is required" });
    }
    if (!BRAVE_SEARCH_ENABLED) {
      return res.status(503).json({ success: false, error: "Search not configured", configured: false });
    }

    console.log(`[Char Search] Searching for: "${name}", fictional=${isFictional}`);
    const results = await searchCharacterDetails(name.trim(), !!isFictional);

    if (!results) {
      return res.json({ success: true, results: null, message: "No results found" });
    }

    console.log(`[Char Search] Extracted bio=${(results.biographical || "").length}, appearance=${(results.appearance || "").length}, personality=${(results.personality || "").length}`);
    res.json({ success: true, results });
  } catch (e) {
    console.error("[Char Search] Error:", e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Image Search ──────────────────────────────────────────────────────────────
const { imageSearch } = require("@mudbill/duckduckgo-images-api");

app.post("/api/search/images", requireAuth, async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) {
      return res.status(400).json({ success: false, error: "Query is required" });
    }
    console.log(`[Image Search] Searching for: "${query}"`);
    const results = await imageSearch({ query, safe: false });
    
    // Map DuckDuckGo response to match what the frontend expects
    const images = results.slice(0, 100).map(img => ({
      url: img.image,
      thumbnail: img.thumbnail,
      title: img.title,
      source: img.url
    }));
    
    res.json({ success: true, images });
  } catch (e) {
    console.error("[Image Search] Error:", e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── HTML parser for character data ────────────────────────────────────────────

function extractCharacterFromHtml(html, sourceUrl) {
  // Strategy 1: __NEXT_DATA__ JSON (JanitorAI, Chub.ai both use Next.js)
  const nextDataMatch = html.match(/<script\s+id="__NEXT_DATA__"[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/i);
  if (nextDataMatch) {
    try {
      const data = JSON.parse(nextDataMatch[1]);
      const char = extractFromNextData(data, sourceUrl);
      if (char) return char;
    } catch (e) {
      console.warn("[URL Import] Failed to parse __NEXT_DATA__:", e.message);
    }
  }

  // Strategy 2: JSON-LD structured data
  const ldJsonMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
  if (ldJsonMatch) {
    try {
      const data = JSON.parse(ldJsonMatch[1]);
      const char = extractFromJsonLd(data);
      if (char) return char;
    } catch (e) { /* ignore */ }
  }

  // Strategy 3: Meta tags + visible text fallback
  return extractFromMetaAndText(html, sourceUrl);
}

// ── Strategy 1: __NEXT_DATA__ ─────────────────────────────────────────────────

function extractFromNextData(data, sourceUrl) {
  // Try multiple paths to find character data in the Next.js page props
  const paths = [
    "props.pageProps.character",
    "props.pageProps.characterData",
    "props.pageProps.charData",
    "props.pageProps.data",
    "props.pageProps.node",
    "query",
  ];

  let charData = null;
  for (const p of paths) {
    charData = p.split(".").reduce((obj, key) => obj?.[key], data);
    if (charData && typeof charData === "object") break;
  }

  // If nothing found at named paths, search recursively for a plausible character object
  if (!charData || typeof charData !== "object") {
    charData = findCharacterObject(data);
  }

  if (!charData || typeof charData !== "object") return null;

  return normalizeCharacterFields(charData, sourceUrl);
}

function findCharacterObject(obj, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 12) return null;
  // Heuristic: an object with at least 'name' and one of ['description','personality','first_mes']
  if (obj.name && (obj.description || obj.personality || obj.first_mes || obj.firstMessage)) {
    return obj;
  }
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findCharacterObject(item, depth + 1);
      if (found) return found;
    }
  } else {
    for (const key of Object.keys(obj)) {
      const found = findCharacterObject(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

// ── Strategy 2: JSON-LD ───────────────────────────────────────────────────────

function extractFromJsonLd(data) {
  const item = Array.isArray(data) ? data[0] : data;
  if (!item || typeof item !== "object") return null;
  if (item["@type"] === "Person" || item["@type"] === "Character") {
    return {
      name: item.name || "",
      description: item.description || "",
    };
  }
  return null;
}

// ── Strategy 3: Meta tags + visible text ──────────────────────────────────────

function extractFromMetaAndText(html, sourceUrl) {
  const getMeta = (names) => {
    for (const n of names) {
      // og:title, twitter:title, etc.
      const re = new RegExp(`<meta\\s[^>]*?(?:property|name)=["']${n}["'][^>]*?content=["']([^"']+)["']`, "i");
      const m = html.match(re);
      if (m) return m[1];
      // Also try content then property
      const re2 = new RegExp(`<meta\\s[^>]*?content=["']([^"']+)["'][^>]*?(?:property|name)=["']${n}["']`, "i");
      const m2 = html.match(re2);
      if (m2) return m2[1];
    }
    return "";
  };

  const name = getMeta(["og:title", "twitter:title", "title"]) || "";
  const description = getMeta(["og:description", "twitter:description", "description"]) || "";

  // Try to extract visible text description (first substantial paragraph after the title)
  const bodyMatch = html.match(/<body[\s\S]*?<\/body>/i);
  let textDescription = "";
  if (bodyMatch) {
    // Strip HTML tags and find first substantial paragraph
    const text = bodyMatch[0].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    // Try to find text after common labels
    const labelPatterns = [
      /(?:Description|About|Personality|Bio|Backstory)\s*[:：]\s*(.{50,500}?)(?:\s{2,}|$)/i,
      /(?:Description|About|Personality|Bio|Backstory)\s*\n\s*(.{50,500}?)(?:\n\s*\n|$)/i,
    ];
    for (const pat of labelPatterns) {
      const m = text.match(pat);
      if (m) { textDescription = m[1].trim(); break; }
    }
    // Fallback: first 300 chars after title area
    if (!textDescription && name) {
      const nameIdx = text.indexOf(name);
      if (nameIdx >= 0) {
        textDescription = text.slice(nameIdx + name.length).trim().slice(0, 300);
      }
    }
  }

  if (!name && !description && !textDescription) return null;

  return {
    name: cleanName(name || extractNameFromUrl(sourceUrl)),
    description: (description || textDescription || "").slice(0, 30000),
    personality: "",
    scenario: "",
    firstMessage: "",
    tags: [],
    mesExample: "",
    creatorNotes: `Imported from ${sourceUrl}`,
  };
}

// ── Field normalisation ───────────────────────────────────────────────────────

function normalizeCharacterFields(data, sourceUrl) {
  // Map from various naming conventions to our standard fields
  return {
    name: cleanName(data.name || data.character_name || data.charName || ""),
    description: (data.description || data.desc || data.bio || data.backstory || "").slice(0, 30000),
    personality: (data.personality || data.persona || data.traits || "").slice(0, 30000),
    scenario: (data.scenario || data.setting || data.scene || "").slice(0, 30000),
    firstMessage: (data.firstMessage || data.first_mes || data.greeting || data.intro || data.first_message || "").slice(0, 30000),
    tags: normalizeTags(data.tags || data.tag || data.categories || []),
    mesExample: (data.mesExample || data.mes_example || data.example_dialogs || data.examples || "").slice(0, 30000),
    creatorNotes: (data.creatorNotes || data.creator_notes || data.creatorcomment || `Imported from ${sourceUrl}`).slice(0, 30000),
    alternateGreetings: Array.isArray(data.alternateGreetings)
      ? data.alternateGreetings
      : Array.isArray(data.alternate_greetings) ? data.alternate_greetings : [],
    systemPrompt: data.systemPrompt || data.system_prompt || data.system || "",
    postHistoryInstructions: data.postHistoryInstructions || data.post_history_instructions || data.phi || "",
    characterBook: data.characterBook || data.character_book || data.worldInfo || null,
    creator: data.creator || data.author || data.created_by || "",
    characterVersion: data.characterVersion || data.character_version || data.version || "",
  };
}

function normalizeTags(tags) {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags.map((t) => String(t).trim()).filter(Boolean);
  if (typeof tags === "string") {
    // Could be comma-separated or JSON string
    try {
      const parsed = JSON.parse(tags);
      if (Array.isArray(parsed)) return parsed.map((t) => String(t).trim()).filter(Boolean);
    } catch { /* not JSON */ }
    return tags.split(",").map((t) => t.trim()).filter(Boolean);
  }
  return [];
}

function cleanName(raw) {
  if (!raw) return "";
  // Remove common prefixes/suffixes
  let name = String(raw).replace(/^["']|["']$/g, "").trim();
  // Strip "Character:" or "Name:" prefixes
  name = name.replace(/^(?:Character|Name|Title)\s*[:：]\s*/i, "").trim();
  // Limit length
  return name.slice(0, 200);
}

function extractNameFromUrl(url) {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    const last = parts[parts.length - 1] || parts[0] || "";
    return last.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  } catch {
    return "Imported Character";
  }
}

// ─────────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`🚀 Proxy server running on http://localhost:${PORT}`);
  console.log(`📡 Ready to proxy requests to configured APIs`);
  console.log(`🔑 API URLs will be provided via request headers`);
  if (BRAVE_SEARCH_ENABLED) {
    console.log("🔍 Character Web Search enabled (Brave Search API)");
  } else {
    console.log("🔍 Character Web Search disabled — set BRAVE_SEARCH_API_KEY to enable");
  }
});
