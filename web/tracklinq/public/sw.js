// DriveDen GPS — Service Worker (offline-first + smart ads caching)
// v8: fixes cache key normalization + adds offline-friendly Ads strategy
//
// Goals:
// - GPS stays fully offline-capable (app shell + vendor + courses)
// - Club ads work offline (cache ads.json + images)
// - Ads update automatically when online (stale-while-revalidate for ads.json)
// - Do NOT cache /api/ads/* mutation endpoints (upload/delete) to avoid stale failures

const CACHE_PREFIX = 'driveden-gps-';
const CACHE_VERSION = 'v8';
const CACHE_NAME = `${CACHE_PREFIX}${CACHE_VERSION}`;

// Build absolute URLs relative to the SW scope (works on subpaths too)
const SCOPE_URL = new URL(self.registration.scope);
const withScope = (path) => new URL(path.replace(/^\//, ''), SCOPE_URL).toString();

// App shell + local vendor libs (add more local assets here if needed)
const APP_SHELL = [
  'gps.html',
  'mapper.html',
  'ad-manager.html',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',

  // Local (offline) Leaflet + rotation plugin
  'vendor/leaflet/leaflet.css',
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet-rotate/leaflet-rotate.js',

  // OPTIONAL: If you add a guest idle splash image, add it here too, e.g.:
  // 'images/guest-idle.png',
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

// Normalize cache keys (ignore cache-busting params like ?ts=...)
// Also strips typical "cache bust" params, but keeps meaningful ones.
function normalizeUrlForCache(input) {
  const u = new URL(typeof input === 'string' ? input : input.url);

  // common cache-busters
  ['ts', 't', 'v', '_'].forEach((k) => {
    if (u.searchParams.has(k)) u.searchParams.delete(k);
  });

  return u.toString();
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

// Helpers
async function cachePutNormalized(cache, req, res) {
  const key = normalizeUrlForCache(req);
  await cache.put(key, res.clone());
}

async function cacheMatchNormalized(cache, req) {
  const key = normalizeUrlForCache(req);
  return cache.match(key);
}

// Strategies:
// - HTML navigations: network-first with offline fallback to cached gps.html
// - /api/ads/* (manager endpoints): network-only (do not cache)
// - /ads/*/ads.json : stale-while-revalidate (offline works; refresh when online)
// - /ads/* images: cache-first (offline works; refresh when online via versioned filenames)
// - Other JSON/images: stale-while-revalidate
// - CSS/JS/fonts: cache-first
// - Everything else: cache-first, then network
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const isSameOrigin = url.origin === self.location.origin;
  if (!isSameOrigin) return;

  const pathname = url.pathname.toLowerCase();
  const isHtmlNav = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');

  const isApiAds = pathname.startsWith('/api/ads/');
  const isAdsJson = pathname.startsWith('/ads/') && pathname.endsWith('/ads.json');
  const isAdsAsset = pathname.startsWith('/ads/') && !pathname.endsWith('/ads.json');

  const isJson = pathname.endsWith('.json');
  const isImage = req.destination === 'image' || /\.(png|jpg|jpeg|gif|webp|svg|ico)$/.test(pathname);
  const isStatic = req.destination === 'style' || req.destination === 'script' || /\.(css|js|mjs|woff2?|ttf|otf)$/.test(pathname);

  // 1) HTML navigations: network-first
  if (isHtmlNav) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const net = await fetch(req);
        if (net && net.ok) await cachePutNormalized(cache, req, net);
        return net;
      } catch {
        return (await cacheMatchNormalized(cache, req)) || (await cache.match(withScope('gps.html')));
      }
    })());
    return;
  }

  // 2) Ads Manager API: network-only (never cache)
  if (isApiAds) {
    event.respondWith(fetch(req));
    return;
  }

  // 3) ads.json: stale-while-revalidate
  if (isAdsJson) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cacheMatchNormalized(cache, req);

      const netPromise = fetch(req).then(async (res) => {
        if (res && res.ok) await cachePutNormalized(cache, req, res);
        return res;
      }).catch(() => null);

      return cached || (await netPromise) || new Response(JSON.stringify({ ads: [] }), {
        headers: { 'Content-Type': 'application/json' }
      });
    })());
    return;
  }

  // 4) Ad images/assets: cache-first
  if (isAdsAsset && isImage) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cacheMatchNormalized(cache, req);
      if (cached) return cached;

      try {
        const net = await fetch(req);
        if (net && net.ok) await cachePutNormalized(cache, req, net);
        return net;
      } catch {
        return cached || new Response('', { status: 404 });
      }
    })());
    return;
  }

  // 5) Other JSON/images: stale-while-revalidate
  if (isJson || isImage) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cacheMatchNormalized(cache, req);

      const netPromise = fetch(req).then(async (res) => {
        if (res && res.ok) await cachePutNormalized(cache, req, res);
        return res;
      }).catch(() => null);

      return cached || (await netPromise) || new Response('', { status: 504 });
    })());
    return;
  }

  // 6) CSS/JS/fonts: cache-first
  if (isStatic) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cacheMatchNormalized(cache, req);
      if (cached) return cached;

      const net = await fetch(req);
      if (net && net.ok) await cachePutNormalized(cache, req, net);
      return net;
    })());
    return;
  }

  // 7) Default: cache-first, then network
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cacheMatchNormalized(cache, req);
    if (cached) return cached;

    const net = await fetch(req);
    if (net && net.ok) await cachePutNormalized(cache, req, net);
    return net;
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
