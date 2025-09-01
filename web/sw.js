/* sw.js – DriveDen GPS */
const SW_VERSION = 'ddgps-v1.0.0';
const APP_SHELL = [
  '/',                 // index.html (served by express.static)
  '/webmanifest-fallback', // tiny trick added below
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

// Helper: open named cache
async function cacheOpen() {
  return await caches.open(SW_VERSION);
}

// Install: pre-cache app shell (icons + a tiny fallback)
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await cacheOpen();
    await cache.addAll(APP_SHELL.filter(Boolean));
    self.skipWaiting();
  })());
});

// Activate: cleanup old caches
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => (k !== SW_VERSION ? caches.delete(k) : null)));
    self.clients.claim();
  })());
});

// Runtime caching strategy
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Never cache health checks
  if (url.pathname.startsWith('/healthz')) return;

  // Course JSON & static: stale-while-revalidate
  if (url.pathname.startsWith('/courses/') ||
      url.pathname.endsWith('.json') ||
      url.pathname.endsWith('.js') ||
      url.pathname.endsWith('.css') ||
      url.pathname.endsWith('.svg') ||
      url.pathname.endsWith('.png') ||
      url.pathname.endsWith('.jpg') ||
      url.pathname.endsWith('.webp') ||
      url.pathname === '/' ) {

    event.respondWith((async () => {
      const cache = await cacheOpen();
      const cached = await cache.match(req);
      const network = fetch(req).then(res => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => null);
      return cached || network || new Response('Offline', { status: 503 });
    })());
    return;
  }

  // Map tiles (Esri/Carto/OpenTopoMap/MapTiler later): cache-first with network fallback
  if (
    /server\.arcgisonline\.com/.test(url.hostname) ||
    /basemaps\.cartocdn\.com/.test(url.hostname) ||
    /tile\.opentopomap\.org/.test(url.hostname) ||
    /tile\.openstreetmap\.org/.test(url.hostname) ||
    /maptiler\./.test(url.hostname)
  ) {
    event.respondWith((async () => {
      const cache = await cacheOpen();
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const net = await fetch(req, { mode: 'no-cors' }).catch(() => null) || await fetch(req);
        if (net && (net.ok || net.type === 'opaque')) {
          cache.put(req, net.clone());
          return net;
        }
      } catch {}
      return new Response(null, { status: 504 });
    })());
    return;
  }

  // Default: network-first, fallback to cache if any
  event.respondWith((async () => {
    try {
      const net = await fetch(req);
      return net;
    } catch {
      const cache = await cacheOpen();
      const cached = await cache.match(req);
      return cached || new Response('Offline', { status: 503 });
    }
  })());
});

