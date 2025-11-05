// TrackLinq GPS — Service Worker for offline support
const CACHE_NAME = 'tracklinq-v3';
const APP_SHELL = [
  '/gps.html',
  '/mapper.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(APP_SHELL);
    })()
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.map(n => n !== CACHE_NAME && caches.delete(n)));
    })()
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== 'GET') return;

  // For navigations (HTML pages): network first
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const net = await fetch(req);
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, net.clone());
        return net;
      } catch {
        const cache = await caches.open(CACHE_NAME);
        return (await cache.match(req)) || (await cache.match('/gps.html'));
      }
    })());
    return;
  }

  // For JSON/images: stale-while-revalidate
  if (url.pathname.endsWith('.json') || req.destination === 'image') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req);
      const net = fetch(req).then(r => {
        cache.put(req, r.clone());
        return r;
      }).catch(() => null);
      return cached || net || fetch(req);
    })());
    return;
  }

  // Default: cache first, then network
  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    const net = await fetch(req);
    const cache = await caches.open(CACHE_NAME);
    cache.put(req, net.clone());
    return net;
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
