import fs from "fs";
import multer from "multer";
// /web/tracklinq/server/index.js
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import morgan from "morgan";
import pkg from "pg";

const { Pool } = pkg;

// ----- DB pool -----
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});
const query = (text, params) => pool.query(text, params);

// ----- Express app -----
const app = express();
app.use(express.json());
app.use(morgan("tiny"));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "..", "public");
app.use(express.static(publicDir));

// ----- Health -----
app.get("/health", (_req, res) => res.json({ ok: true }));

// ----- DB test -----
app.get("/dbtest", async (_req, res) => {
  try {
    const now = await query("select now()");
    const hasClubs = await query(
      "select count(*)::int as n from information_schema.tables where table_name = 'clubs'"
    );
    res.json({ ok: true, now: now.rows[0].now, hasClubsTable: hasClubs.rows[0].n > 0 });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ========== PUBLIC API ==========

// List active clubs (for guest mode chooser)
app.get("/api/clubs", async (_req, res) => {
  try {
    const { rows } = await query(
      "SELECT id, name, short_code FROM clubs WHERE is_active = TRUE ORDER BY name ASC"
    );
    res.json({ ok: true, clubs: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Resolve a club by 10-digit PIN (for clubs)
app.get("/api/pin/resolve", async (req, res) => {
  const pin = String(req.query.pin || "").trim();
  if (!pin) return res.status(400).json({ ok: false, error: "pin required" });
  try {
    const { rows } = await query(
      "SELECT id, name, short_code FROM clubs WHERE pin_code = $1 AND is_active = TRUE LIMIT 1",
      [pin]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: "not_found" });
    res.json({ ok: true, club: rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Resolve a tablet/device code (for carts/tablets)
app.get("/api/device/resolve", async (req, res) => {
  const code = String(req.query.code || "").trim();
  if (!code) return res.status(400).json({ ok: false, error: "code required" });
  try {
    const { rows } = await query(
      `SELECT d.id as device_id, d.is_active, d.device_code,
              c.id as club_id, c.name as club_name, c.short_code
         FROM devices d
         JOIN clubs c ON c.id = d.club_id
        WHERE d.device_code = $1
        LIMIT 1`,
      [code]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: "not_found" });
    if (!rows[0].is_active)
      return res.status(403).json({ ok: false, error: "device_inactive" });
    res.json({ ok: true, device: rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ========== ONE-TIME ADMIN MIGRATION/SEED (allows GET or POST) ==========

function checkToken(req) {
  const token = process.env.MIGRATION_TOKEN || "";
  if (!token) return false;
  const provided = req.query.token || req.header("x-migration-token");
  return provided && provided === token;
}

const schemaSQL = `
CREATE TABLE IF NOT EXISTS clubs (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  short_code TEXT NOT NULL UNIQUE,
  is_active BOOLEAN DEFAULT TRUE,
  pin_code VARCHAR(10) UNIQUE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS devices (
  id SERIAL PRIMARY KEY,
  club_id INTEGER REFERENCES clubs(id) ON DELETE CASCADE,
  device_code VARCHAR(20) UNIQUE NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rounds (
  id SERIAL PRIMARY KEY,
  club_id INTEGER REFERENCES clubs(id),
  course_name TEXT,
  player_name TEXT,
  total_score INTEGER,
  played_at TIMESTAMP DEFAULT NOW()
);
`;

const seedSQL = `
INSERT INTO clubs (name, short_code, pin_code)
VALUES ('Silverlakes Golf Club', 'SLK', 'SLK1234567')
ON CONFLICT (short_code) DO NOTHING;

INSERT INTO devices (club_id, device_code)
SELECT id, 'SLK-7F4K-J2' FROM clubs WHERE short_code='SLK'
ON CONFLICT (device_code) DO NOTHING;
`;

app.all("/admin/migrate", async (req, res) => {
  if (!checkToken(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  try {
    await query(schemaSQL);
    res.json({ ok: true, ran: "schema" });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.all("/admin/seed", async (req, res) => {
  if (!checkToken(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  try {
    await query(seedSQL);
    res.json({ ok: true, ran: "seed" });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});


// ========== ADS SYSTEM (Club-managed overlays) ==========
// IMPORTANT: Club PINs are currently managed in public/courses/index.json (NOT the DB).
// - ad-manager.html uploads ads for a club (identified by short_code) after PIN validation.
// - tablets fetch ads list publicly via: GET /ads/<short_code>/ads.json
//
// PIN-protected endpoints (portal):
//   GET    /api/ads/list?course=<short_code>&pin=<PIN>
//   POST   /api/ads/upload?course=<short_code>&pin=<PIN>   (multipart field name: files)
//   DELETE /api/ads/delete?course=<short_code>&pin=<PIN>&name=<filename>

const adsDir = process.env.ADS_DIR || path.join(publicDir, "ads");
if (!fs.existsSync(adsDir)) fs.mkdirSync(adsDir, { recursive: true });

const adsUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB each
});

function safeId(id) {
  return String(id || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

function ensureClubDir(shortCode) {
  const dir = path.join(adsDir, shortCode);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function listAds(shortCode) {
  const dir = ensureClubDir(shortCode);
  return fs
    .readdirSync(dir)
    .filter((f) => /\.(png|jpg|jpeg|webp|gif)$/i.test(f))
    .sort((a, b) => a.localeCompare(b));
}

// Read course index JSON (source of truth for PINs + active flag)
function readCoursesIndex() {
  const p = path.join(publicDir, "courses", "index.json");
  const raw = fs.readFileSync(p, "utf8");
  const j = JSON.parse(raw);
  const courses = Array.isArray(j.courses) ? j.courses : [];
  return courses;
}

function normalizePin(pin) {
  return String(pin || "").trim().toUpperCase();
}

function resolveCourseByPin(pin) {
  const want = normalizePin(pin);
  if (!want) return null;

  const courses = readCoursesIndex();

  // Match on exact PIN (case-insensitive) and must be active === true
  // Accept both fields: pin or PIN (just in case)
  const hit = courses.find((c) => {
    const active = c.active === true || c.ACTIVE === true;
    const storedPin = normalizePin(c.pin ?? c.PIN);
    return active && storedPin && storedPin === want;
  });

  if (!hit) return null;

  const shortCode = safeId(
    hit.shortCode ?? hit.shortcode ?? hit.SHORTCODE ?? hit.short_code ?? hit.courseShortCode
  );
  const name = String(hit.name ?? hit.NAME ?? "").trim();

  if (!shortCode) return null;

  return { shortCode, name };
}

function requireClubPin(req, res, next) {
  const course = safeId(req.query.course); // expected to match short_code
  const pin = normalizePin(req.query.pin);

  if (!course) return res.status(400).send("Missing course");
  if (!pin) return res.status(400).send("Missing pin");

  try {
    const club = resolveCourseByPin(pin);
    if (!club) return res.status(401).send("Invalid PIN");

    if (club.shortCode !== course) return res.status(401).send("Invalid PIN");

    req.shortCode = club.shortCode;
    req.clubName = club.name;
    next();
  } catch (e) {
    // If index.json missing/corrupt, surface error clearly (helps debugging)
    return res.status(500).send("Ads auth error");
  }
}

// PIN-protected list (used by ad-manager portal)
app.get("/api/ads/list", requireClubPin, (req, res) => {
  const files = listAds(req.shortCode);
  res.json({ ads: files.map((f) => `/ads/${req.shortCode}/${encodeURIComponent(f)}`) });
});

// PIN-protected upload (multipart form field name: files)
app.post("/api/ads/upload", requireClubPin, adsUpload.array("files", 30), (req, res) => {
  const dir = ensureClubDir(req.shortCode);

  for (const f of req.files || []) {
    const ext = path.extname(f.originalname || "").toLowerCase();
    if (![".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) continue;

    const base = path.basename(f.originalname).replace(/[^a-z0-9._-]/gi, "_");
    const name = `${Date.now()}_${base}`;
    fs.writeFileSync(path.join(dir, name), f.buffer);
  }

  const files = listAds(req.shortCode);
  res.json({ ads: files.map((f) => `/ads/${req.shortCode}/${encodeURIComponent(f)}`) });
});

// PIN-protected delete
app.delete("/api/ads/delete", requireClubPin, (req, res) => {
  const name = path.basename(String(req.query.name || ""));
  if (!name) return res.status(400).send("Missing name");

  const fp = path.join(adsDir, req.shortCode, name);
  try {
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch (_) {}

  const files = listAds(req.shortCode);
  res.json({ ads: files.map((f) => `/ads/${req.shortCode}/${encodeURIComponent(f)}`) });
});

// Public ads list for tablets (no PIN). Cached by SW; keep no-store to prevent stale lists.
app.get("/ads/:course/ads.json", (req, res) => {
  const shortCode = safeId(req.params.course);
  const files = shortCode ? listAds(shortCode) : [];
  res.setHeader("Cache-Control", "no-store");
  res.json({ ads: files.map((f) => `/ads/${shortCode}/${encodeURIComponent(f)}`) });
});

// Serve ad images (public)
app.get("/ads/:course/:file", (req, res, next) => {
  const shortCode = safeId(req.params.course);
  const file = path.basename(req.params.file);
  const fp = path.join(adsDir, shortCode, file);
  if (!fs.existsSync(fp)) return next();
  return res.sendFile(fp);
});




// ----- Start -----
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`TrackLinq server running on :${PORT}`));
