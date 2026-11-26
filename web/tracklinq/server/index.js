import { verifiedStrokeOptions } from "./verified-si.js";
import fs from "fs";
import crypto from "crypto";
import multer from "multer";
// /web/tracklinq/server/index.js
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import morgan from "morgan";
import pkg from "pg";

const { Pool } = pkg;

// ----- DB pool -----
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});
const query = (text, params) => pool.query(text, params);

// ----- Express app -----
const app = express();
// Railway typically forwards traffic through one reverse proxy.
app.set('trust proxy', 1);
const defaultJsonParser=express.json();
app.use((req,res,next)=>{
  // The authenticated Mapper publishing route has its own larger bounded parser.
  if(req.method==='POST' && req.path==='/api/mapper/publish')return next();
  return defaultJsonParser(req,res,next);
});
app.use(morgan("tiny"));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "..", "public");
// ----- Runtime config for frontend -----
// Served before static files so gps.html / mapper.html can read environment variables
// without committing tokens to GitHub.
app.get("/config.js", (_req, res) => {
  const config = {
    MAPBOX_ACCESS_TOKEN: process.env.MAPBOX_ACCESS_TOKEN || ""
  };

  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(
    `window.DRIVEDEN_CONFIG = Object.assign({}, window.DRIVEDEN_CONFIG || {}, ${JSON.stringify(config)});`
  );
});

// ===== DRIVE DEN ENHANCED COURSE PUBLISHING =====
// A virtual course library overlays the existing public/courses/*.json files.
// Existing GitHub-mapped courses remain unchanged. New DB courses use dd-* ids.
// Requires MAPPER_PUBLISH_TOKEN: long, random secret stored ONLY in Railway.
const enhancedCourseTableSQL = `
CREATE TABLE IF NOT EXISTS driveden_enhanced_courses (
  course_id TEXT PRIMARY KEY,
  course_name TEXT NOT NULL,
  course_data JSONB NOT NULL,
  source_api_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);`;
let enhancedTablePromise;
function ensureEnhancedTable(){
  if (!enhancedTablePromise) enhancedTablePromise = query(enhancedCourseTableSQL)
    .catch(e => { enhancedTablePromise = null; throw e; });
  return enhancedTablePromise;
}
function validEnhancedId(v){
  const id = String(v || '').toLowerCase();
  return /^dd-[a-z0-9][a-z0-9-]{2,90}$/.test(id) ? id : null;
}
function publishedCourseId(course){
  const old=String(course?.course?.id || '');
  if (validEnhancedId(old)) return old;
  const name=String(course?.course?.name || 'course');
  const slug=name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,45) || 'course';
  const apiId=Number(course?.course?.apiSourceId || course?.course?.apiCourseId || course?.importedFromApi?.sourceId || 0);
  return `dd-${Number.isSafeInteger(apiId) && apiId > 0 ? `${apiId}-` : ''}${slug}`;
}
function enhancedAdminAuth(req,res,next){
  const secret = String(process.env.MAPPER_PUBLISH_TOKEN || '');
  if (secret.length < 24) return res.status(503).json({ok:false,error:'Set MAPPER_PUBLISH_TOKEN (24+ random characters) in Railway first.'});
  const actual = String(req.header('x-mapper-publish-token') || '');
  // Compare hashes with equal length, rather than direct secret string comparison.
  const a=crypto.createHash('sha256').update(actual).digest();
  const b=crypto.createHash('sha256').update(secret).digest();
  if (!actual || !crypto.timingSafeEqual(a,b)) return res.status(401).json({ok:false,error:'Invalid Mapper publishing token.'});
  next();
}
function validPoint(p){
  return p && typeof p === 'object' && Number.isFinite(p.lat) && Number.isFinite(p.lng)
    && p.lat >= -90 && p.lat <= 90 && p.lng >= -180 && p.lng <= 180;
}
function validateEnhancedCourse(d){
  if (!d || typeof d !== 'object' || !d.course || typeof d.course.name !== 'string' || !d.course.name.trim())
    return 'Course name missing.';
  const keys=Object.keys(d.holes || {}).filter(k => /^\d+$/.test(k));
  const maxHole=Math.max(0,...keys.map(Number));
  if (maxHole < 9 || maxHole > 36 || keys.length !== maxHole || ![9,18,27,36].includes(maxHole))
    return 'A complete 9, 18, 27 or 36-hole course is required.';
  for(let i=1;i<=maxHole;i++){
    const h=d.holes[String(i)];
    if (!h || typeof h !== 'object') return `Hole ${i} missing.`;
    for(const k of ['TEE','FRONT','MID','BACK']) if (!validPoint(h.pins?.[k]))
      return `Hole ${i}: ${k} coordinate is missing or invalid.`;
    if (!Number.isInteger(h.par) || h.par < 3 || h.par > 6)
      return `Hole ${i}: verify par before publishing.`;
    if (!Number.isInteger(h.stroke) || h.stroke < 1 || h.stroke > maxHole)
      return `Hole ${i}: verify stroke index before publishing.`;
    if (!Array.isArray(h.outline) || h.outline.length < 6 || h.outline.length > 150 || !h.outline.every(validPoint))
      return `Hole ${i}: a hole outline with at least 6 valid points is required.`;
  }
  if (!d.verification?.coordinatesChecked || !d.verification?.scorecardChecked)
    return 'Confirm that you checked the mapped coordinates and scorecard.';
  if (!String(d.verification?.scorecardSource || '').trim())
    return 'Enter the scorecard verification source.';
  return null;
}

// Do not intercept existing static course IDs: only published dd-* IDs.
app.get('/courses/:id.json', async (req,res,next)=>{
  const id=validEnhancedId(req.params.id);
  if (!id) return next();
  try{
    await ensureEnhancedTable();
    const found=await query('SELECT course_data FROM driveden_enhanced_courses WHERE course_id=$1',[id]);
    if (!found.rows.length) return next();
    res.setHeader('Cache-Control','no-cache, must-revalidate');
    res.json(found.rows[0].course_data);
  }catch(e){ console.error('Enhanced course fetch failed',e); res.status(503).json({ok:false,error:'Course library unavailable'}); }
});

// Merge DB-published courses with the existing static course index. Existing
// club PINs and legacy fields are left exactly as they are on disk.
app.get('/courses/index.json', async (_req,res)=>{
  try{
    const raw=JSON.parse(fs.readFileSync(path.join(publicDir,'courses','index.json'),'utf8'));
    const existing=Array.isArray(raw.courses) ? raw.courses : [];
    // On SW installation the old service worker prefetches EVERY index item.
    // Return the static list for that installer-only request so it does not
    // silently download hundreds of published courses on every device.
    if (Object.prototype.hasOwnProperty.call(_req.query, 'swts')) {
      res.setHeader('Cache-Control','no-cache, must-revalidate');
      return res.json(raw);
    }
    let published=[];
    try{
      await ensureEnhancedTable();
      const result=await query('SELECT course_id,course_name FROM driveden_enhanced_courses ORDER BY course_name');
      published=result.rows.map(r=>({id:r.course_id,name:r.course_name,active:true,pin:''}));
    }catch(e){ console.error('Enhanced list unavailable, serving static index',e.message); }
    const found=new Set(existing.map(c=>String(c.id).toLowerCase()));
    raw.courses=[...existing,...published.filter(c=>!found.has(c.id))];
    res.setHeader('Cache-Control','no-cache, must-revalidate');
    res.json(raw);
  }catch(e){ console.error('Course index merge failed',e); res.status(500).json({ok:false,error:'Course list unavailable'}); }
});

