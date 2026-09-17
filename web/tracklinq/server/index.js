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
// ----- Runtime config for frontend -----
// Served before static files so gps.html / mapper.html can read environment variables
// without committing tokens to GitHub.
app.get("/config.js", (_req, res) => {
  const config = {
    MAPBOX_ACCESS_TOKEN: process.env.MAPBOX_ACCESS_TOKEN || ""
  };

  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(
    `window.DRIVEDEN_CONFIG = Object.assign({}, window.DRIVEDEN_CONFIG || {}, ${JSON.stringify(config)});`
  );
});

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

CREATE TABLE IF NOT EXISTS gps_devices (
  device_id TEXT PRIMARY KEY,
  device_name TEXT,
  client_name TEXT,
  install_date DATE,
  warranty_months INTEGER DEFAULT 36,
  cart_model TEXT,
  cart_serial TEXT,
  gps_serial TEXT,
  contact_name TEXT,
  contact_phone TEXT,
  contact_email TEXT,
  notes TEXT,
  assigned_short_code TEXT,
  assigned_course_name TEXT,
  last_course_id TEXT,
  last_course_name TEXT,
  last_short_code TEXT,
  last_login_mode TEXT,
  last_hole INTEGER,
  last_lat DOUBLE PRECISION,
  last_lng DOUBLE PRECISION,
  last_accuracy DOUBLE PRECISION,
  last_altitude DOUBLE PRECISION,
  last_view_mode TEXT,
  last_unit TEXT,
  app_version TEXT,
  user_agent TEXT,
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
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


// ========== DEVICE DASHBOARD + LIVE FLEET VIEW ==========
// Devices create themselves automatically by posting a heartbeat from gps.html.
// Dashboard read/edit endpoints are protected with either:
// - DriveDen admin PIN (default 02004 or DASHBOARD_ADMIN_PIN env var)
// - A course/club PIN from public/courses/index.json, scoped to that club/fleet

const DASHBOARD_ADMIN_PIN = normalizePin(process.env.DASHBOARD_ADMIN_PIN || "02004");
let gpsDevicesSchemaPromise = null;

const gpsDevicesSchemaSQL = `
CREATE TABLE IF NOT EXISTS gps_devices (
  device_id TEXT PRIMARY KEY,
  device_name TEXT,
  client_name TEXT,
  install_date DATE,
  warranty_months INTEGER DEFAULT 36,
  cart_model TEXT,
  cart_serial TEXT,
  gps_serial TEXT,
  contact_name TEXT,
  contact_phone TEXT,
  contact_email TEXT,
  notes TEXT,
  assigned_short_code TEXT,
  assigned_course_name TEXT,
  last_course_id TEXT,
  last_course_name TEXT,
  last_short_code TEXT,
  last_login_mode TEXT,
  last_hole INTEGER,
  last_lat DOUBLE PRECISION,
  last_lng DOUBLE PRECISION,
  last_accuracy DOUBLE PRECISION,
  last_altitude DOUBLE PRECISION,
  last_view_mode TEXT,
  last_unit TEXT,
  app_version TEXT,
  user_agent TEXT,
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gps_devices_last_seen ON gps_devices (last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_gps_devices_assigned_short_code ON gps_devices (assigned_short_code);
CREATE INDEX IF NOT EXISTS idx_gps_devices_last_short_code ON gps_devices (last_short_code);
`;

function ensureGpsDevicesSchema() {
  if (!gpsDevicesSchemaPromise) {
    gpsDevicesSchemaPromise = query(gpsDevicesSchemaSQL).catch((e) => {
      gpsDevicesSchemaPromise = null;
      throw e;
    });
  }
  return gpsDevicesSchemaPromise;
}

function cleanText(v, max = 255) {
  const s = String(v ?? "").replace(/\u0000/g, "").trim();
  return s ? s.slice(0, max) : null;
}

function cleanDeviceId(v) {
  const s = String(v ?? "").trim().replace(/[^a-zA-Z0-9_.:-]/g, "").slice(0, 90);
  return s || null;
}

function cleanInt(v, min = 0, max = 999999) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, n));
}

