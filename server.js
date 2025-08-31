// server.js — DriveDen (no third-party GI deps)
const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 8080;

// healthcheck for Railway
app.get('/healthz', (req, res) => res.json({ ok: true }));

// static site
app.use(express.static(path.join(__dirname, 'web'), {
  maxAge: '1h',
  setHeaders: (res, filepath) => {
    if (/\.(json|html|js|css|svg|png|jpg|webp|ico|map)$/i.test(filepath)) {
      res.setHeader('Cache-Control', 'public, max-age=60');
    }
  }
}));

app.listen(PORT, () => {
  console.log(`DriveDen listening on ${PORT}`);
});