// Public read-only list for Mapper's 'Load Published' selector.
app.get('/api/enhanced-courses', async (_req,res)=>{
  try{
    await ensureEnhancedTable();
    const {rows}=await query('SELECT course_id AS id,course_name AS name,updated_at FROM driveden_enhanced_courses ORDER BY course_name');
    res.setHeader('Cache-Control','no-store');
    res.json({ok:true,courses:rows});
  }catch(e){res.status(503).json({ok:false,error:'Course library unavailable'});}
});

app.post('/api/mapper/publish',enhancedAdminAuth,express.json({limit:'8mb'}),(err,req,res,next)=>{
  if(err?.type==='entity.too.large')return res.status(413).json({ok:false,error:'Course file exceeds the 8 MB publishing limit. Simplify hazard geometry or remove unnecessary hazards and retry.'});
  return next(err);
},async(req,res)=>{
  try{
    const data=req.body?.course;
    const err=validateEnhancedCourse(data);
    if(err) return res.status(400).json({ok:false,error:err});
    await ensureEnhancedTable();
    // Keep provider imports traceable; independently review coordinates and
    // confirm provider retention/reuse rights before relying on source data.
    const id=publishedCourseId(data);
    const newData=structuredClone(data);
    newData.course.id=id;
    newData.course.pin=''; // published library is Guest access, not a fleet PIN
    newData.course.name=String(newData.course.name).slice(0,160).trim();
    newData.publishedAt=new Date().toISOString();
    newData.publishedBy='driveden-mapper';
    const sourceId=Number(data.course.apiSourceId || data.course.apiCourseId || data.importedFromApi?.sourceId || 0);
    const apiId=Number.isSafeInteger(sourceId) && sourceId>0 ? sourceId : null;
    await query(`INSERT INTO driveden_enhanced_courses (course_id,course_name,course_data,source_api_id)
      VALUES ($1,$2,$3::jsonb,$4)
      ON CONFLICT (course_id) DO UPDATE SET
        course_name=EXCLUDED.course_name,course_data=EXCLUDED.course_data,
        source_api_id=EXCLUDED.source_api_id,updated_at=NOW()`,
      [id,newData.course.name,JSON.stringify(newData),apiId]);
    res.setHeader('Cache-Control','no-store');
    res.json({ok:true,id,name:newData.course.name,holes:Object.keys(newData.holes).length});
  }catch(e){console.error('Mapper publish failure',e);res.status(500).json({ok:false,error:'Could not publish course.'});}
});
// ===== END ENHANCED COURSE PUBLISHING =====

// ===== MAP SUGGESTIONS FROM OPENSTREETMAP (geometry, not satellite AI) =====
// OSM golf=hole ways typically run tee-to-green, with ref=hole number.
// The Mapper reviews everything before any Enhanced course can be published.
// Source map data: © OpenStreetMap contributors, ODbL; preserve attribution
// and comply with ODbL if redistributing derivative datasets.
// Keep successful OSM lookups for reuse. Overpass is a shared public resource:
// do not make every Mapper open issue the same expensive external request.
// Prefer a local, provenance-labelled South Africa golf index over public Overpass.
// This is generated from a Geofabrik OSM extract, not the editing API or tiles.
const osmGolfIndexDir = path.join(__dirname, '..', 'data', 'osm-golf-tiles');
const osmIndexTileCache = new Map();
function readIndexedOSMGolfFeatures(lat,lng,radiusM) {
  if (!fs.existsSync(path.join(osmGolfIndexDir,'manifest.json'))) return null;
  const features=[],hazards=[],seen=new Set();
  const latSpan=(radiusM+750)/111132;
  const lngSpan=(radiusM+750)/(111320*Math.max(.2,Math.cos(lat*Math.PI/180)));
  for(let y=Math.floor(lat)-1;y<=Math.floor(lat)+1;y++) {
    for(let x=Math.floor(lng)-1;x<=Math.floor(lng)+1;x++) {
      const tileId=y+'_'+x;
      let tile=osmIndexTileCache.get(tileId);
      if (!tile) {
        try {
          const filename=path.join(osmGolfIndexDir,tileId+'.json');
          tile=fs.existsSync(filename)?JSON.parse(fs.readFileSync(filename,'utf8')):[];
          if(!Array.isArray(tile)) tile=[];
          if(osmIndexTileCache.size>40)osmIndexTileCache.clear();
          osmIndexTileCache.set(tileId,tile);
        } catch(error) {
          console.warn('OSM indexed tile read failed:',tileId,error?.message);
          tile=[];
        }
      }
      for(const f of tile) {
        if(!f || !['hole','tee','green','bunker','water','water_line'].includes(f?.tags?.golf))continue;
        const pts=f.geometry;
        if(!Array.isArray(pts)||!pts.length)continue;
        if(!pts.some(p=>Math.abs(Number(p.lat)-lat)<=latSpan && Math.abs(Number(p.lon)-lng)<=lngSpan))continue;
        const id=String(f.type)+':'+String(f.id);
        if(seen.has(id))continue;
        seen.add(id);
        if(['hole','tee','green'].includes(f.tags.golf))features.push(f);
        else hazards.push(f);
      }
    }
  }
  return [...features,...hazards.slice(0,Math.max(0,3000-features.length))];
}

const osmMapCache = new Map();
const osmMapRate = new Map();
let osmPendingRequests = 0;
let osmCacheTableReady = null;
const OSM_FRESH_FOR_MS = 24 * 60 * 60 * 1000;
const OSM_STALE_FOR_MS = 14 * 24 * 60 * 60 * 1000;

async function ensureOSMCacheTable() {
  if (!osmCacheTableReady) {
    osmCacheTableReady = query(`CREATE TABLE IF NOT EXISTS driveden_osm_map_cache (
      cache_key TEXT PRIMARY KEY,
      features JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`).catch(err => { osmCacheTableReady = null; throw err; });
  }
  return osmCacheTableReady;
}

// Area-specific, indexed bbox queries are generally cheaper than combining
// node/way/relation around-radius searches. A golf=hole way has the tee-to-green
// route we need; tee/green geometries are usually ways as well.
function osmGolfBBoxQuery(lat, lng, radiusM) {
  const latDelta = radiusM / 111132;
  const lngDelta = radiusM / (111320 * Math.max(.2, Math.cos(lat*Math.PI/180)));
  const bbox = [lat-latDelta,lng-lngDelta,lat+latDelta,lng+lngDelta]
    .map(v=>v.toFixed(6)).join(',');
  return `[out:json][timeout:17];(way["golf"="hole"](${bbox});way["golf"="green"](${bbox});way["golf"="tee"](${bbox});node["golf"="tee"](${bbox}););out geom;`;
}

