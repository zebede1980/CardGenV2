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
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || "";

if (!process.env.JWT_SECRET) {
  console.warn("⚠️  JWT_SECRET not set — using insecure default. Set JWT_SECRET in your environment.");
}
if (!process.env.INTERNAL_API_SECRET) {
  console.warn("⚠️  INTERNAL_API_SECRET not set — backend calls will be rejected. Set INTERNAL_API_SECRET in your environment.");
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

// ── Per-user history (non-permanent auto-saves) stored as a local flat file ──
const HISTORY_MAX = 30;

async function readHistory(userId) {
  const filePath = path.join(getUserDataDir(userId), "history.json");
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = await fsPromises.readFile(filePath, "utf8");
    return JSON.parse(raw) || [];
  } catch (e) {
    return [];
  }
}

async function writeHistory(userId, items) {
  const filePath = path.join(getUserDataDir(userId), "history.json");
  await fsPromises.writeFile(filePath, JSON.stringify(items, null, 2), "utf8");
}

// ── JWT middleware ────────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  // Accept Bearer header OR ?token= query param (needed for <img src> which can't send headers)
  const authHeader = req.headers["authorization"];
  const tokenFromHeader = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const tokenFromQuery = typeof req.query.token === "string" ? req.query.token : null;
  const token = tokenFromHeader || tokenFromQuery;
  if (!token) {
    return res.status(401).json({ error: "Authentication required" });
  }
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

app.post("/api/auth/change-password", requireAuth, async (req, res) => {
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

// ── Per-user Data Endpoints for Prompts (Local JSON) ─────────────────────────
app.get("/api/storage/prompts", requireAuth, async (req, res) => {
  const storeFile = path.join(getUserDataDir(req.user.userId), "prompts.json");
  res.json(await readJsonStore(storeFile));
});

app.get("/api/storage/prompts/:id", requireAuth, async (req, res) => {
  const storeFile = path.join(getUserDataDir(req.user.userId), "prompts.json");
  const items = await readJsonStore(storeFile);
  const item = items.find(i => i.id == req.params.id);
  if (item) res.json(item);
  else res.status(404).json({ error: "Not found" });
});

app.post("/api/storage/prompts", requireAuth, async (req, res) => {
  const storeFile = path.join(getUserDataDir(req.user.userId), "prompts.json");
  const lockKey = `user-${req.user.userId}-prompts.json`;
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

app.delete("/api/storage/prompts/:id", requireAuth, async (req, res) => {
  const storeFile = path.join(getUserDataDir(req.user.userId), "prompts.json");
  const lockKey = `user-${req.user.userId}-prompts.json`;
  try {
    await withFileLock(lockKey, async () => {
      let items = await readJsonStore(storeFile);
      items = items.filter(i => i.id != req.params.id);
      await writeJsonStore(storeFile, items);
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    updatedAt: c.created_at || new Date().toISOString(),
    createdAt: c.created_at || new Date().toISOString(),
    // Nested object for the load handler
    character,
    // Also spread flat fields so the StoryWriter card picker can read them directly
    ...character,
    image_path: c.image_path || "",
  };
}

// ── Per-user Data Endpoints for Cards (PostgreSQL Database Bridge) ───────────
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
    // Return permanent DB cards first, then history (temp) cards
    res.json([...dbCards.map(translateDbCard), ...histItems]);
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
      if (fs.existsSync(imgFile) && fs.existsSync(mimeFile)) {
        const [imgBuf, mime] = await Promise.all([
          fsPromises.readFile(imgFile),
          fsPromises.readFile(mimeFile, "utf8"),
        ]);
        return res.json({ ...card, imageBase64: `data:${mime};base64,${imgBuf.toString("base64")}` });
      }
      return res.json(card);
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
      if (imageBase64.startsWith("data:")) {
        const match = imageBase64.match(/^data:([^;]+);base64,(.+)$/s);
        if (match) {
          const imgDir = path.join(getUserDataDir(req.user.userId), "card-images");
          if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });
          await Promise.all([
            fsPromises.writeFile(path.join(imgDir, `${histId}.img`), Buffer.from(match[2], "base64")),
            fsPromises.writeFile(path.join(imgDir, `${histId}.mime`), match[1]),
          ]);
        }
      }
      // Persist and trim oldest items if over the cap
      const histItems = await readHistory(req.user.userId);
      histItems.push(histCard);
      if (histItems.length > HISTORY_MAX) {
        const removed = histItems.splice(0, histItems.length - HISTORY_MAX);
        // Clean up images for evicted entries
        const imgDir = path.join(getUserDataDir(req.user.userId), "card-images");
        for (const old of removed) {
          for (const ext of [".img", ".mime"]) {
            const f = path.join(imgDir, `${old.id}${ext}`);
            if (fs.existsSync(f)) fsPromises.unlink(f).catch(() => {});
          }
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
    if (imageBase64.startsWith("data:")) {
      const match = imageBase64.match(/^data:([^;]+);base64,(.+)$/s);
      if (match) {
        const imgDir = path.join(getUserDataDir(req.user.userId), "card-images");
        if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });
        await Promise.all([
          fsPromises.writeFile(path.join(imgDir, `${dbCard.id}.img`), Buffer.from(match[2], "base64")),
          fsPromises.writeFile(path.join(imgDir, `${dbCard.id}.mime`), match[1]),
        ]);
      }
    }

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
        if (fs.existsSync(f)) fsPromises.unlink(f).catch(() => {});
      }
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
    for (const ext of [".img", ".mime"]) {
      const f = path.join(imgDir, `${cardId}${ext}`);
      if (fs.existsSync(f)) fsPromises.unlink(f).catch(() => {});
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
          await fetch(`${internalUrl}/api/cards/${ec.id}`, { method: "DELETE", headers: internalHeaders }).catch(() => {});
          const ecImgDir = path.join(getUserDataDir(req.user.userId), "card-images");
          for (const ext of [".img", ".mime"]) {
            const f = path.join(ecImgDir, `${ec.id}${ext}`);
            if (fs.existsSync(f)) await fsPromises.unlink(f).catch(() => {});
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
    res.status(response.status).send(text);
  } catch (error) { res.status(500).json({ error: "StoryWriter backend unreachable: " + error.message }); }
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
