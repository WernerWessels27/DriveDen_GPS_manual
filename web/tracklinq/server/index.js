import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import morgan from "morgan";
import { query } from "./db.js";

const app = express();
app.use(express.json());
app.use(morgan("tiny"));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "..", "public");
app.use(express.static(publicDir));

// --- Simple health ---
app.get("/health", (req, res) => res.json({ ok: true }));

// --- DB test (read-only) ---
app.get("/dbtest", async (req, res) => {
  try {
    const now = await query("select now()");
    const clubs = await query("select count(*)::int as n from information_schema.tables where table_name = 'clubs'");
    res.json({ ok: true, now: now.rows[0].now, hasClubsTable: clubs.rows[0].n > 0 });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- One-time migration/seed endpoints (PROTECT with token) ---
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

app.post("/admin/migrate", async (req, res) => {
  if (!checkToken(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  try {
    await query(schemaSQL);
    res.json({ ok: true, ran: "schema" });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/admin/seed", async (req, res) => {
  if (!checkToken(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  try {
    await query(seedSQL);
    res.json({ ok: true, ran: "seed" });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`TrackLinq server running on :${PORT}`));