function trimOSMGolfElements(elements) {
  return elements
    .filter(el=>['hole','tee','green'].includes(el?.tags?.golf)
      && (el.type==='node' || (Array.isArray(el.geometry) && el.geometry.length<2000)))
    .slice(0,1100)
    .map(el=>({type:el.type,id:el.id,
      tags:{golf:el.tags.golf,ref:el.tags.ref||'',name:el.tags.name||''},
      geometry:el.type==='node'?[{lat:el.lat,lon:el.lon}]
        :(el.geometry || []).map(v=>({lat:v.lat,lon:v.lon}))}));
}

const osmHosts = [
  {label:'private.coffee',url:'https://overpass.private.coffee/api/interpreter'},
  {label:'VK Maps',url:'https://maps.mail.ru/osm/tools/overpass/api/interpreter'},
  {label:'overpass-api.de',url:'https://overpass-api.de/api/interpreter'}
];

app.post('/api/mapper/osm-features', enhancedAdminAuth, async (req,res)=>{
  const lat = Number(req.body?.lat), lng = Number(req.body?.lng);
  const radius = Number(req.body?.radius);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(radius)
      || lat < -35.5 || lat > -21 || lng < 16 || lng > 34
      || radius < 300 || radius > 4200) {
    return res.status(400).json({ok:false,error:'Select a South African course with valid green coordinates.'});
  }
  const client = String(req.ip || 'unknown');
  const now = Date.now();
  const usage = osmMapRate.get(client);
  if (usage && now - usage.start < 60_000 && usage.count >= 5)
    return res.status(429).json({ok:false,error:'Please wait a minute before requesting more OSM maps.'});
  osmMapRate.set(client, usage && now-usage.start<60_000 ? {start:usage.start,count:usage.count+1} : {start:now,count:1});

  const key = `${lat.toFixed(3)}:${lng.toFixed(3)}:${Math.round(radius/100)}`;
  // Prefer the indexed geometry, but an empty route result must not suppress fallback.
  const indexedFeatures=readIndexedOSMGolfFeatures(lat,lng,radius);
  const hasRoutes=features=>Array.isArray(features)&&features.some(f=>f.tags?.golf==='hole');
  const mergeFeatures=features=>{
    const merged=new Map();
    for(const f of [...(indexedFeatures||[]),...(features||[])]){
      const kind=f.tags?.golf;
      // The index and Overpass can use different identifier formats.
      const id=String(f.id).replace(/^(?:way|node|relation)[\/:]?/,'').replace(/^[wnr](?=\d)/,'');
      const key=kind+':'+id;
      merged.set(key,f);
    }
    return [...merged.values()].sort((a,b)=>Number(!['hole','tee','green'].includes(a.tags?.golf))-Number(!['hole','tee','green'].includes(b.tags?.golf)));
  };
  if(hasRoutes(indexedFeatures)) {
    res.setHeader('Cache-Control','no-store');
    return res.json({ok:true,features:indexedFeatures,source:'Geofabrik OSM country extract',
      cached:true,indexed:true,attribution:'© OpenStreetMap contributors (ODbL)'});
  }
  console.info('OSM index route fallback:',lat.toFixed(4),lng.toFixed(4),'radius',Math.round(radius),'indexed features',indexedFeatures?.length||0);
  let cached = osmMapCache.get(key);
  if (!cached) {
    // A previous successful lookup should survive app restarts/deploys.
    try {
      await ensureOSMCacheTable();
      const row = await query('SELECT features, updated_at FROM driveden_osm_map_cache WHERE cache_key=$1',[key]);
      if (row.rows.length && Array.isArray(row.rows[0].features)) {
        cached = {features:row.rows[0].features, fetchedAt:new Date(row.rows[0].updated_at).getTime()};
        if (now - cached.fetchedAt <= OSM_STALE_FOR_MS) osmMapCache.set(key,cached);
        else cached = null;
      }
    } catch (err) {
      console.warn('OSM cache read unavailable:',err?.message);
    }
  }
  if (cached && hasRoutes(cached.features) && now - cached.fetchedAt < OSM_FRESH_FOR_MS) {
    res.setHeader('Cache-Control','no-store');
    return res.json({ok:true,features:mergeFeatures(cached.features),source:'OpenStreetMap',cached:true,
      attribution:'© OpenStreetMap contributors (ODbL)'});
  }
  if (osmPendingRequests >= 2) {
    if (cached && hasRoutes(cached.features)) return res.json({ok:true,features:mergeFeatures(cached.features),source:'OpenStreetMap',cached:true,stale:true,
      attribution:'© OpenStreetMap contributors (ODbL)'});
    return res.status(503).json({ok:false,error:'Another map lookup is running. Please retry shortly.'});
  }

  const queryText = osmGolfBBoxQuery(lat,lng,Math.round(radius));
  osmPendingRequests++;
  try {
    let lastFailure='Public map servers are currently busy.';
    // One attempt per separate provider; do not hammer a busy service.
    for(const provider of osmHosts) {
      const start = Date.now();
      try {
        const response = await fetch(provider.url,{
          method:'POST',
          headers:{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8',
            'Accept':'application/json',
            'User-Agent':'DriveDenGPS/1.1 (+https://driveden-gps.up.railway.app)'},
          body:new URLSearchParams({data:queryText}),
          signal:AbortSignal.timeout(17000)
        });
        if(!response.ok) {
          console.warn(`OSM lookup ${provider.label}: HTTP ${response.status} after ${Date.now()-start}ms`);
          lastFailure='Public map servers are busy (HTTP '+response.status+').';
          continue;
        }
        const raw = await response.text();
        if(raw.length > 4500000) {lastFailure='Map geometry response was too large.';continue;}
        const j = JSON.parse(raw);
        if (!Array.isArray(j.elements) || (j.remark && /error|timeout|runtime/i.test(j.remark))) {
          lastFailure='The map provider returned an incomplete response.';
          continue;
        }
        const features=trimOSMGolfElements(j.elements);
        console.info(`OSM lookup ${provider.label} succeeded: ${features.length} golf features in ${Date.now()-start}ms`);
        if(osmMapCache.size>60)osmMapCache.clear();
        const fetchedAt=Date.now();
        osmMapCache.set(key,{features,fetchedAt});
        try {
          await ensureOSMCacheTable();
          await query(`INSERT INTO driveden_osm_map_cache(cache_key,features,updated_at)
            VALUES($1,$2,NOW()) ON CONFLICT(cache_key) DO UPDATE SET
            features=EXCLUDED.features, updated_at=NOW()`,[key,JSON.stringify(features)]);
        } catch(err) { console.warn('OSM cache write unavailable:',err?.message); }
        res.setHeader('Cache-Control','no-store');
        return res.json({ok:true,features:mergeFeatures(features),source:'OpenStreetMap',cached:false,
          attribution:'© OpenStreetMap contributors (ODbL)'});
      }catch(err) {
        console.warn(`OSM lookup ${provider.label} failed after ${Date.now()-start}ms: ${err?.name||'Error'}`);
        lastFailure=err?.name==='TimeoutError'||err?.name==='AbortError'
          ? 'Public map servers are taking too long.' : 'Could not reach the public map servers.';
      }
    }
    if(cached && hasRoutes(cached.features) && now-cached.fetchedAt < OSM_STALE_FOR_MS) {
      res.setHeader('Cache-Control','no-store');
      console.warn('OSM providers busy; using last successful cached geometry.');
      return res.json({ok:true,features:mergeFeatures(cached.features),source:'OpenStreetMap',cached:true,stale:true,
        attribution:'© OpenStreetMap contributors (ODbL)'});
    }
    if(indexedFeatures!==null) return res.json({ok:true,features:indexedFeatures,source:'Geofabrik OSM country extract',indexed:true,fallbackUnavailable:true,attribution:'© OpenStreetMap contributors (ODbL)'});
    return res.status(503).json({ok:false,error:`Could not load OpenStreetMap mapping: ${lastFailure} You can retry shortly; your course data is safe.`});
  } finally { osmPendingRequests--; }
});
// ===== END OPENSTREETMAP MAP SUGGESTIONS =====


