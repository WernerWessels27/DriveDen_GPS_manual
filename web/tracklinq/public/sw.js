/* service-worker.js */
const SW_VERSION = 'tl-sw-v3';
const PRECACHE = `tl-precache-${SW_VERSION}`;
const RUNTIME = `tl-runtime-${SW_VERSION}`;

// One cache per course pack so we can wipe/upgrade cleanly per course/version in the future
const courseCacheName = (courseId) => `tl-pack-${courseId}-${SW_VERSION}`;

// ESRI tiles used in gps.html
const ESRI_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

const CORE_ASSETS = [
  '/',                // adjust if your root is different
  '/index.html',      // if you use a landing
  '/gps.html',
  '/offline.html',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

// --- helpers ---
const isSameOrigin = (url) => new URL(url, self.location.origin).origin === self.location.origin;

function postToAllClients(data){
  self.clients.matchAll({includeUncontrolled: true, type: 'window'}).then(clients=>{
    clients.forEach(c=>c.postMessage(data));
  });
}

// Web Mercator helpers for XYZ tiling
function deg2rad(d){ return d * Math.PI / 180; }
function latLngToTileXY(lat, lng, z){
  const x = Math.floor((lng + 180) / 360 * Math.pow(2, z));
  const y = Math.floor(
    (1 - Math.log(Math.tan(deg2rad(lat)) + 1/Math.cos(deg2rad(lat))) / Math.PI) / 2 * Math.pow(2, z)
  );
  return {x,y};
}
function tileUrl(z, x, y){
  return ESRI_TILES.replace('{z}', z).replace('{x}', x).replace('{y}', y);
}

// Crude meters→degrees buffer (good enough for ~hundreds of meters)
function bufferBBoxMeters(bbox, meters=120){
  const latMid = (bbox.s + bbox.n)/2;
  const dLat = meters / 111320;
  const dLng = meters / (111320 * Math.max(0.1, Math.cos(deg2rad(latMid))));
  return { w: bbox.w - dLng, s: bbox.s - dLat, e: bbox.e + dLng, n: bbox.n + dLat };
}

// Build a bbox around tee & green for a hole
function bboxFromHole(h){
  const pts = [];
  if (h.tee) pts.push(h.tee);
  if (h.green?.front) pts.push(h.green.front);
  if (h.green?.mid)   pts.push(h.green.mid);
  if (h.green?.back)  pts.push(h.green.back);
  if (pts.length === 0 && h.green?.center) pts.push(h.green.center);

  if (!pts.length) return null;
  let w=Infinity, s=Infinity, e=-Infinity, n=-Infinity;
  pts.forEach(p=>{
    w = Math.min(w, p.lng);
    e = Math.max(e, p.lng);
    s = Math.min(s, p.lat);
    n = Math.max(n, p.lat);
  });
  return {w,s,e,n};
}

function expandTilesForBBox(bbox, zooms=[16,17,18,19]){
  const urls = new Set();
  zooms.forEach(z=>{
    const nw = latLngToTileXY(bbox.n, bbox.w, z);
    const se = latLngToTileXY(bbox.s, bbox.e, z);
    const xMin = Math.min(nw.x, se.x), xMax = Math.max(nw.x, se.x);
    const yMin = Math.min(nw.y, se.y), yMax = Math.max(nw.y, se.y);
    for(let x=xMin; x<=xMax; x++){
      for(let y=yMin; y<=yMax; y++){
        urls.add(tileUrl(z, x, y));
      }
    }
  });
  return Array.from(urls);
}

async function safeCachePut(cache, req, res){
  try {
    // opaque (no-cors) responses cannot be cloned multiple times safely; still cacheable
    await cache.put(req, res);
  } catch (e) {
    // ignore cache put errors to keep flow (e.g., method not GET)
  }
}

async function fetchAndCache(cache, url, opts={}){
  // Progress-friendly fetch: default to no-cors for cross-origin tiles
  const same = isSameOrigin(url);
  const init = same ? {} : { mode: 'no-cors' };
  const resp = await fetch(url, opts.fetchInit || init);
  // Clone only if needed elsewhere
  await safeCachePut(cache, new Request(url, {mode: init.mode}), resp.clone ? resp.clone() : resp);
  return resp;
}

// --- installation / activation ---
self.addEventListener('install', (event)=>{
  event.waitUntil(
    caches.open(PRECACHE).then(cache=>cache.addAll(CORE_ASSETS)).then(()=>self.skipWaiting())
  );
});

self.addEventListener('activate', (event)=>{
  event.waitUntil((async ()=>{
    const names = await caches.keys();
    await Promise.all(
      names.map(n=>{
        if (![PRECACHE, RUNTIME].includes(n) && !n.startsWith('tl-pack-')) {
          return caches.delete(n);
        }
      })
    );
    await self.clients.claim();
  })());
});

// --- message: drive course pack caching ---
self.addEventListener('message', (event)=>{
  const data = event.data || {};
  if (data.type === 'cacheCoursePack' && data.courseId) {
    event.waitUntil(cacheCoursePack(data.courseId));
  }
});

async function cacheCoursePack(courseId){
  const send = (payload)=> postToAllClients({courseId, ...payload});

  try{
    send({ type:'cacheProgress', percent: 0, label: 'Starting…' });

    // Open / create dedicated cache for this course
    const courseCache = await caches.open(courseCacheName(courseId));

    // 1) Fetch course JSON (from /courses OR /course, same as gps.html fallback)
    let courseJson, courseUrlTried = [];
    const coursePaths = [`/courses/${encodeURIComponent(courseId)}.json`, `/course/${encodeURIComponent(courseId)}.json`];

    for (const url of coursePaths){
      try{
        const res = await fetch(url, {cache:'no-store'});
        if (res.ok) {
          await safeCachePut(courseCache, new Request(url), res.clone());
          courseJson = await res.json();
          courseUrlTried = [url];
          break;
        }
      }catch{}
      courseUrlTried.push(url);
    }

    if (!courseJson) {
      throw new Error(`Course JSON not found at ${courseUrlTried.join(' or ')}`);
    }

    const root = courseJson.course || courseJson;
    const holes = (root.holes||[]).map(h=>({
      number: (h.number??h.hole??h.holeNumber??null)*1,
      tee:    h.tee && h.tee.lat!=null && h.tee.lng!=null ? {lat:+h.tee.lat, lng:+h.tee.lng} : null,
      green:  {
        front: h.green?.front||null,
        mid:   h.green?.mid||null,
        back:  h.green?.back||null,
        center:h.green?.center||h.green?.mid||null
      }
    })).filter(h=>Number.isFinite(h.number));

    // 2) Build elevation request URLs to store offline (front/mid/back per hole when present)
    const elevUrls = [];
    function pushElev(pt){
      if(!pt || pt.lat==null || pt.lng==null) return;
      const u = `/elevation?lat=${pt.lat}&lng=${pt.lng}`;
      elevUrls.push(u);
    }
    holes.forEach(h=>{
      pushElev(h.green.front);
      pushElev(h.green.mid || h.green.center);
      pushElev(h.green.back);
    });

    // 3) Compute tile URLs around each hole bbox (with buffer), zooms 16–19
    const tileUrlsSet = new Set();
    holes.forEach(h=>{
      const bb = bboxFromHole(h);
      if(!bb) return;
      const buffered = bufferBBoxMeters(bb, 140); // ~140m margin
      const urls = expandTilesForBBox(buffered, [16,17,18,19]);
      urls.forEach(u=>tileUrlsSet.add(u));
    });
    const tileUrls = Array.from(tileUrlsSet);

    // Totals for progress
    const total = 1 + elevUrls.length + tileUrls.length; // 1 = course json
    let done = 0;
    const tick = (label)=>{
      done++;
      const percent = Math.min(100, Math.round((done/Math.max(1,total))*100));
      send({ type:'cacheProgress', percent, label });
    };

    tick('Course data cached');

    // Fetch & cache elevations (same-origin → OK)
    for (const u of elevUrls){
      try{ await fetchAndCache(courseCache, u); }
      catch(_){} // keep going
      tick('Saving elevations…');
    }

    // Fetch & cache tiles (cross-origin → no-cors)
    for (const u of tileUrls){
      try{ await fetchAndCache(courseCache, u, { fetchInit: { mode:'no-cors' } }); }
      catch(_){} // keep going
      tick('Saving map tiles…');
    }

    send({ type:'cacheDone' });
  }catch(err){
    postToAllClients({ type:'cacheError', courseId, error: String(err && err.message || err) });
  }
}

// --- fetch strategy ---
// 1) Course JSON & elevations: cache-first, then network fallback to update runtime cache
// 2) ESRI tiles: cache-first, network fallback (opaque OK)
// 3) Other same-origin assets: try cache, then network
// 4) Navigations → offline.html when both fail
self.addEventListener('fetch', (event)=>{
  const req = event.request;
  const url = new URL(req.url);

  // Only GET requests are cacheable here
  if (req.method !== 'GET') return;

  const isEsri = url.href.includes('server.arcgisonline.com/ArcGIS/rest/services/World_Imagery');

  // Handle navigations: offline fallback
  if (req.mode === 'navigate') {
    event.respondWith((async ()=>{
      try{
        const net = await fetch(req);
        return net;
      }catch{
        const cache = await caches.open(PRECACHE);
        const offline = await cache.match('/offline.html');
        return offline || new Response('<h1>Offline</h1>', {headers:{'Content-Type':'text/html'}});
      }
    })());
    return;
  }

  // Course JSON / Elevation
  if (isSameOrigin(url.href) && (url.pathname.startsWith('/courses/') || url.pathname.startsWith('/course/'))) {
    // Cache-first (course pack cache might hold it)
    event.respondWith((async ()=>{
      const cachesToCheck = await caches.keys();
      // Look through pack caches first
      for (const name of cachesToCheck){
        if (name.startsWith('tl-pack-')){
          const hit = await caches.open(name).then(c=>c.match(req));
          if (hit) return hit;
        }
      }
      // Precache/runtime
      const pre = await caches.open(PRECACHE).then(c=>c.match(req));
      if (pre) return pre;

      try{
        const net = await fetch(req, {cache:'no-store'});
        const run = await caches.open(RUNTIME);
        await safeCachePut(run, req, net.clone());
        return net;
      }catch{
        // last resort: runtime cache
        const run = await caches.open(RUNTIME);
        const cached = await run.match(req);
        if (cached) return cached;
        throw new Error('offline');
      }
    })());
    return;
  }

  if (isSameOrigin(url.href) && url.pathname.startsWith('/elevation')) {
    // cache-first: if we prefetched the exact lat/lng, it'll hit
    event.respondWith((async ()=>{
      // Check any course pack cache
      const names = await caches.keys();
      for (const n of names){
        if (n.startsWith('tl-pack-')){
          const hit = await caches.open(n).then(c=>c.match(req));
          if (hit) return hit;
        }
      }
      // runtime/precache
      const pre = await caches.open(PRECACHE).then(c=>c.match(req));
      if (pre) return pre;
      try{
        const net = await fetch(req);
        const run = await caches.open(RUNTIME);
        await safeCachePut(run, req, net.clone());
        return net;
      }catch{
        const run = await caches.open(RUNTIME);
        const cached = await run.match(req);
        if (cached) return cached;
        return new Response(JSON.stringify({results:[{elevation:null}]}), {headers:{'Content-Type':'application/json'}});
      }
    })());
    return;
  }

  if (isEsri) {
    // Tiles: cache-first (opaque allowed)
    event.respondWith((async ()=>{
      // Check course pack caches
      const names = await caches.keys();
      for (const n of names){
        if (n.startsWith('tl-pack-')){
          const hit = await caches.open(n).then(c=>c.match(req, {ignoreVary:true}));
          if (hit) return hit;
        }
      }
      // runtime cache
      const run = await caches.open(RUNTIME);
      const cached = await run.match(req, {ignoreVary:true});
      if (cached) return cached;
      try{
        const net = await fetch(req, {mode:'no-cors'});
        await safeCachePut(run, req, net.clone ? net.clone() : net);
        return net;
      }catch{
        // no tile available offline
        return new Response(null, {status: 504});
      }
    })());
    return;
  }

  // Default: try precache → runtime → network
  event.respondWith((async ()=>{
    const pre = await caches.open(PRECACHE).then(c=>c.match(req));
    if (pre) return pre;
    const run = await caches.open(RUNTIME);
    const cached = await run.match(req);
    if (cached) return cached;
    try{
      const net = await fetch(req);
      await safeCachePut(run, req, net.clone());
      return net;
    }catch{
      // last resort: offline page for HTML, empty for others
      if (req.headers.get('accept')?.includes('text/html')) {
        const off = await caches.open(PRECACHE).then(c=>c.match('/offline.html'));
        return off || new Response('<h1>Offline</h1>', {headers:{'Content-Type':'text/html'}});
      }
      return new Response('', {status: 504});
    }
  })());
});
