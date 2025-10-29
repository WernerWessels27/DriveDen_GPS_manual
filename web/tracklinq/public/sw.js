/* TrackLinq Service Worker
   v2.0 (Leaflet + OSM offline, course JSON caching, PWA shell)

   What it does:
   - Pre-caches app shell (gps.html, mapper.html, index.html, manifest, icons)
   - Caches Leaflet JS/CSS from CDN for offline use
   - Caches /courses/index.json and each /courses/{ID}.json listed inside it
   - Runtime cache for OpenStreetMap tiles (a/b/c.tile.openstreetmap.org)
   - Stale-while-revalidate for static assets & course JSON
   - Network-first for everything else with offline fallback to gps.html
*/

const VERSION = 'v2.0';
const STATIC_CACHE = `static-${VERSION}`;
const RUNTIME_CACHE = `runtime-${VERSION}`;
const TILE_CACHE = `tiles-${VERSION}`;

const COURSE_INDEX = '/courses/index.json';

// Adjust these to your actual files if paths differ
const CORE = [
  '/',                   // optional redirect to index.html (if you serve it)
  '/index.html',
  '/gps.html',
  '/mapper.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  COURSE_INDEX,

  // Leaflet CDN (for offline)
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

// ---- Helpers ---------------------------------------------------------------

async function cacheAddAll(cacheName, urls) {
  const cache = await caches.open(cacheName);
  await cache.addAll(urls);
}

async function preCacheCoursesFromIndex(cacheName) {
  try {
    // Try cache first then network for index (so install works offline if previously cached)
    const cached = await caches.match(COURSE_INDEX);
    let idxRes = cached;
    if (!idxRes) {
      idxRes = await fetch(COURSE_INDEX, { cache: 'no-cache' });
      const sc = await caches.open(cacheName);
      await sc.put(COURSE_INDEX, idxRes.clone());
    }
    const idx = await idxRes.json();
    const files = (idx.courses || []).map(c => `/courses/${c.id}.json`);
    if (files.length) {
      const sc = await caches.open(cacheName);
      await Promise.all(files.map(async (u) => {
        try {
          const r = await fetch(u, { cache: 'no-cache' });
          await sc.put(u, r.clone());
        } catch (_) { /* ignore */ }
      }));
    }
  } catch (_) {
    // no index yet, or offline first install – ignore
  }
}

// ---- Install ---------------------------------------------------------------

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    await cacheAddAll(STATIC_CACHE, CORE);
    await preCacheCoursesFromIndex(STATIC_CACHE);
    self.skipWaiting();
  })());
});

// ---- Activate --------------------------------------------------------------

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.map((k) => {
        if (![STATIC_CACHE, RUNTIME_CACHE, TILE_CACHE].includes(k)) {
          return caches.delete(k);
        }
      })
    );
    self.clients.claim();
  })());
});

// Allow page to trigger an immediate SW update if desired
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

// ---- Fetch strategy --------------------------------------------------------
// Rules (top to bottom):
// 1) OSM tiles -> cache-first (refresh in bg), store in TILE_CACHE
// 2) Leaflet CDN -> cache-first SWR (STATIC_CACHE)
// 3) Same-origin static (html/js/css/img/font) & course JSON -> cache-first SWR (STATIC_CACHE)
// 4) Everything else -> network-first, fallback to cache, then offline page

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 1) OSM tiles (subdomains a/b/c)
  if (url.hostname.endsWith('tile.openstreetmap.org')) {
    event.respondWith((async () => {
      const cache = await caches.open(TILE_CACHE);
      const cached = await cache.match(req);
      if (cached) {
        // Try to refresh in background
        event.waitUntil((async () => {
          try {
            const fresh = await fetch(req);
            await cache.put(req, fresh.clone());
          } catch (_) { /* offline */ }
        })());
        return cached;
      }
      // No cache: try network then store
      try {
        const fresh = await fetch(req);
        await cache.put(req, fresh.clone());
        return fresh;
      } catch (_) {
        // No tile available offline
        return new Response('', { status: 503 });
      }
    })());
    return;
  }

  // 2) Leaflet CDN assets
  if (url.hostname === 'unpkg.com' && url.pathname.includes('/leaflet@')) {
    event.respondWith(cacheFirstSWR(req, STATIC_CACHE, /*fallback*/ null));
    return;
  }

  const isOwnOrigin = url.origin === self.location.origin;

  // 3) Same-origin static + course JSON
  const isStatic = isOwnOrigin && (
    req.destination === 'document' ||
    req.destination === 'script' ||
    req.destination === 'style' ||
    req.destination === 'image' ||
    req.destination === 'font'
  );

  const isCourseJson =
    isOwnOrigin && (
      url.pathname === COURSE_INDEX ||
      (url.pathname.startsWith('/courses/') && url.pathname.endsWith('.json'))
    );

  if (isStatic || isCourseJson) {
    event.respondWith(cacheFirstSWR(req, STATIC_CACHE, /*fallback*/ isStatic && req.mode === 'navigate' ? '/gps.html' : null));
    return;
  }

  // 4) Default network-first
  event.respondWith(networkFirst(req, RUNTIME_CACHE));
});

// ---- Strategies ------------------------------------------------------------

async function cacheFirstSWR(request, cacheName, navigationFallbackPath = null) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  if (cached) {
    // Refresh in background
    try {
      const fresh = await fetch(request, { cache: 'no-cache' });
      await cache.put(request, fresh.clone());
    } catch (_) { /* offline */ }
    return cached;
  }

  try {
    const res = await fetch(request);
    await cache.put(request, res.clone());
    return res;
  } catch (_) {
    if (navigationFallbackPath && request.destination === 'document') {
      const fallback = await cache.match(navigationFallbackPath);
      if (fallback) return fallback;
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

    // If it's a navigation/doc, try gps.html as a shell
    if (request.destination === 'document') {
      const shell = await (await caches.open(STATIC_CACHE)).match('/gps.html');
      if (shell) return shell;
    }
    return new Response('Offline', { status: 503 });
  }
}