app.use(express.static(publicDir));

// ----- Golf Courses API (South Africa) -----
// Shared Pro subscription. Keep the key on Railway, NEVER in public JavaScript.
// These are POST endpoints deliberately: the existing GPS service worker only
// intercepts GET, so live provider searches are not mistakenly stored offline.
const GOLF_COURSES_API_BASE = 'https://golfcoursesapi.com/api/v1';
const golfCourseApiCache = new Map();
const golfCourseClientRates = new Map();

function golfApiKey(){
  return process.env.GOLF_COURSES_API_KEY || process.env.GOLFCOURSESAPI_KEY || '';
}

function golfNumber(value, min, max){
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

function golfCoords(lat, lng){
  const y = golfNumber(lat, -90, 90);
  const x = golfNumber(lng, -180, 180);
  return y === null || x === null ? null : { lat:y, lng:x };
}

function golfApiThrottle(req, res, next){
  const ip = String(req.ip || req.socket?.remoteAddress || 'unknown');
  const now = Date.now();
  const rec = golfCourseClientRates.get(ip);
  if (!rec || now - rec.start > 60000){
    golfCourseClientRates.set(ip, { start:now, count:1 });
  } else {
    rec.count++;
    if (rec.count > 40) return res.status(429).json({ ok:false, error:'Too many searches; retry shortly.' });
  }
  // Avoid unbounded memory in the long-running Railway server.
  if (golfCourseClientRates.size > 2000){
    for (const [k,v] of golfCourseClientRates){
      if(now - v.start > 120000) golfCourseClientRates.delete(k);
    }
  }
  next();
}

async function golfApiGet(endpoint, ttlMs=10*60*1000){
  const key = golfApiKey();
  if (!key){
    const err = new Error('Golf Courses API key not configured in Railway (GOLF_COURSES_API_KEY).');
    err.status = 503;
    throw err;
  }
  const now = Date.now();
  const cached = golfCourseApiCache.get(endpoint);
  if (cached && cached.expires > now) return cached.value;

  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), 12000);
  let response;
  try{
    response = await fetch(`${GOLF_COURSES_API_BASE}${endpoint}`, {
      headers:{ Authorization:`Bearer ${key}`, Accept:'application/json' },
      signal:controller.signal
    });
  }catch(e){
    const err = new Error(e.name === 'AbortError' ? 'Course provider timed out.' : 'Could not reach the course provider.');
    err.status = 502;
    throw err;
  }finally{ clearTimeout(timer); }

  if(!response.ok){
    const err = new Error(response.status === 401 ? 'Golf Courses API key rejected. Check your Railway key.'
      : response.status === 403 ? 'Green-centre access is not enabled for this API key.'
      : response.status === 404 ? 'Course data not found.'
      : response.status === 429 ? 'Course provider rate limit reached. Try again shortly.'
      : 'Course provider temporarily unavailable.');
    err.status = response.status === 401 ? 503 : response.status === 429 ? 429 : response.status === 404 ? 404 : 502;
    err.upstreamStatus = response.status;
    throw err;
  }
  let value;
  try{ value = await response.json(); }
  catch(_){ const err=new Error('Course provider returned invalid data.'); err.status=502; throw err; }
  golfCourseApiCache.set(endpoint, { value, expires:now + ttlMs });
  if(golfCourseApiCache.size > 350){
    for(const [k,v] of golfCourseApiCache){
      if(v.expires < now) golfCourseApiCache.delete(k);
    }
    while(golfCourseApiCache.size > 350) golfCourseApiCache.delete(golfCourseApiCache.keys().next().value);
  }
  return value;
}

function normalizeGolfApiCourse(detailPayload, greensPayload){
  const c = detailPayload?.data || {};
  const tees = Array.isArray(c.scorecard?.teeboxes) ? c.scorecard.teeboxes : [];
  // Choose a representative mid-length tee for a scorecard default; never
  // invent a physical tee GPS point (the API does not provide tee coordinates).
  const validTees = tees.filter(t=>Array.isArray(t.holes) && t.holes.length);
  const byLength = [...validTees].sort((a,b)=>Number(a.total_yards || 0)-Number(b.total_yards || 0));
  const tee = byLength[Math.floor((byLength.length-1)/2)] || validTees[0] || null;
  const cardHoles = Array.isArray(tee?.holes) ? tee.holes : [];
  const greenData = greensPayload?.data || {};
  const greens = Array.isArray(greenData.holes) ? greenData.holes : [];
  const greenMap = new Map(greens.map(g=>[Number(g.hole), golfCoords(g.lat,g.lng)]).filter(x=>x[1]));
  const n = Math.min(36, Math.max(1,
    Number(c.scorecard?.hole_count) || Number(greenData.hole_count) || cardHoles.length || 18));
  // Some provider tee sets have missing handicap/SI values while another
  // tee set has a complete, consistent 1..N SI sequence. Keep the chosen
  // default tee for par/distance; use a complete single source for SI only.
  // Never invent indexes or combine conflicting partial tee sequences.
  const hasCompleteStrokeIndexes=t=>{
    if(!Array.isArray(t?.holes))return false;
    const si=Array.from({length:n},(_,k)=>{
      const hole=t.holes.find(h=>Number(h.hole)===k+1);
      const v=Number(hole?.handicap);
      return Number.isInteger(v)&&v>=1&&v<=n?v:null;
    });
    return si.every(Number.isInteger)&&new Set(si).size===n;
  };
  const strokeTee=hasCompleteStrokeIndexes(tee)?tee:
    (validTees.find(hasCompleteStrokeIndexes)||tee);
  const strokeCardHoles=Array.isArray(strokeTee?.holes)?strokeTee.holes:[];
  const holes = {};
  for(let i=1;i<=n;i++){
    const card = cardHoles.find(h=>Number(h.hole) === i) || {};
    const mid = greenMap.get(i);
    const par = golfNumber(card.par, 3, 6);
    const strokeCard = strokeCardHoles.find(h=>Number(h.hole)===i)||{};
    const stroke = golfNumber(strokeCard.handicap, 1, 36);
    holes[String(i)] = {
      par:par === null ? null : Math.round(par),
      stroke:stroke === null ? null : Math.round(stroke),
      pins:mid ? { MID:mid } : {},
      apiYards:golfNumber(card.yards, 1, 900),
      apiMeters:golfNumber(card.meters, 1, 900)
    };
  }
  const location = c.coordinates || {};
  const position = golfCoords(location.latitude ?? c.latitude, location.longitude ?? c.longitude);
  const id = Number(c.id);
  return {
    course:{
      id:`api-${id}`,
      name:String(c.name || c.club || `Golf Course ${id}`),
      pin:'',
      location:position,
      apiProvider:'golfcoursesapi',
      apiCourseId:id
    },
    holes,
    apiMode:true,
    apiData:{
      provider:'Golf Courses API',
      sourceId:id,
      teeName:tee?.name || null,
      strokeTeeName:strokeTee?.name || null,
      strokeIndexesComplete:hasCompleteStrokeIndexes(strokeTee),
      teeOptions:validTees.map(t=>({ name:String(t.name || 'Tees'), total_yards:t.total_yards || null })),
      holeCount:n,
      holesMapped:greenMap.size,
      greenCentersAvailable:greenMap.size > 0,
      greenCentersRestricted:greensPayload === null
    }
  };
}

