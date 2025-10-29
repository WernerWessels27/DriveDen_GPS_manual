/* TrackLinq Service Worker — offline courses + shell
   Scope: / (registered from /web/tracklinq/public/*) */

const VERSION = 'tl-v5';
const SHELL = [
  '/login.html',
  '/gps.html',
  '/index.html',
  '/offline.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

// Caches
const CACHE_SHELL   = `shell-${VERSION}`;
const CACHE_COURSES = `courses-${VERSION}`;
const CACHE_RUNTIME = `runtime-${VERSION}`;

// Helper: safe fetch and cache
async function cachePut(cacheName, req, res) {
  try {
    const cache = await caches.open(cacheName);
    await cache.put(req, res.clone());
  } catch {}
  return res;
}

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE_SHELL);
    await c.addAll(SHELL);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // cleanup old caches
    const keep = new Set([CACHE_SHELL, CACHE_COURSES, CACHE_RUNTIME]);
    const names = await caches.keys();
    await Promise.all(names.map(n => keep.has(n) ? null : caches.delete(n)));
    await self.clients.claim();
  })());
});

const ESRI_RE = /server\.arcgisonline\.com\/ArcGIS\/rest\/services\/World_Imagery\/MapServer\/tile/;
const UNPKG_RE = /^(https:\/\/)?unpkg\.com\//;
const COURSES_RE = /^\/courses\/.+\.json$/;

// Network strategies
self.addEventListener('fetch', (e) => {
  const { request } = e;
  const url = new URL(request.url);

  // Navigation fallback
  if (request.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const res = await fetch(request);
        // cache a copy of navigations to shell cache (best effort)
        cachePut(CACHE_SHELL, request, res.clone());
        return res;
      } catch {
        return caches.match('/offline.html');
      }
    })());
    return;
  }

  // Courses JSON: cache-first (after cached)
  if (COURSES_RE.test(url.pathname)) {
    e.respondWith((async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      try {
        const res = await fetch(request, { cache: 'no-store' });
        return cachePut(CACHE_COURSES, request, res);
      } catch {
        // last resort: any cached course index
        return cached || new Response('{"error":"offline"}', { status: 503, headers: { 'Content-Type':'application/json' } });
      }
    })());
    return;
  }

  // Leaflet from unpkg — stale-while-revalidate
  if (UNPKG_RE.test(request.url)) {
    e.respondWith((async () => {
      const cached = await caches.match(request);
      const fetchPromise = fetch(request).then(res => cachePut(CACHE_RUNTIME, request, res));
      return cached || fetchPromise;
    })());
    return;
  }

  // Esri tiles — cache-first with cap
  if (ESRI_RE.test(request.url)) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE_RUNTIME);
      const cached = await cache.match(request);
      if (cached) return cached;
      try {
        const res = await fetch(request, { mode: 'no-cors' }); // opaque ok
        await cache.put(request, res.clone());
        // simple cap to ~400 tiles
        const keys = await cache.keys();
        if (keys.length > 400) await cache.delete(keys[0]);
        return res;
      } catch {
        return cached || Response.error();
      }
    })());
    return;
  }

  // Default: try network, fallback cache
  e.respondWith((async () => {
    try {
      const res = await fetch(request);
      return res;
    } catch {
      const cached = await caches.match(request);
      return cached || Response.error();
    }
  })());
});

// Message API: cache a course json now (+progress)
self.addEventListener('message', (e) => {
  const msg = e.data || {};
  if (msg.type === 'cacheCourse' && msg.courseId) {
    cacheCourseJson(msg.courseId).then(() => {
      postToAllClients({ type: 'cacheDone', courseId: msg.courseId });
    }).catch(() => {
      postToAllClients({ type: 'cacheDone', courseId: msg.courseId, error: true });
    });
  }
  if (msg.type === 'listCachedCourses') {
    listCachedCourses().then(list => {
      e.source?.postMessage({ type: 'cachedCourses', list });
    });
  }
});

async function cacheCourseJson(courseId) {
  const url = `/courses/${encodeURIComponent(courseId)}.json`;
  // basic progress: 0 -> 100 (single asset)
  postToAllClients({ type: 'cacheCourseProgress', courseId, percent: 5, label: 'Requesting' });
  const res = await fetch(url, { cache: 'no-store' });
  postToAllClients({ type: 'cacheCourseProgress', courseId, percent: 60, label: 'Saving' });
  await cachePut(CACHE_COURSES, new Request(url), res);
  postToAllClients({ type: 'cacheCourseProgress', courseId, percent: 100, label: 'Done' });
}

async function listCachedCourses() {
  const cache = await caches.open(CACHE_COURSES);
  const keys = await cache.keys();
  return keys
    .map(k => {
      const m = k.url.match(/\/courses\/(.+)\.json$/);
      return m ? decodeURIComponent(m[1]) : null;
    })
    .filter(Boolean);
}

function postToAllClients(payload) {
  self.clients.matchAll({ includeUncontrolled: true, type: 'window' })
    .then(clients => clients.forEach(c => c.postMessage(payload)))
    .catch(() => {});
}
