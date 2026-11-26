import {readFileSync} from "node:fs";
// Verified course scorecard facts; served only as matching Mapper results.
function normalizeName(s){return String(s||"").normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/&/g," and ").replace(/\b(golf|country|club|course|gc|cc|the|and)\b/g," ").replace(/[^a-z0-9]+/g," ").trim().replace(/\s+/g," ");}
function matchVerified(records,name,club,pars,tee){
  const n=normalizeName(name),cl=normalizeName(club);
  if(!n||!Array.isArray(pars)||pars.length!==18||!pars.every(v=>Number.isInteger(v)&&v>=3&&v<=6))return [];
  const generic=/^(north|south|east|west|main|old|new|links|championship|par 3|18 hole|9 hole)$/;
  const combined=[n,cl+" "+n,n+" "+cl].filter(Boolean);
  const matches=records.filter(r=>{
    if(!Array.isArray(r)||!Array.isArray(r[2]))return false;
    if(generic.test(n)&&(!cl||r[1]!==cl))return false;
    if(cl&&cl!==n&&r[1]!==cl&&r[0]!==cl+" "+n&&r[0]!==n+" "+cl)return false;
    // Resolve normalized-name collisions using the full hole-by-hole par sequence before rejecting ambiguity.
    return combined.includes(r[0]) && r[2].some(t=>Array.isArray(t)&&t[2]===pars.join(''));
  });
  if(matches.length!==1)return [];
  const grouped=new Map();
  for(const [label,gender,p,s] of matches[0][2]){
    if(p!==pars.join("")||typeof s!=="string")continue;
    const nums=Array.from(s,x=>parseInt(x,19));
    if(nums.length!==18||nums.some(x=>!Number.isInteger(x)||x<1||x>18)||new Set(nums).size!==18)continue;
    const key=nums.join(",");
    const entry=grouped.get(key)||{numbers:nums,labels:[],tees:[]};
    entry.labels.push(label+" ("+gender+")");entry.tees.push(normalizeName(label));
    grouped.set(key,entry);
  }
  const all=[...grouped.values()];
  const selected=normalizeName(tee);
  const preferred=selected?all.filter(x=>x.tees.includes(selected)):[];
  return (preferred.length===1?preferred:all).map(x=>({numbers:x.numbers,label:[...new Set(x.labels)].join(", ")}));
}
let records;
export function verifiedStrokeOptions(name,club,pars,tee){
 if(!records){
  try{
   const snapshot=JSON.parse(readFileSync(new URL('./verified-scorecards.json',import.meta.url),'utf8'));
   records=snapshot.courses.map(c=>[normalizeName(c.name),normalizeName(c.clubName),c.tees.map(t=>[t.tee,t.gender,t.pars.join(''),t.strokeIndexes.map(n=>n.toString(19)).join('')])]);
  }catch(e){console.warn('Verified SI reference unavailable:',e.message);records=[];}
 }
 return matchVerified(records,name,club,pars,tee);
}
export {matchVerified};
