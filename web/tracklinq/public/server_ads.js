const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const ADS_DIR = process.env.ADS_DIR || path.join(PUBLIC_DIR, 'ads');
const COURSES_DIR = path.join(PUBLIC_DIR, 'courses');

app.use(express.static(PUBLIC_DIR));

function safeId(id){
  return String(id || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
}

function ensureDir(dir){
  if(!fs.existsSync(dir)){
    fs.mkdirSync(dir, { recursive:true });
  }
}

function listAds(courseId){
  const dir = path.join(ADS_DIR, courseId);
  ensureDir(dir);

  return fs.readdirSync(dir)
    .filter(f => /\.(png|jpg|jpeg|webp|gif)$/i.test(f))
    .sort();
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }
});

function getCoursePin(courseId){

  const indexPath = path.join(COURSES_DIR, 'index.json');

  if(fs.existsSync(indexPath)){
    const index = JSON.parse(fs.readFileSync(indexPath));
    const c = (index.courses || []).find(x => x.id === courseId);

    if(c && c.pin){
      return c.pin.trim().toUpperCase();
    }
  }

  const coursePath = path.join(COURSES_DIR, `${courseId}.json`);

  if(fs.existsSync(coursePath)){
    const course = JSON.parse(fs.readFileSync(coursePath));
    return (course?.course?.pin || '').trim().toUpperCase();
  }

  return null;
}

function requirePin(req,res,next){

  const courseId = safeId(req.query.course);
  const pin = String(req.query.pin || '').trim().toUpperCase();

  if(!courseId){
    return res.status(400).send('Missing course');
  }

  if(pin.length !== 10){
    return res.status(401).send('Invalid PIN');
  }

  const expected = getCoursePin(courseId);

  if(!expected || expected !== pin){
    return res.status(401).send('Invalid PIN');
  }

  req.courseId = courseId;

  next();
}

app.get('/api/ads/list', requirePin, (req,res)=>{

  const files = listAds(req.courseId);

  const ads = files.map(f => `/ads/${req.courseId}/${encodeURIComponent(f)}`);

  res.json({ ads });
});

app.post('/api/ads/upload', requirePin, upload.array('files',20), (req,res)=>{

  const dir = path.join(ADS_DIR, req.courseId);
  ensureDir(dir);

  for(const f of req.files || []){

    const ext = path.extname(f.originalname).toLowerCase();

    if(!['.png','.jpg','.jpeg','.webp','.gif'].includes(ext)){
      continue;
    }

    const name = Date.now() + '_' + path.basename(f.originalname);
    fs.writeFileSync(path.join(dir,name), f.buffer);
  }

  const files = listAds(req.courseId);

  res.json({
    ads: files.map(f => `/ads/${req.courseId}/${encodeURIComponent(f)}`)
  });
});

app.delete('/api/ads/delete', requirePin, (req,res)=>{

  const name = path.basename(req.query.name || '');
  const file = path.join(ADS_DIR, req.courseId, name);

  if(fs.existsSync(file)){
    fs.unlinkSync(file);
  }

  const files = listAds(req.courseId);

  res.json({
    ads: files.map(f => `/ads/${req.courseId}/${encodeURIComponent(f)}`)
  });
});

app.get('/ads/:course/ads.json', (req,res)=>{

  const courseId = safeId(req.params.course);

  const files = listAds(courseId);

  res.json({
    ads: files.map(f => `/ads/${courseId}/${encodeURIComponent(f)}`)
  });
});

app.get('/ads/:course/:file', (req,res)=>{

  const file = path.join(ADS_DIR, safeId(req.params.course), path.basename(req.params.file));

  res.sendFile(file);
});

app.listen(PORT, ()=>{
  console.log("DriveDen GPS Ads server running on port " + PORT);
});
