/* TrackLinq Service Worker
   v2.3 — App shell + course JSON precache, OSM/Esri tile cache, offline login
*/

const VERSION = 'v2.3';
const STATIC_CACHE = `static-${VERSION}`;
const RUNTIME_CACHE = `runtime-${VERSION}`;
const TILE_CACHE = `tiles-${VERSION}`;

const COURSE_INDEX = '/courses/index.json';

// ---- Core app shell we want available offline (add anything you link to directly)
const CORE = [
  '/',                    // root
  '/index.html',          // main login
  '/login.html',          // legacy/simple login (if you use it)
  '/gps.html',            // main app
  '/mapper.html',         // mapper
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  COURSE_INDEX,

  // Leaflet (CDN)
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

// ---- Install: cache the shell and try to precache known course JSONs
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    await cacheAddAll(STATIC_CACHE, CORE);
    await preCacheCoursesFromIndex(STATIC_CACHE);
    await self.skipWaiting();
  })());
});

// ---- Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => {
      if (![STATIC_CACHE, RUNTIME_CACHE, TILE_CACHE].includes(k)) return caches.delete(k);
    }));
    await self.clients.claim();
  })());
});

// ---- Fetch handling
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 1) Map tiles: OSM + Esri (cache-first + background refresh)
  if (
    url.hostname.endsWith('tile.openstreetmap.org') ||
    url.hostname === 'server.arcgisonline.com'
  ) {
    event.respondWith(cacheTiles(req));
    return;
  }

  // 2) Leaflet CDN (cache-first)
  if (url.hostname === 'unpkg.com' && url.pathname.includes('/leaflet@')) {
    event.respondWith(cacheFirstSWR(req, STATIC_CACHE, null));
    return;
  }

  const isOwnOrigin = url.origin === self.location.origin;

  // 3) Static/site pages & assets (cache-first)
  const isStaticAsset = isOwnOrigin && (
    req.destination === 'document' ||
    req.destination === 'script' ||
    req.destination === 'style' ||
    req.destination === 'image' ||
    req.destination === 'font'
  );

  // 4) Course JSON (cache-first)
  const isCourseJson = isOwnOrigin && (
    url.pathname === COURSE_INDEX ||
    (url.pathname.startsWith('/courses/') && url.pathname.endsWith('.json'))
  );

  if (isStaticAsset || isCourseJson) {
    event.respondWith(cacheFirstSWR(
      req,
      STATIC_CACHE,
      // For navigations, fall back to index.html (so you can still enter when offline)
      (isStaticAsset && req.mode === 'navigate') ? '/index.html' : null
    ));
    return;
  }

  // 5) Everything else (network-first with offline fallback to /gps.html)
  event.respondWith(networkFirst(req, RUNTIME_CACHE));
});

// ---------- Helpers

async function cacheAddAll(cacheName, urls) {
  const cache = await caches.open(cacheName);
  await cache.addAll(urls);
}

async function preCacheCoursesFromIndex(cacheName) {
  try {
    // Try cache first
    let res = await caches.match(COURSE_INDEX);
    if (!res) {
      res = await fetch(COURSE_INDEX, { cache: 'no-cache' });
      const sc = await caches.open(cacheName);
      await sc.put(COURSE_INDEX, res.clone());
    }
    const idx = await res.json();
    const files = (idx.courses || []).map(c => `/courses/${c.id}.json`);
    if (files.length) {
      const sc = await caches.open(cacheName);
      await Promise.all(files.map(async (u) => {
        try {
          const r = await fetch(u, { cache: 'no-cache' });
          await sc.put(u, r.clone());
        } catch (_) {}
      }));
    }
  } catch (_) {}
}

async function cacheTiles(req) {
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(req);
  if (cached) {
    // Try to refresh in background
    try {
      const fresh = await fetch(req);
      await cache.put(req, fresh.clone());
    } catch (_) {}
    return cached;
  }
  try {
    const fresh = await fetch(req);
    await cache.put(req, fresh.clone());
    return fresh;
  } catch (_) {
    return new Response('', { status: 503 });
  }
}

async function cacheFirstSWR(request, cacheName, navigationFallbackPath = null) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  if (cached) {
    // background refresh
    try {
      const fresh = await fetch(request, { cache: 'no-cache' });
      await cache.put(request, fresh.clone());
    } catch (_) {}
    return cached;
  }

  try {
    const res = await fetch(request);
    await cache.put(request, res.clone());
    return res;
  } catch (_) {
    if (navigationFallbackPath && request.mode === 'navigate') {
      const fb = await cache.match(navigationFallbackPath);
      if (fb) return fb;
    }
    return new Response('Offline', { status: 503 });
  }
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request);
    cache.put(request, res.clone());
    return res;
  } catch (_) {
    const cached = await cache.match(request);
    if (cached) return cached;

    if (request.mode === 'navigate') {
      const shell = await (await caches.open(STATIC_CACHE)).match('/index.html');
      if (shell) return shell;
    }
    return new Response('Offline', { status: 503 });
  }
}