function cleanFloat(v, min = -Infinity, max = Infinity) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

function cleanDate(v) {
  const s = cleanText(v, 20);
  if (!s) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function getDashboardScope(pin) {
  const p = normalizePin(pin);
  if (!p) return null;
  if (DASHBOARD_ADMIN_PIN && p === DASHBOARD_ADMIN_PIN) {
    return { type: "admin", shortCode: null, name: "DriveDen Admin" };
  }
  const club = resolveCourseByPin(p);
  if (club) return { type: "club", shortCode: club.shortCode, name: club.name || club.shortCode };
  return null;
}

function requireDashboardAccess(req, res, next) {
  const pin = req.query.pin || req.body?.pin || req.header("x-dashboard-pin");
  try {
    const scope = getDashboardScope(pin);
    if (!scope) return res.status(401).json({ ok: false, error: "Invalid PIN" });
    req.dashboardScope = scope;
    next();
  } catch (e) {
    res.status(500).json({ ok: false, error: "Dashboard auth error" });
  }
}

function dashboardDeviceVisible(row, scope) {
  if (!row || !scope) return false;
  if (scope.type === "admin") return true;
  return (
    row.assigned_short_code === scope.shortCode ||
    (row.last_login_mode === "club" && row.last_short_code === scope.shortCode)
  );
}

const gpsDeviceSelectSQL = `
  device_id,
  COALESCE(device_name, 'Unassigned Device') AS device_name,
  client_name,
  install_date,
  warranty_months,
  CASE
    WHEN install_date IS NOT NULL AND warranty_months IS NOT NULL
      THEN (install_date + (warranty_months || ' months')::interval)::date
    ELSE NULL
  END AS warranty_until,
  cart_model,
  cart_serial,
  gps_serial,
  contact_name,
  contact_phone,
  contact_email,
  notes,
  assigned_short_code,
  assigned_course_name,
  last_course_id,
  last_course_name,
  last_short_code,
  last_login_mode,
  last_hole,
  last_lat,
  last_lng,
  last_accuracy,
  last_altitude,
  last_view_mode,
  last_unit,
  app_version,
  user_agent,
  first_seen_at,
  last_seen_at,
  updated_at,
  CASE
    WHEN last_seen_at >= NOW() - INTERVAL '2 minutes' THEN 'online'
    WHEN last_seen_at >= NOW() - INTERVAL '30 minutes' THEN 'recent'
    ELSE 'offline'
  END AS status,
  GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - last_seen_at)) / 60))::int AS last_seen_minutes
`;

function addDashboardScopeWhere(where, params, scope) {
  if (scope.type === "admin") return;
  params.push(scope.shortCode);
  const p = `$${params.length}`;
  where.push(`(assigned_short_code = ${p} OR (last_login_mode = 'club' AND last_short_code = ${p}))`);
}

app.post("/api/devices/heartbeat", async (req, res) => {
  try {
    await ensureGpsDevicesSchema();

    const b = req.body || {};
    const deviceId = cleanDeviceId(b.deviceId);
    if (!deviceId) return res.status(400).json({ ok: false, error: "deviceId required" });

    const loginMode = cleanText(b.loginMode, 20) === "club" ? "club" : "guest";
    const shortCode = safeId(b.shortCode || b.courseShortCode || b.short_code) || null;
    const courseId = cleanText(b.courseId, 120) || shortCode || null;
    const courseName = cleanText(b.courseName, 180);
    const lat = cleanFloat(b.lat, -90, 90);
    const lng = cleanFloat(b.lng, -180, 180);

    const insertAssignedShortCode = loginMode === "club" ? shortCode : null;
    const insertAssignedCourseName = loginMode === "club" ? courseName : null;

    const { rows } = await query(
      `INSERT INTO gps_devices (
          device_id, device_name,
          assigned_short_code, assigned_course_name,
          last_course_id, last_course_name, last_short_code, last_login_mode,
          last_hole, last_lat, last_lng, last_accuracy, last_altitude,
          last_view_mode, last_unit, app_version, user_agent,
          first_seen_at, last_seen_at, updated_at
        ) VALUES (
          $1, $2,
          $3, $4,
          $5, $6, $7, $8,
          $9, $10, $11, $12, $13,
          $14, $15, $16, $17,
          NOW(), NOW(), NOW()
        )
        ON CONFLICT (device_id) DO UPDATE SET
          last_course_id = EXCLUDED.last_course_id,
          last_course_name = EXCLUDED.last_course_name,
          last_short_code = EXCLUDED.last_short_code,
          last_login_mode = EXCLUDED.last_login_mode,
          last_hole = EXCLUDED.last_hole,
          last_lat = COALESCE(EXCLUDED.last_lat, gps_devices.last_lat),
          last_lng = COALESCE(EXCLUDED.last_lng, gps_devices.last_lng),
          last_accuracy = COALESCE(EXCLUDED.last_accuracy, gps_devices.last_accuracy),
          last_altitude = COALESCE(EXCLUDED.last_altitude, gps_devices.last_altitude),
          last_view_mode = EXCLUDED.last_view_mode,
          last_unit = EXCLUDED.last_unit,
          app_version = EXCLUDED.app_version,
          user_agent = EXCLUDED.user_agent,
          assigned_short_code = COALESCE(gps_devices.assigned_short_code,
            CASE WHEN EXCLUDED.last_login_mode = 'club' THEN EXCLUDED.last_short_code ELSE NULL END),
          assigned_course_name = COALESCE(gps_devices.assigned_course_name,
            CASE WHEN EXCLUDED.last_login_mode = 'club' THEN EXCLUDED.last_course_name ELSE NULL END),
          last_seen_at = NOW(),
          updated_at = NOW()
        RETURNING ${gpsDeviceSelectSQL}`,
      [
        deviceId,
        cleanText(b.deviceName, 120) || "Unassigned Device",
        insertAssignedShortCode,
        insertAssignedCourseName,
        courseId,
        courseName,
        shortCode,
        loginMode,
        cleanInt(b.hole, 1, 99),
        lat,
        lng,
        cleanFloat(b.accuracy, 0, 100000),
        cleanFloat(b.altitude, -1000, 10000),
        cleanText(b.viewMode, 40),
        cleanText(b.unit, 10),
        cleanText(b.appVersion, 80),
        cleanText(req.header("user-agent"), 300),
      ]
    );

    res.json({ ok: true, device: rows[0] });
  } catch (e) {
    console.error("device heartbeat failed", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/devices", requireDashboardAccess, async (req, res) => {
  try {
    await ensureGpsDevicesSchema();

    const where = [];
    const params = [];
    addDashboardScopeWhere(where, params, req.dashboardScope);

    const search = cleanText(req.query.q, 120);
    if (search) {
      params.push(`%${search}%`);
      const p = `$${params.length}`;
      where.push(`(
        device_id ILIKE ${p} OR device_name ILIKE ${p} OR client_name ILIKE ${p} OR
        assigned_course_name ILIKE ${p} OR last_course_name ILIKE ${p} OR
        cart_model ILIKE ${p} OR cart_serial ILIKE ${p} OR gps_serial ILIKE ${p}
      )`);
    }

    const status = cleanText(req.query.status, 30);
    if (status === "online") where.push("last_seen_at >= NOW() - INTERVAL '2 minutes'");
    if (status === "recent") where.push("last_seen_at < NOW() - INTERVAL '2 minutes' AND last_seen_at >= NOW() - INTERVAL '30 minutes'");
    if (status === "offline") where.push("last_seen_at < NOW() - INTERVAL '30 minutes'");
    if (status === "unassigned") where.push("(COALESCE(client_name, '') = '' AND COALESCE(assigned_short_code, '') = '')");

    const sqlWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const { rows } = await query(
      `SELECT ${gpsDeviceSelectSQL}
         FROM gps_devices
         ${sqlWhere}
        ORDER BY last_seen_at DESC NULLS LAST, first_seen_at DESC`,
      params
    );

    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, scope: req.dashboardScope, devices: rows });
  } catch (e) {
    console.error("device list failed", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/devices/:deviceId", requireDashboardAccess, async (req, res) => {
  try {
    await ensureGpsDevicesSchema();
    const deviceId = cleanDeviceId(req.params.deviceId);
    const { rows } = await query(`SELECT ${gpsDeviceSelectSQL} FROM gps_devices WHERE device_id = $1 LIMIT 1`, [deviceId]);
    if (!rows.length) return res.status(404).json({ ok: false, error: "not_found" });
    if (!dashboardDeviceVisible(rows[0], req.dashboardScope)) return res.status(403).json({ ok: false, error: "forbidden" });
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, scope: req.dashboardScope, device: rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.patch("/api/devices/:deviceId", requireDashboardAccess, async (req, res) => {
  try {
    await ensureGpsDevicesSchema();
    const deviceId = cleanDeviceId(req.params.deviceId);
    if (!deviceId) return res.status(400).json({ ok: false, error: "deviceId required" });

    const existing = await query(`SELECT * FROM gps_devices WHERE device_id = $1 LIMIT 1`, [deviceId]);
    if (!existing.rows.length) return res.status(404).json({ ok: false, error: "not_found" });
    if (!dashboardDeviceVisible(existing.rows[0], req.dashboardScope)) return res.status(403).json({ ok: false, error: "forbidden" });

    const b = req.body || {};
    const allowed = [
      ["device_name", cleanText(b.device_name ?? b.deviceName, 120)],
      ["client_name", cleanText(b.client_name ?? b.clientName, 160)],
      ["install_date", cleanDate(b.install_date ?? b.installDate)],
      ["warranty_months", cleanInt(b.warranty_months ?? b.warrantyMonths, 0, 240)],
      ["cart_model", cleanText(b.cart_model ?? b.cartModel, 140)],
      ["cart_serial", cleanText(b.cart_serial ?? b.cartSerial, 140)],
      ["gps_serial", cleanText(b.gps_serial ?? b.gpsSerial, 140)],
      ["contact_name", cleanText(b.contact_name ?? b.contactName, 160)],
      ["contact_phone", cleanText(b.contact_phone ?? b.contactPhone, 80)],
      ["contact_email", cleanText(b.contact_email ?? b.contactEmail, 180)],
      ["notes", cleanText(b.notes, 4000)],
    ];

    if (req.dashboardScope.type === "admin") {
      allowed.push(["assigned_short_code", safeId(b.assigned_short_code ?? b.assignedShortCode) || null]);
      allowed.push(["assigned_course_name", cleanText(b.assigned_course_name ?? b.assignedCourseName, 180)]);
    }

    const sets = [];
    const params = [];
    for (const [field, value] of allowed) {
      if (Object.prototype.hasOwnProperty.call(b, field) || Object.prototype.hasOwnProperty.call(b, field.replace(/_([a-z])/g, (_, c) => c.toUpperCase()))) {
        params.push(value);
        sets.push(`${field} = $${params.length}`);
      }
    }

    if (!sets.length) {
      const { rows } = await query(`SELECT ${gpsDeviceSelectSQL} FROM gps_devices WHERE device_id = $1 LIMIT 1`, [deviceId]);
      return res.json({ ok: true, scope: req.dashboardScope, device: rows[0] });
    }

    params.push(deviceId);
    const { rows } = await query(
      `UPDATE gps_devices
          SET ${sets.join(", ")}, updated_at = NOW()
        WHERE device_id = $${params.length}
        RETURNING ${gpsDeviceSelectSQL}`,
      params
    );

    res.json({ ok: true, scope: req.dashboardScope, device: rows[0] });
  } catch (e) {
    console.error("device update failed", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

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
