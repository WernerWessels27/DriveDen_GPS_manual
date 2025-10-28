// TrackLinq Service Worker
const SW_VERSION = 'tl-v1.0.3';
const CORE_CACHE = `core-${SW_VERSION}`;
const DATA_CACHE = `data-${SW_VERSION}`;

// What we precache (app shell)
const CORE_ASSETS = [
  '/',                 // Railway may serve /public as root
  '/login.html',
  '/gps.html',
  '/index.html',
  '/offline.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-192.png',
  '/icons/maskable-512.png',
  '/icons/apple-touch-icon-180.png'
];

// Utility: nav request?
const isNavigation = (req) => req.mode === 'navigate' || (req.method === 'GET' && req.headers.get('accept')?.includes('text/html'));

// Avoid caching 3rd-party map tiles (often CORS/no-store)
const isMapTile = (url) => /arcgisonline\.com\/ArcGIS\/rest\/services\/World_Imagery/i.test(url);

// Course JSON + index: cache-first (update in background)
const isCourseData = (url) => url.pathname.startsWith('/courses/') && url.pathname.endsWith('.json') || url.pathname === '/courses/index.json' || url.pathname.startsWith('/course/');

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CORE_CACHE);
    await cache.addAll(CORE_ASSETS.map(u => new Request(u, { cache: 'reload' })));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => {
      if (k !== CORE_CACHE && k !== DATA_CACHE) return caches.delete(k);
    }));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // HTML navigations: Network-first → fallback to cache → offline.html
  if (isNavigation(event.request)) {
    event.respondWith((async () => tryNetworkThenCache(event.request))());
    return;
  }

  // Course JSON: Cache-first, then network (and refresh cache in background)
  if (isCourseData(url)) {
    event.respondWith((async () => cacheFirstThenUpdate(event.request))());
    return;
  }

  // Map tiles: pass-through network (don’t cache)
  if (isMapTile(url)) {
    return; // default fetch
  }

  // Everything else: stale-while-revalidate from DATA_CACHE
  event.respondWith((async () => staleWhileRevalidate(event.request))());
});

// Strategies
async function tryNetworkThenCache(req) {
  const cache = await caches.open(CORE_CACHE);
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) {
      cache.put(req, fresh.clone());
      return fresh;
    }
    const cached = await cache.match(req);
    return cached || await caches.match('/offline.html');
  } catch {
    const cached = await cache.match(req);
    return cached || await caches.match('/offline.html');
  }
}

async function cacheFirstThenUpdate(req) {
  const cache = await caches.open(DATA_CACHE);
  const cached = await cache.match(req);
  const fetchAndUpdate = fetch(req)
    .then(res => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);

  // Serve cache immediately if present; otherwise wait for network
  return cached || (await fetchAndUpdate) || new Response('{}', { headers: { 'Content-Type': 'application/json' }});
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(DATA_CACHE);
  const cached = await cache.match(req);
  const network = fetch(req).then(res => {
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  return cached || (await network) || new Response('', { status: 504 });
}
