/* TrackLinq Service Worker */
const VERSION = 'tl-v5';
const SHELL = [
  '/',                     // your server resolves to /index.html
  '/index.html',
  '/login.html',
  '/gps.html',
  '/offline.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  // leaflet from CDN will be cached opportunistically by the browser;
  // we serve our own sw.js and let runtime cache handle other GETs
];

// Helpful console tag
const log = (...a) => console.log('[SW]', ...a);

/* Install: pre-cache app shell so PWA opens offline */
self.addEventListener('install', (evt) => {
  log('install', VERSION);
  evt.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

/* Activate: clean old caches */
self.addEventListener('activate', (evt) => {
  log('activate');
  evt.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n !== VERSION).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

/* Message API from pages */
self.addEventListener('message', (evt) => {
  const data = evt.data || {};
  if (data && data.type === 'cacheCourse' && data.courseId) {
    log('cacheCourse request for', data.courseId);
    evt.waitUntil(cacheCourse(data.courseId).then(() => {
      // progress 100% + done signal
      evt.source?.postMessage({ type: 'cacheDone', courseId: data.courseId });
    }).catch((err) => {
      log('cacheCourse error', err);
      evt.source?.postMessage({ type: 'cacheError', courseId: data.courseId, error: String(err) });
    }));
  }
});

/* Fetch strategy */
self.addEventListener('fetch', (evt) => {
  const url = new URL(evt.request.url);

  // Only handle our same-origin requests
  if (url.origin !== self.location.origin) return;

  // Course JSON (network first, cache fallback)
  if (url.pathname.startsWith('/courses/')) {
    evt.respondWith(networkFirst(evt.request));
    return;
  }

  // Navigations: try network, fall back to cached shell or offline
  if (evt.request.mode === 'navigate') {
    evt.respondWith((async () => {
      try {
        const res = await fetch(evt.request);
        // cache a fresh copy of the page for offline
        const cache = await caches.open(VERSION);
        cache.put(evt.request, res.clone());
        return res;
      } catch {
        // if we have gps/login/index cached, use them; else offline
        const cache = await caches.open(VERSION);
        const path = url.pathname;
        const prefer = ['/gps.html', '/login.html', '/index.html'];
        for (const p of [path, ...prefer]) {
          const match = await cache.match(p);
          if (match) return match;
        }
        return cache.match('/offline.html');
      }
    })());
    return;
  }

  // App shell & static assets: cache first
  if (SHELL.includes(url.pathname)) {
    evt.respondWith(cacheFirst(evt.request));
    return;
  }

  // Default: try cache, then network (saves things you visit)
  evt.respondWith(cacheFallingBackToNetwork(evt.request));
});

/* Helpers */

async function networkFirst(req) {
  try {
    const net = await fetch(req, { cache: 'no-store' });
    const c = await caches.open(VERSION);
    c.put(req, net.clone());
    return net;
  } catch {
    const c = await caches.open(VERSION);
    const hit = await c.match(req);
    if (hit) return hit;
    throw new Response('Offline and not cached', { status: 503 });
  }
}

async function cacheFirst(req) {
  const c = await caches.open(VERSION);
  const hit = await c.match(req);
  if (hit) return hit;
  const net = await fetch(req);
  c.put(req, net.clone());
  return net;
}

async function cacheFallingBackToNetwork(req) {
  const c = await caches.open(VERSION);
  const hit = await c.match(req);
  if (hit) return hit;
  try {
    const net = await fetch(req);
    c.put(req, net.clone());
    return net;
  } catch {
    // last resort
    return new Response('Offline', { status: 503 });
  }
}

/* Course prefetch */
async function cacheCourse(courseId) {
  const c = await caches.open(VERSION);
  // Always cache the index list too (lets us show "Available Offline" badges)
  const listReq = new Request('/courses/index.json', { cache: 'no-store' });
  try {
    const listRes = await fetch(listReq);
    await c.put(listReq, listRes.clone());
  } catch { /* ignore */ }

  const req = new Request(`/courses/${encodeURIComponent(courseId)}.json`, { cache: 'no-store' });
  const res = await fetch(req);
  await c.put(req, res.clone());

  // If later we add per-hole image assets or static overlays, we can queue them here.
  // We are purposely NOT caching remote map tiles (Esri) yet.
  return true;
}
