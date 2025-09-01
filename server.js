// server.js — DriveDen (no GI; with elevation proxy)
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

// Healthcheck (Railway)
app.get('/healthz', (req, res) => res.json({ ok: true }));

// ---- Elevation proxy (fixes browser CORS) ----
// Uses Node 18+ native fetch (no extra deps needed).
app.get('/elevation', async (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) {
    return res.status(400).json({ error: 'Missing lat/lng' });
  }
  try {
    const url = `https://api.opentopodata.org/v1/srtm90m?locations=${lat},${lng}`;
    const r = await fetch(url);
    const data = await r.json();
    res.setHeader('Cache-Control', 'public, max-age=300'); // 5 min
    return res.json(data);
  } catch (err) {
    console.error('Elevation proxy error:', err);
    return res.status(502).json({ error: 'Elevation lookup failed' });
  }
});

//ADD 404 ROLLBACK WERNER
// Small noop endpoint used by SW to warm cache safely
app.get('/webmanifest-fallback', (_req, res) => res.type('text/plain').send('ok'));

// Static site
app.use(
  express.static(path.join(__dirname, 'web'), {
    maxAge: '1h',
    setHeaders: (res, filepath) => {
      if (/\.(json|html|js|css|svg|png|jpg|jpeg|webp|ico|map)$/i.test(filepath)) {
        res.setHeader('Cache-Control', 'public, max-age=60');
      }
    },
  })
);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`DriveDen listening on ${PORT}`);
});