function golfApiError(res,e){
  return res.status(e.status || 502).json({ok:false,error:e.message || 'Course provider unavailable.'});
}

app.post('/api/course-library/search', golfApiThrottle, async (req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const q=String(req.body?.q || '').trim().slice(0,90);
  if(q.length < 2) return res.status(400).json({ok:false,error:'Enter at least 2 characters.'});
  const page=Math.min(15, Math.max(1, Number.parseInt(req.body?.page,10) || 1));
  const params=new URLSearchParams({ q, country:'ZA', page:String(page), per_page:'25' });
  try{
    const data=await golfApiGet(`/courses?${params}`, 4*60*1000);
    res.json({ok:true, courses:Array.isArray(data?.data) ? data.data.map(c=>({
      id:c.id, name:c.name, club:c.club, city:c.city, state:c.state, country:c.country,
      latitude:c.latitude, longitude:c.longitude
    })) : [], meta:data?.meta || {}});
  }catch(e){ golfApiError(res,e); }
});

app.post('/api/course-library/course', golfApiThrottle, async (req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const id=Number(req.body?.id);
  if(!Number.isSafeInteger(id) || id <= 0 || id > 1000000000)
    return res.status(400).json({ok:false,error:'Invalid course ID.'});
  try{
    const detail=await golfApiGet(`/courses/${id}`, 20*60*1000);
    let greens=null;
    try{ greens=await golfApiGet(`/courses/${id}/green-centers`, 20*60*1000); }
    catch(e){
      // 404: unmapped course. 403: plan permission. Other failures remain visible
      // as scorecard-only data, but never fabricate GPS coordinates.
      console.warn('Golf course green centers unavailable:', id, e.upstreamStatus || e.status);
    }
    const course=normalizeGolfApiCourse(detail, greens);
    // Only Mapper imports opt in. GPS API-only behavior is unchanged.
    if(req.body?.verifiedSI===true){
      const raw=detail?.data||{};
      const club=typeof raw.club==='string'?raw.club:raw.club?.name||'';
      const pars=Array.from({length:18},(_,i)=>course.holes[String(i+1)]?.par);
      const options=Object.keys(course.holes).length===18
        ? verifiedStrokeOptions(course.course.name,club,pars,course.apiData.teeName):[];
      if(options.length===1){
        options[0].numbers.forEach((si,i)=>{course.holes[String(i+1)].stroke=si;});
      }
      course.mapperVerifiedSI={options,applied:options.length===1,verifiedOn:'2026-10-15'};
    }
    res.json({ok:true,course});
  }catch(e){ golfApiError(res,e); }
});
// ----- End Golf Courses API -----

// ----- Health -----
app.get("/health", (_req, res) => res.json({ ok: true }));

