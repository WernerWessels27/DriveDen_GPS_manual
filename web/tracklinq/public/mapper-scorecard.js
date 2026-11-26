/* DriveDen Mapper — scorecard SI reader (no third-party scorecard scraping).
   Reads user-selected photos/PDFs locally in the browser and parses copied text.
   Suggested indexes always require review before applying to course data.
*/
(function(global){
  'use strict';
  function validPermutation(nums,count){
    return Array.isArray(nums)&&nums.length===count&&
      nums.every(n=>Number.isInteger(n)&&n>=1&&n<=count)&&
      new Set(nums).size===count;
  }
  function numberTokens(s){
    return String(s||'').replace(/[|;,]/g,' ').trim().split(/\s+/)
      .filter(x=>/^\d{1,3}$/.test(x)).map(Number);
  }
  function collectCandidates(text,count=18){
    const raw=String(text||'').replace(/\r/g,'').replace(/\u00a0/g,' ');
    const lines=raw.split('\n').map(s=>s.replace(/[\t|]+/g,' ').replace(/[ ]+/g,' ').trim()).filter(Boolean);
    const found=[],seen=new Set();
    const add=(numbers,description)=>{
      if(!validPermutation(numbers,count))return;
      const id=numbers.join(',');
      if(seen.has(id))return;
      seen.add(id);
      found.push({numbers,description});
    };
    // Full row, as on many printed scorecards:
    // "Stroke Index 3 17 15 ... 12", or "SI | ...".
    const indexRows=[];
    for(let i=0;i<lines.length;i++){
      const line=lines[i];
      const m=line.match(/^(?:men'?s?|ladies|women'?s?)?\s*(?:stroke[\s-]*index(?:es)?|strokes?\s*index|handicap(?:\s*index)?|h\/?cap|SI)\b\s*[:–-]?\s*(.*)$/i);
      if(!m)continue;
      const values=numberTokens(m[1]);
      if(values.length===count) add(values,'Stroke Index row ('+(i+1)+')');
      if(values.length===9&&count===18)indexRows.push(values);
      // OCR sometimes breaks after a label; try the following line too.
      if(!values.length && i+1<lines.length){
        const next=numberTokens(lines[i+1]);
        if(next.length===count)add(next,'SI row on next line');
        if(next.length===9&&count===18)indexRows.push(next);
      }
    }
    if(indexRows.length>=2&&count===18){
      for(let i=0;i<indexRows.length-1;i++)add([...indexRows[i],...indexRows[i+1]],'Front-nine + back-nine SI rows');
    }
    // HTML tables or printed scorecards copied to text:
    // "Hole Yellow Blue White ... SI Par"
    // "1 435 419 393 ... 3 4"
    // Supports multiple tee-set SI columns, producing distinct review choices.
    for(let i=0;i<lines.length;i++){
      const hdr=lines[i];
      if(!/^(?:hole|holes|no\.?)\b/i.test(hdr)||!/\bSI\b|stroke\s*index|handicap/i.test(hdr))continue;
      const titles=hdr.replace(/\bStroke\s+Index\b/gi,'SI')
        .replace(/\bHandicap\s+Index\b/gi,'SI')
        .replace(/\bHandicap\b/gi,'SI')
        .replace(/\bHole\s+(?:Number|No\.?)\b/gi,'Hole')
        .replace(/\s+/g,' ').split(' ');
      const indexes=[];
      for(let k=1;k<titles.length;k++)if(titles[k].toUpperCase()==='SI')indexes.push(k);
      const rows=new Map();
      for(let j=i+1;j<Math.min(lines.length,i+60);j++){
        const row=lines[j], tokens=numberTokens(row);
        if(/^(?:OUT|IN|TOTAL|PAR)\b/i.test(row))continue;
        const holeNo=tokens[0];
        if(Number.isInteger(holeNo)&&holeNo>=1&&holeNo<=count && tokens.length>=3){
          rows.set(holeNo,tokens);
          if(rows.size===count)break;
        }
        if(/^(?:download|scorecard|course\s+rating)\b/i.test(row)&&rows.size>=count/2)break;
      }
      if(rows.size<count)continue;
      for(let k=0;k<indexes.length;k++){
        const col=indexes[k],nums=[];
        for(let h=1;h<=count;h++){
          const row=rows.get(h);
          // Header and number columns line up when all tee names are one token.
          // Allow a single SI-before-Par fallback for tables with multiword labels.
          let si=row?.[col];
          if((!si||si>count)&&indexes.length===1&&row?.length>=3){
            si=row.at(-2);
          }
          nums.push(si);
        }
        add(nums,'Scorecard table: SI column '+(k+1));
      }
    }
    // Plain 18-number text selected from a scorecard is safe to prefill only
    // when no unrelated numbers are present.
    if(lines.length<=3){
      const all=numberTokens(lines.join(' '));
      if(validPermutation(all,count))add(all,'18-number SI list');
    }
    return found;
  }
  function loadScript(url,globalName){
    if(global[globalName])return Promise.resolve(global[globalName]);
    return new Promise((resolve,reject)=>{
      const script=document.createElement('script');
      script.src=url;script.async=true;
      script.onload=()=>global[globalName]?resolve(global[globalName]):reject(Error('Library failed to initialise'));
      script.onerror=()=>reject(Error('Could not load scorecard reader library. Check internet access.'));
      document.head.appendChild(script);
    });
  }
  async function ocrImage(blob,status){
    const tess=await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js','Tesseract');
    let worker;
    try{
      worker=await tess.createWorker('eng',1,{
        logger:p=>{if(p?.status==='recognizing text'&&typeof status==='function')
          status('Reading scorecard photo… '+Math.round((p.progress||0)*100)+'%');}
      });
      const r=await worker.recognize(blob);
      return r.data?.text || '';
    }finally{if(worker)await worker.terminate();}
  }
  async function readPdf(file,status){
    const lib=await loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js','pdfjsLib');
    lib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    const documentObj=await lib.getDocument({data:new Uint8Array(await file.arrayBuffer())}).promise;
    const total=Math.min(4,documentObj.numPages),pages=[];
    for(let n=1;n<=total;n++){
      if(typeof status==='function')status('Reading PDF page '+n+' of '+total+'…');
      const page=await documentObj.getPage(n);
      const content=await page.getTextContent();
      const items=content.items.map(x=>({
        text:String(x.str||''),x:Number(x.transform?.[4]||0),y:Number(x.transform?.[5]||0)
      })).filter(x=>x.text.trim());
      const lines=[];
      for(const item of items.sort((a,b)=>b.y-a.y||a.x-b.x)){
        let line=lines.find(x=>Math.abs(x.y-item.y)<3);
        if(!line){line={y:item.y,items:[]};lines.push(line);}
        line.items.push(item);
      }
      const text=lines.sort((a,b)=>b.y-a.y)
        .map(line=>line.items.sort((a,b)=>a.x-b.x).map(v=>v.text).join(' '))
        .join('\n');
      pages.push(text);
      if(collectCandidates(text,18).length)continue;
      if(text.trim().length>700)continue; // likely a text PDF; avoid unnecessary OCR
      // Scanned PDFs contain no embedded text. OCR locally, no upload.
      if(typeof status==='function')status('Scanned PDF: reading page '+n+' as an image…');
      const view=page.getViewport({scale:2});
      const scale=Math.min(1,2000/Math.max(view.width,view.height));
      const scaled=page.getViewport({scale:2*scale});
      const canvas=document.createElement('canvas');
      canvas.width=Math.ceil(scaled.width);canvas.height=Math.ceil(scaled.height);
      await page.render({canvasContext:canvas.getContext('2d'),viewport:scaled}).promise;
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
      if(blob)pages.push(await ocrImage(blob,status));
      canvas.width=canvas.height=1;
    }
    return pages.join('\n\n');
  }
  async function readFile(file,status){
    if(!file)throw Error('Choose a photo or PDF of the club scorecard.');
    if(file.size>20*1024*1024)throw Error('Maximum scorecard file size is 20 MB.');
    const mime=String(file.type||'').toLowerCase(),name=String(file.name||'').toLowerCase();
    if(mime==='application/pdf'||name.endsWith('.pdf'))return readPdf(file,status);
    if(mime.startsWith('image/')||/\.(jpg|jpeg|png|webp|bmp)$/i.test(name))return ocrImage(file,status);
    if(mime.startsWith('text/')||name.endsWith('.txt'))return file.text();
    throw Error('Use a scorecard image (JPG/PNG), PDF, or text file.');
  }
  global.DriveDenScorecardReader=Object.freeze({
    collectCandidates,validPermutation,readFile
  });
})(window);
