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

// ----- Start -----
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`TrackLinq server running on :${PORT}`));