// ----- DB test -----
app.get("/dbtest", async (_req, res) => {
  try {
    const now = await query("select now()");
    const hasClubs = await query(
      "select count(*)::int as n from information_schema.tables where table_name = 'clubs'"
    );
    res.json({ ok: true, now: now.rows[0].now, hasClubsTable: hasClubs.rows[0].n > 0 });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ========== PUBLIC API ==========

// List active clubs (for guest mode chooser)
app.get("/api/clubs", async (_req, res) => {
  try {
    const { rows } = await query(
      "SELECT id, name, short_code FROM clubs WHERE is_active = TRUE ORDER BY name ASC"
    );
    res.json({ ok: true, clubs: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Resolve a club by 10-digit PIN (for clubs)
app.get("/api/pin/resolve", async (req, res) => {
  const pin = String(req.query.pin || "").trim();
  if (!pin) return res.status(400).json({ ok: false, error: "pin required" });
  try {
    const { rows } = await query(
      "SELECT id, name, short_code FROM clubs WHERE pin_code = $1 AND is_active = TRUE LIMIT 1",
      [pin]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: "not_found" });
    res.json({ ok: true, club: rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Resolve a tablet/device code (for carts/tablets)
app.get("/api/device/resolve", async (req, res) => {
  const code = String(req.query.code || "").trim();
  if (!code) return res.status(400).json({ ok: false, error: "code required" });
  try {
    const { rows } = await query(
      `SELECT d.id as device_id, d.is_active, d.device_code,
              c.id as club_id, c.name as club_name, c.short_code
         FROM devices d
         JOIN clubs c ON c.id = d.club_id
        WHERE d.device_code = $1
        LIMIT 1`,
      [code]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: "not_found" });
    if (!rows[0].is_active)
      return res.status(403).json({ ok: false, error: "device_inactive" });
    res.json({ ok: true, device: rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ========== ONE-TIME ADMIN MIGRATION/SEED (allows GET or POST) ==========

function checkToken(req) {
  const token = process.env.MIGRATION_TOKEN || "";
  if (!token) return false;
  const provided = req.query.token || req.header("x-migration-token");
  return provided && provided === token;
}

const schemaSQL = `
CREATE TABLE IF NOT EXISTS clubs (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  short_code TEXT NOT NULL UNIQUE,
  is_active BOOLEAN DEFAULT TRUE,
  pin_code VARCHAR(10) UNIQUE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS devices (
  id SERIAL PRIMARY KEY,
  club_id INTEGER REFERENCES clubs(id) ON DELETE CASCADE,
  device_code VARCHAR(20) UNIQUE NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rounds (
  id SERIAL PRIMARY KEY,
  club_id INTEGER REFERENCES clubs(id),
  course_name TEXT,
  player_name TEXT,
  total_score INTEGER,
  played_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS gps_devices (
  device_id TEXT PRIMARY KEY,
  device_name TEXT,
  client_name TEXT,
  install_date DATE,
  warranty_months INTEGER DEFAULT 36,
  cart_model TEXT,
  cart_serial TEXT,
  gps_serial TEXT,
  contact_name TEXT,
  contact_phone TEXT,
  contact_email TEXT,
  notes TEXT,
  assigned_short_code TEXT,
  assigned_course_name TEXT,
  last_course_id TEXT,
  last_course_name TEXT,
  last_short_code TEXT,
  last_login_mode TEXT,
  last_hole INTEGER,
  last_lat DOUBLE PRECISION,
  last_lng DOUBLE PRECISION,
  last_accuracy DOUBLE PRECISION,
  last_altitude DOUBLE PRECISION,
  last_view_mode TEXT,
  last_unit TEXT,
  app_version TEXT,
  user_agent TEXT,
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
`;

const seedSQL = `
INSERT INTO clubs (name, short_code, pin_code)
VALUES ('Silverlakes Golf Club', 'SLK', 'SLK1234567')
ON CONFLICT (short_code) DO NOTHING;

INSERT INTO devices (club_id, device_code)
SELECT id, 'SLK-7F4K-J2' FROM clubs WHERE short_code='SLK'
ON CONFLICT (device_code) DO NOTHING;
`;

app.all("/admin/migrate", async (req, res) => {
  if (!checkToken(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  try {
    await query(schemaSQL);
    res.json({ ok: true, ran: "schema" });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.all("/admin/seed", async (req, res) => {
  if (!checkToken(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  try {
    await query(seedSQL);
    res.json({ ok: true, ran: "seed" });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});


// ========== ADS SYSTEM (Club-managed overlays) ==========
// IMPORTANT: Club PINs are currently managed in public/courses/index.json (NOT the DB).
// - ad-manager.html uploads ads for a club (identified by short_code) after PIN validation.
// - tablets fetch ads list publicly via: GET /ads/<short_code>/ads.json
//
// PIN-protected endpoints (portal):
//   GET    /api/ads/list?course=<short_code>&pin=<PIN>
//   POST   /api/ads/upload?course=<short_code>&pin=<PIN>   (multipart field name: files)
//   DELETE /api/ads/delete?course=<short_code>&pin=<PIN>&name=<filename>

const adsDir = process.env.ADS_DIR || path.join(publicDir, "ads");
if (!fs.existsSync(adsDir)) fs.mkdirSync(adsDir, { recursive: true });

const adsUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB each
});

function safeId(id) {
  return String(id || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

function ensureClubDir(shortCode) {
  const dir = path.join(adsDir, shortCode);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function listAds(shortCode) {
  const dir = ensureClubDir(shortCode);
  return fs
    .readdirSync(dir)
    .filter((f) => /\.(png|jpg|jpeg|webp|gif)$/i.test(f))
    .sort((a, b) => a.localeCompare(b));
}

// Read course index JSON (source of truth for PINs + active flag)
function readCoursesIndex() {
  const p = path.join(publicDir, "courses", "index.json");
  const raw = fs.readFileSync(p, "utf8");
  const j = JSON.parse(raw);
  const courses = Array.isArray(j.courses) ? j.courses : [];
  return courses;
}

function normalizePin(pin) {
  return String(pin || "").trim().toUpperCase();
}

function resolveCourseByPin(pin) {
  const want = normalizePin(pin);
  if (!want) return null;

  const courses = readCoursesIndex();

  // Match on exact PIN (case-insensitive) and must be active === true
  // Accept both fields: pin or PIN (just in case)
  const hit = courses.find((c) => {
    const active = c.active === true || c.ACTIVE === true;
    const storedPin = normalizePin(c.pin ?? c.PIN);
    return active && storedPin && storedPin === want;
  });

  if (!hit) return null;

  const shortCode = safeId(
    hit.shortCode ?? hit.shortcode ?? hit.SHORTCODE ?? hit.short_code ?? hit.courseShortCode
  );
  const name = String(hit.name ?? hit.NAME ?? "").trim();

  if (!shortCode) return null;

  return { shortCode, name };
}

function requireClubPin(req, res, next) {
  const course = safeId(req.query.course); // expected to match short_code
  const pin = normalizePin(req.query.pin);

  if (!course) return res.status(400).send("Missing course");
  if (!pin) return res.status(400).send("Missing pin");

  try {
    const club = resolveCourseByPin(pin);
    if (!club) return res.status(401).send("Invalid PIN");

    if (club.shortCode !== course) return res.status(401).send("Invalid PIN");

    req.shortCode = club.shortCode;
    req.clubName = club.name;
    next();
  } catch (e) {
    // If index.json missing/corrupt, surface error clearly (helps debugging)
    return res.status(500).send("Ads auth error");
  }
}


// ========== DEVICE DASHBOARD + LIVE FLEET VIEW ==========
// Devices create themselves automatically by posting a heartbeat from gps.html.
// Dashboard read/edit endpoints are protected with either:
// - DriveDen admin PIN (default 02004 or DASHBOARD_ADMIN_PIN env var)
// - A course/club PIN from public/courses/index.json, scoped to that club/fleet

const DASHBOARD_ADMIN_PIN = normalizePin(process.env.DASHBOARD_ADMIN_PIN || "02004");
let gpsDevicesSchemaPromise = null;

const gpsDevicesSchemaSQL = `
CREATE TABLE IF NOT EXISTS gps_devices (
  device_id TEXT PRIMARY KEY,
  device_name TEXT,
  client_name TEXT,
  install_date DATE,
  warranty_months INTEGER DEFAULT 36,
  cart_model TEXT,
  cart_serial TEXT,
  gps_serial TEXT,
  contact_name TEXT,
  contact_phone TEXT,
  contact_email TEXT,
  notes TEXT,
  assigned_short_code TEXT,
  assigned_course_name TEXT,
  last_course_id TEXT,
  last_course_name TEXT,
  last_short_code TEXT,
  last_login_mode TEXT,
  last_hole INTEGER,
  last_lat DOUBLE PRECISION,
  last_lng DOUBLE PRECISION,
  last_accuracy DOUBLE PRECISION,
  last_altitude DOUBLE PRECISION,
  last_view_mode TEXT,
  last_unit TEXT,
  app_version TEXT,
  user_agent TEXT,
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gps_devices_last_seen ON gps_devices (last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_gps_devices_assigned_short_code ON gps_devices (assigned_short_code);
CREATE INDEX IF NOT EXISTS idx_gps_devices_last_short_code ON gps_devices (last_short_code);
`;

function ensureGpsDevicesSchema() {
  if (!gpsDevicesSchemaPromise) {
    gpsDevicesSchemaPromise = query(gpsDevicesSchemaSQL).catch((e) => {
      gpsDevicesSchemaPromise = null;
      throw e;
    });
  }
  return gpsDevicesSchemaPromise;
}

function cleanText(v, max = 255) {
  const s = String(v ?? "").replace(/\u0000/g, "").trim();
  return s ? s.slice(0, max) : null;
}

function cleanDeviceId(v) {
  const s = String(v ?? "").trim().replace(/[^a-zA-Z0-9_.:-]/g, "").slice(0, 90);
  return s || null;
}

function cleanInt(v, min = 0, max = 999999) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, n));
}

function cleanFloat(v, min = -Infinity, max = Infinity) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

function cleanDate(v) {
  const s = cleanText(v, 20);
  if (!s) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function getDashboardScope(pin) {
  const p = normalizePin(pin);
  if (!p) return null;
  if (DASHBOARD_ADMIN_PIN && p === DASHBOARD_ADMIN_PIN) {
    return { type: "admin", shortCode: null, name: "DriveDen Admin" };
  }
  const club = resolveCourseByPin(p);
  if (club) return { type: "club", shortCode: club.shortCode, name: club.name || club.shortCode };
  return null;
}

function requireDashboardAccess(req, res, next) {
  const pin = req.query.pin || req.body?.pin || req.header("x-dashboard-pin");
  try {
    const scope = getDashboardScope(pin);
    if (!scope) return res.status(401).json({ ok: false, error: "Invalid PIN" });
    req.dashboardScope = scope;
    next();
  } catch (e) {
    res.status(500).json({ ok: false, error: "Dashboard auth error" });
  }
}

function dashboardDeviceVisible(row, scope) {
  if (!row || !scope) return false;
  if (scope.type === "admin") return true;
  return (
    row.assigned_short_code === scope.shortCode ||
    (row.last_login_mode === "club" && row.last_short_code === scope.shortCode)
  );
}

const gpsDeviceSelectSQL = `
  device_id,
  COALESCE(device_name, 'Unassigned Device') AS device_name,
  client_name,
  install_date,
  warranty_months,
  CASE
    WHEN install_date IS NOT NULL AND warranty_months IS NOT NULL
      THEN (install_date + (warranty_months || ' months')::interval)::date
    ELSE NULL
  END AS warranty_until,
  cart_model,
  cart_serial,
  gps_serial,
  contact_name,
  contact_phone,
  contact_email,
  notes,
  assigned_short_code,
  assigned_course_name,
  last_course_id,
  last_course_name,
  last_short_code,
  last_login_mode,
  last_hole,
  last_lat,
  last_lng,
  last_accuracy,
  last_altitude,
  last_view_mode,
  last_unit,
  app_version,
  user_agent,
  first_seen_at,
  last_seen_at,
  updated_at,
  CASE
    WHEN last_seen_at >= NOW() - INTERVAL '2 minutes' THEN 'online'
    WHEN last_seen_at >= NOW() - INTERVAL '30 minutes' THEN 'recent'
    ELSE 'offline'
  END AS status,
  GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - last_seen_at)) / 60))::int AS last_seen_minutes
`;

function addDashboardScopeWhere(where, params, scope) {
  if (scope.type === "admin") return;
  params.push(scope.shortCode);
  const p = `$${params.length}`;
  where.push(`(assigned_short_code = ${p} OR (last_login_mode = 'club' AND last_short_code = ${p}))`);
}

app.post("/api/devices/heartbeat", async (req, res) => {
  try {
    await ensureGpsDevicesSchema();

    const b = req.body || {};
    const deviceId = cleanDeviceId(b.deviceId);
    if (!deviceId) return res.status(400).json({ ok: false, error: "deviceId required" });

    const loginMode = cleanText(b.loginMode, 20) === "club" ? "club" : "guest";
    const shortCode = safeId(b.shortCode || b.courseShortCode || b.short_code) || null;
    const courseId = cleanText(b.courseId, 120) || shortCode || null;
    const courseName = cleanText(b.courseName, 180);
    const lat = cleanFloat(b.lat, -90, 90);
    const lng = cleanFloat(b.lng, -180, 180);

    const insertAssignedShortCode = loginMode === "club" ? shortCode : null;
    const insertAssignedCourseName = loginMode === "club" ? courseName : null;

    const { rows } = await query(
      `INSERT INTO gps_devices (
          device_id, device_name,
          assigned_short_code, assigned_course_name,
          last_course_id, last_course_name, last_short_code, last_login_mode,
          last_hole, last_lat, last_lng, last_accuracy, last_altitude,
          last_view_mode, last_unit, app_version, user_agent,
          first_seen_at, last_seen_at, updated_at
        ) VALUES (
          $1, $2,
          $3, $4,
          $5, $6, $7, $8,
          $9, $10, $11, $12, $13,
          $14, $15, $16, $17,
          NOW(), NOW(), NOW()
        )
        ON CONFLICT (device_id) DO UPDATE SET
          last_course_id = EXCLUDED.last_course_id,
          last_course_name = EXCLUDED.last_course_name,
          last_short_code = EXCLUDED.last_short_code,
          last_login_mode = EXCLUDED.last_login_mode,
          last_hole = EXCLUDED.last_hole,
          last_lat = COALESCE(EXCLUDED.last_lat, gps_devices.last_lat),
          last_lng = COALESCE(EXCLUDED.last_lng, gps_devices.last_lng),
          last_accuracy = COALESCE(EXCLUDED.last_accuracy, gps_devices.last_accuracy),
          last_altitude = COALESCE(EXCLUDED.last_altitude, gps_devices.last_altitude),
          last_view_mode = EXCLUDED.last_view_mode,
          last_unit = EXCLUDED.last_unit,
          app_version = EXCLUDED.app_version,
          user_agent = EXCLUDED.user_agent,
          assigned_short_code = COALESCE(gps_devices.assigned_short_code,
            CASE WHEN EXCLUDED.last_login_mode = 'club' THEN EXCLUDED.last_short_code ELSE NULL END),
          assigned_course_name = COALESCE(gps_devices.assigned_course_name,
            CASE WHEN EXCLUDED.last_login_mode = 'club' THEN EXCLUDED.last_course_name ELSE NULL END),
          last_seen_at = NOW(),
          updated_at = NOW()
        RETURNING ${gpsDeviceSelectSQL}`,
      [
        deviceId,
        cleanText(b.deviceName, 120) || "Unassigned Device",
        insertAssignedShortCode,
        insertAssignedCourseName,
        courseId,
        courseName,
        shortCode,
        loginMode,
        cleanInt(b.hole, 1, 99),
        lat,
        lng,
        cleanFloat(b.accuracy, 0, 100000),
        cleanFloat(b.altitude, -1000, 10000),
        cleanText(b.viewMode, 40),
        cleanText(b.unit, 10),
        cleanText(b.appVersion, 80),
        cleanText(req.header("user-agent"), 300),
      ]
    );

    res.json({ ok: true, device: rows[0] });
  } catch (e) {
    console.error("device heartbeat failed", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/devices", requireDashboardAccess, async (req, res) => {
  try {
    await ensureGpsDevicesSchema();

    const where = [];
    const params = [];
    addDashboardScopeWhere(where, params, req.dashboardScope);

    const search = cleanText(req.query.q, 120);
    if (search) {
      params.push(`%${search}%`);
      const p = `$${params.length}`;
      where.push(`(
        device_id ILIKE ${p} OR device_name ILIKE ${p} OR client_name ILIKE ${p} OR
        assigned_course_name ILIKE ${p} OR last_course_name ILIKE ${p} OR
        cart_model ILIKE ${p} OR cart_serial ILIKE ${p} OR gps_serial ILIKE ${p}
      )`);
    }

    const status = cleanText(req.query.status, 30);
    if (status === "online") where.push("last_seen_at >= NOW() - INTERVAL '2 minutes'");
    if (status === "recent") where.push("last_seen_at < NOW() - INTERVAL '2 minutes' AND last_seen_at >= NOW() - INTERVAL '30 minutes'");
    if (status === "offline") where.push("last_seen_at < NOW() - INTERVAL '30 minutes'");
    if (status === "unassigned") where.push("(COALESCE(client_name, '') = '' AND COALESCE(assigned_short_code, '') = '')");

    const sqlWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const { rows } = await query(
      `SELECT ${gpsDeviceSelectSQL}
         FROM gps_devices
         ${sqlWhere}
        ORDER BY last_seen_at DESC NULLS LAST, first_seen_at DESC`,
      params
    );

    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, scope: req.dashboardScope, devices: rows });
  } catch (e) {
    console.error("device list failed", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/devices/:deviceId", requireDashboardAccess, async (req, res) => {
  try {
    await ensureGpsDevicesSchema();
    const deviceId = cleanDeviceId(req.params.deviceId);
    const { rows } = await query(`SELECT ${gpsDeviceSelectSQL} FROM gps_devices WHERE device_id = $1 LIMIT 1`, [deviceId]);
    if (!rows.length) return res.status(404).json({ ok: false, error: "not_found" });
    if (!dashboardDeviceVisible(rows[0], req.dashboardScope)) return res.status(403).json({ ok: false, error: "forbidden" });
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, scope: req.dashboardScope, device: rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.patch("/api/devices/:deviceId", requireDashboardAccess, async (req, res) => {
  try {
    await ensureGpsDevicesSchema();
    const deviceId = cleanDeviceId(req.params.deviceId);
    if (!deviceId) return res.status(400).json({ ok: false, error: "deviceId required" });

    const existing = await query(`SELECT * FROM gps_devices WHERE device_id = $1 LIMIT 1`, [deviceId]);
    if (!existing.rows.length) return res.status(404).json({ ok: false, error: "not_found" });
    if (!dashboardDeviceVisible(existing.rows[0], req.dashboardScope)) return res.status(403).json({ ok: false, error: "forbidden" });

    const b = req.body || {};
    const allowed = [
      ["device_name", cleanText(b.device_name ?? b.deviceName, 120)],
      ["client_name", cleanText(b.client_name ?? b.clientName, 160)],
      ["install_date", cleanDate(b.install_date ?? b.installDate)],
      ["warranty_months", cleanInt(b.warranty_months ?? b.warrantyMonths, 0, 240)],
      ["cart_model", cleanText(b.cart_model ?? b.cartModel, 140)],
      ["cart_serial", cleanText(b.cart_serial ?? b.cartSerial, 140)],
      ["gps_serial", cleanText(b.gps_serial ?? b.gpsSerial, 140)],
      ["contact_name", cleanText(b.contact_name ?? b.contactName, 160)],
      ["contact_phone", cleanText(b.contact_phone ?? b.contactPhone, 80)],
      ["contact_email", cleanText(b.contact_email ?? b.contactEmail, 180)],
      ["notes", cleanText(b.notes, 4000)],
    ];

    if (req.dashboardScope.type === "admin") {
      allowed.push(["assigned_short_code", safeId(b.assigned_short_code ?? b.assignedShortCode) || null]);
      allowed.push(["assigned_course_name", cleanText(b.assigned_course_name ?? b.assignedCourseName, 180)]);
    }

    const sets = [];
    const params = [];
    for (const [field, value] of allowed) {
      if (Object.prototype.hasOwnProperty.call(b, field) || Object.prototype.hasOwnProperty.call(b, field.replace(/_([a-z])/g, (_, c) => c.toUpperCase()))) {
        params.push(value);
        sets.push(`${field} = $${params.length}`);
      }
    }

    if (!sets.length) {
      const { rows } = await query(`SELECT ${gpsDeviceSelectSQL} FROM gps_devices WHERE device_id = $1 LIMIT 1`, [deviceId]);
      return res.json({ ok: true, scope: req.dashboardScope, device: rows[0] });
    }

    params.push(deviceId);
    const { rows } = await query(
      `UPDATE gps_devices
          SET ${sets.join(", ")}, updated_at = NOW()
        WHERE device_id = $${params.length}
        RETURNING ${gpsDeviceSelectSQL}`,
      params
    );

    res.json({ ok: true, scope: req.dashboardScope, device: rows[0] });
  } catch (e) {
    console.error("device update failed", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// PIN-protected list (used by ad-manager portal)
app.get("/api/ads/list", requireClubPin, (req, res) => {
  const files = listAds(req.shortCode);
  res.json({ ads: files.map((f) => `/ads/${req.shortCode}/${encodeURIComponent(f)}`) });
});

// PIN-protected upload (multipart form field name: files)
app.post("/api/ads/upload", requireClubPin, adsUpload.array("files", 30), (req, res) => {
  const dir = ensureClubDir(req.shortCode);

  for (const f of req.files || []) {
    const ext = path.extname(f.originalname || "").toLowerCase();
    if (![".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) continue;

    const base = path.basename(f.originalname).replace(/[^a-z0-9._-]/gi, "_");
    const name = `${Date.now()}_${base}`;
    fs.writeFileSync(path.join(dir, name), f.buffer);
  }

  const files = listAds(req.shortCode);
  res.json({ ads: files.map((f) => `/ads/${req.shortCode}/${encodeURIComponent(f)}`) });
});

// PIN-protected delete
app.delete("/api/ads/delete", requireClubPin, (req, res) => {
  const name = path.basename(String(req.query.name || ""));
  if (!name) return res.status(400).send("Missing name");

  const fp = path.join(adsDir, req.shortCode, name);
  try {
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch (_) {}

  const files = listAds(req.shortCode);
  res.json({ ads: files.map((f) => `/ads/${req.shortCode}/${encodeURIComponent(f)}`) });
});

// Public ads list for tablets (no PIN). Cached by SW; keep no-store to prevent stale lists.
app.get("/ads/:course/ads.json", (req, res) => {
  const shortCode = safeId(req.params.course);
  const files = shortCode ? listAds(shortCode) : [];
  res.setHeader("Cache-Control", "no-store");
  res.json({ ads: files.map((f) => `/ads/${shortCode}/${encodeURIComponent(f)}`) });
});

// Serve ad images (public)
app.get("/ads/:course/:file", (req, res, next) => {
  const shortCode = safeId(req.params.course);
  const file = path.basename(req.params.file);
  const fp = path.join(adsDir, shortCode, file);
  if (!fs.existsSync(fp)) return next();
  return res.sendFile(fp);
});




// ----- Start -----
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`TrackLinq server running on :${PORT}`));
