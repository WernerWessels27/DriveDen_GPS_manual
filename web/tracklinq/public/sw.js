/* TrackLinq Service Worker
   v2.1 (Leaflet + OSM/Esri offline, course JSON caching, PWA shell)
*/

const VERSION = 'v2.1';
const STATIC_CACHE = `static-${VERSION}`;
const RUNTIME_CACHE = `runtime-${VERSION}`;
const TILE_CACHE = `tiles-${VERSION}`;

const COURSE_INDEX = '/courses/index.json';

const CORE = [
  '/',
  '/index.html',
  '/gps.html',
  '/mapper.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  COURSE_INDEX,
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

async function cacheAddAll(cacheName, urls) {
  const cache = await caches.open(cacheName);
  await cache.addAll(urls);
}

async function preCacheCoursesFromIndex(cacheName) {
  try {
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
        } catch (_) {}
      }));
    }
  } catch (_) {}
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    await cacheAddAll(STATIC_CACHE, CORE);
    await preCacheCoursesFromIndex(STATIC_CACHE);
    self.skipWaiting();
  })());
});

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

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Tile servers: OSM + Esri World Imagery
  if (
    url.hostname.endsWith('tile.openstreetmap.org') ||
    url.hostname === 'server.arcgisonline.com'
  ) {
    event.respondWith((async () => {
      const cache = await caches.open(TILE_CACHE);
      const cached = await cache.match(req);
      if (cached) {
        event.waitUntil((async () => {
          try {
            const fresh = await fetch(req);
            await cache.put(req, fresh.clone());
          } catch (_) {}
        })());
        return cached;
      }
      try {
        const fresh = await fetch(req);
        await cache.put(req, fresh.clone());
        return fresh;
      } catch (_) {
        return new Response('', { status: 503 });
      }
    })());
    return;
  }

  // Leaflet CDN
  if (url.hostname === 'unpkg.com' && url.pathname.includes('/leaflet@')) {
    event.respondWith(cacheFirstSWR(req, STATIC_CACHE, null));
    return;
  }

  const isOwnOrigin = url.origin === self.location.origin;
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
    event.respondWith(cacheFirstSWR(
      req,
      STATIC_CACHE,
      (isStatic && req.mode === 'navigate') ? '/gps.html' : null
    ));
    return;
  }

  event.respondWith(networkFirst(req, RUNTIME_CACHE));
});

async function cacheFirstSWR(request, cacheName, navigationFallbackPath = null) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  if (cached) {
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

    if (request.destination === 'document') {
      const shell = await (await caches.open(STATIC_CACHE)).match('/gps.html');
      if (shell) return shell;
    }
    return new Response('Offline', { status: 503 });
  }
}
