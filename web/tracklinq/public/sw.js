/* TrackLinq SW v3 */
const APP = 'tl-app-v3';
const COURSES = 'tl-courses-v1';
const TILES = 'tl-tiles-v1';

const SHELL = [
  '/index.html',
  '/login.html',
  '/gps.html',
  '/offline.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  // Leaflet core (runtime cached too, but nice to warm)
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const c = await caches.open(APP);
    await c.addAll(SHELL.map(u => new Request(u, {cache: 'reload'})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // cleanup old caches
    const keep = new Set([APP, COURSES, TILES]);
    for (const name of await caches.keys()) {
      if (!keep.has(name)) await caches.delete(name);
    }
    // enable nav preload where supported
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch {}
    }
    await self.clients.claim();
  })());
});

function isCourseJson(req) {
  try {
    const url = new URL(req.url);
    return (url.origin === self.location.origin) &&
           (url.pathname.startsWith('/courses/') || url.pathname.startsWith('/tracklinq/public/courses/')) &&
           url.pathname.endsWith('.json');
  } catch { return false; }
}

function isLeafletTile(req) {
  const url = new URL(req.url);
  return /server\.arcgisonline\.com/i.test(url.hostname) ||
         /tile\.openstreetmap\.org/i.test(url.hostname);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // 1) Navigation requests: network-first → cache → offline.html
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const preload = await event.preloadResponse;
        if (preload) return preload;
        const net = await fetch(request);
        // cache a fresh copy of gps/index when online
        const cache = await caches.open(APP);
        cache.put(new Request('/gps.html'), await fetch('/gps.html'));
        cache.put(new Request('/index.html'), await fetch('/index.html'));
        return net;
      } catch {
        const cache = await caches.open(APP);
        return (await cache.match(request.url)) ||
               (await cache.match('/gps.html')) ||
               (await cache.match('/index.html')) ||
               (await cache.match('/offline.html'));
      }
    })());
    return;
  }

  // 2) Course JSON: Cache-first (stale-while-revalidate)
  if (isCourseJson(request)) {
    event.respondWith((async () => {
      const cache = await caches.open(COURSES);
      const cached = await cache.match(request);
      const fetchAndUpdate = fetch(request).then(res => {
        if (res && res.ok) cache.put(request, res.clone());
        return res;
      }).catch(() => null);

      if (cached) {
        // kick off background refresh
        event.waitUntil(fetchAndUpdate);
        return cached;
      }
      return (await fetchAndUpdate) || new Response('{}', {headers:{'Content-Type':'application/json'}});
    })());
    return;
  }

  // 3) Leaflet tiles: Cache-first with small cap (best-effort)
  if (isLeafletTile(request)) {
    event.respondWith((async () => {
      const cache = await caches.open(TILES);
      const cached = await cache.match(request);
      if (cached) return cached;
      try {
        const net = await fetch(request, { mode: 'no-cors' }); // opaque ok
        // naive cap
        const keys = await cache.keys();
        if (keys.length > 200) await cache.delete(keys[0]);
        cache.put(request, net.clone());
        return net;
      } catch {
        return cached || Response.error();
      }
    })());
    return;
  }

  // 4) Default: try network then cache
  event.respondWith((async () => {
    try {
      return await fetch(request);
    } catch {
      const cache = await caches.open(APP);
      return (await cache.match(request)) || Response.error();
    }
  })());
});
