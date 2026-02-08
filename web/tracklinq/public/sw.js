// TrackLinq GPS — Service Worker for offline support (offline-first + vendor precache)
// Updated to precache local Leaflet + Rotate plugin for full offline mode.

const CACHE_PREFIX = 'tracklinq-';
const CACHE_VERSION = 'v6';
const CACHE_NAME = `${CACHE_PREFIX}${CACHE_VERSION}`;

// Build absolute URLs relative to the SW scope (works on GitHub Pages subpaths too)
const SCOPE_URL = new URL(self.registration.scope);
const withScope = (path) => new URL(path.replace(/^\//, ''), SCOPE_URL).toString();

// App shell + local vendor libs (add more local assets here if needed)
const APP_SHELL = [
  'gps.html',
  'mapper.html',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',

  // Local (offline) Leaflet + rotation plugin
  'vendor/leaflet/leaflet.css',
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet-rotate/leaflet-rotate.js',
];

// Cache helper that won’t fail install if a file is missing (404) or temporarily unreachable
async function safePrecache(cache, paths) {
  const tasks = paths.map(async (p) => {
    const url = withScope(p);
    try {
      const res = await fetch(new Request(url, { cache: 'reload' }));
      if (!res || !res.ok) return; // ignore missing assets
      await cache.put(url, res.clone());
    } catch {
      // ignore fetch errors during install to avoid bricking offline capability
    }
  });
  await Promise.all(tasks);
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await safePrecache(cache, APP_SHELL);
  })());
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names.map((n) => (n.startsWith(CACHE_PREFIX) && n !== CACHE_NAME) ? caches.delete(n) : Promise.resolve())
    );
    await self.clients.claim();
  })());
});

// Strategy:
// - HTML navigations: network-first with offline fallback to cached gps.html
// - JSON + images: stale-while-revalidate (fast + keeps fresh when online)
// - CSS/JS/fonts: cache-first (since we want full offline)
// - Everything else: cache-first, then network
self.addEventListener('fetch', (event) => {
  const req = event.request;

  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const isSameOrigin = url.origin === self.location.origin;

  // Only handle same-origin requests; let cross-origin go to network
  if (!isSameOrigin) return;

  const pathname = url.pathname.toLowerCase();
  const isHtmlNav = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
  const isJson = pathname.endsWith('.json');
  const isImage = req.destination === 'image' || /\.(png|jpg|jpeg|gif|webp|svg|ico)$/.test(pathname);
  const isStatic = req.destination === 'style' || req.destination === 'script' || /\.(css|js|mjs|woff2?|ttf|otf)$/.test(pathname);

  // HTML pages: network first
  if (isHtmlNav) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const net = await fetch(req);
        // Cache the latest HTML for offline
        cache.put(req.url, net.clone());
        return net;
      } catch {
        // Try exact match, then fall back to gps.html (app entry)
        return (await cache.match(req.url)) || (await cache.match(withScope('gps.html')));
      }
    })());
    return;
  }

  // JSON / images: stale-while-revalidate
  if (isJson || isImage) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req.url);

      const netPromise = fetch(req).then((res) => {
        if (res && res.ok) cache.put(req.url, res.clone());
        return res;
      }).catch(() => null);

      return cached || (await netPromise) || fetch(req);
    })());
    return;
  }

  // CSS/JS/fonts and other static: cache-first
  if (isStatic) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req.url);
      if (cached) return cached;

      const net = await fetch(req);
      if (net && net.ok) cache.put(req.url, net.clone());
      return net;
    })());
    return;
  }

  // Default: cache-first, then network
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req.url);
    if (cached) return cached;

    const net = await fetch(req);
    if (net && net.ok) cache.put(req.url, net.clone());
    return net;
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
