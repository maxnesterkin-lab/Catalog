// Saby catalog synchronization. Candidate version: test without publishing first.
'use strict';
const fs = require('node:fs');
const BASE = 'https://api.sbis.ru/retail/';
const STORE_ORDER = ['Баумана','ГУМ','Гаджиева','КТМ','Крупской','Книповича','Кольский','Ленина','Мир','ПЗ','Североморск'];
const EXCLUDE_ROOTS = ['вывод из ассортимента'];
const COLORS = ['#9fd8ff','#ffb36b','#ff8fb1','#b9a5ff','#ffd23f','#8be28b','#7fe3d6','#f2a0ff','#ff7a59','#c9e6ff'];
const sort = new Intl.Collator('ru');
const byName = (a,b) => sort.compare(a.name,b.name) || String(a.id ?? a.hid).localeCompare(String(b.id ?? b.hid));
const normalize = x => String(x ?? '').trim().toLowerCase().replace(/ё/g,'е').replace(/^(sv|si)\s+/,'');
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const numeric = v => (v == null || String(v).trim()==='' || typeof v==='boolean' || !Number.isFinite(Number(v))) ? null : Number(v);
const key = v => {if (v==null || String(v).trim()==='') throw Error('Missing Saby ID'); return String(v);};
const colorFor = name => {let h=0; for(const c of name) h=(h*31+c.charCodeAt(0))>>>0; return COLORS[h%COLORS.length];};
function clean(name, folder) {const f=name.trim(); if(f.toLowerCase().startsWith(folder.toLowerCase())) return f.slice(folder.length).replace(/^[\s\-–—:,/]+/,'').trim()||f; return f;}
function rows(d, field) {
const v=d?.[field];
if(Array.isArray(v)) return v;
if(v && typeof v==='object') {
if('id' in v || 'name' in v) return [v];
const a=Object.values(v); if(a.every(r=>r && typeof r==='object' && !Array.isArray(r))) return a;
}
throw Error('Unexpected API field: '+field);
}
function client(env, fetcher=fetch, pause=sleep) {
let token, requests=0;
async function login(){
if(!env.SABY_APP_ID||!env.SABY_APP_SECRET||!env.SABY_SECRET_KEY) throw Error('Missing GitHub secrets');
const r=await fetcher('https://online.sbis.ru/oauth/service/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({app_client_id:env.SABY_APP_ID,app_secret:env.SABY_APP_SECRET,secret_key:env.SABY_SECRET_KEY}),redirect:'error',signal:AbortSignal.timeout(20000)});
if(!r.ok) throw Error('Authorization HTTP '+r.status);
const d=await r.json(); token=d.token||d.access_token; if(typeof token!=='string'||!token) throw Error('Missing access token');
}
async function get(path, params){
const u=new URL(path,BASE); for(const [k,v] of Object.entries(params)) if(v!=null) u.searchParams.set(k,String(v));
let relogged=false;
for(let a=1;a<=4;a++){
if(++requests>12000) throw Error('Request budget exceeded');
await pause(150);
let r;
try {r=await fetcher(u,{headers:{'X-SBISAccessToken':token},redirect:'error',signal:AbortSignal.timeout(20000)});} catch {if(a===4) throw Error('Network/timeout'); await pause(1000*a);continue;}
if(r.ok) return r.json();
if(r.status===401&&!relogged){await login();relogged=true;a--;continue;}
if((r.status===429||r.status>=500)&&a<4){const raw=r.headers.get('retry-after');const seconds=Number(raw);if(seconds>60) throw Error('Retry-after exceeds limit');await pause(Math.max(a*1000,Number.isFinite(seconds)?seconds*1000:0));continue;}
const e=Error('HTTP '+r.status+' at '+path+' page='+params.page+' pageSize='+params.pageSize+' scope='+(params.folder==null?'root':'folder'));e.status=r.status;throw e;
}
throw Error('API retry limit');
}
return {login,get,count:()=>requests};
}
async function paged(api,params,size){
const all=[];const seen=new Set();
for(let page=0;page<3000;page++){
const d=await api.get('v2/nomenclature/list',{...params,pageSize:size,page});
const part=rows(d,'nomenclatures');
for(const x of part){const k=(x.isParent?'F:':'P:')+key(x.isParent?(x.hierarchicalId??x.id):x.id);if(seen.has(k)) throw Error('Duplicate row during pagination');seen.add(k);all.push(x);}
if(d?.outcome?.hasMore===false) return all;
if(d?.outcome?.hasMore!==true||!part.length) throw Error('Uncertain pagination');
}
throw Error('Page budget exceeded');
}

async function cursorPaged(api,params,size){
 const all=[],seen=new Set(),cursors=new Set();
 let position;
 for(let page=0;page<3000;page++){
  const d=await api.get('v2/nomenclature/list',{
   ...params,pageSize:size,order:'after',position
  });
  const part=rows(d,'nomenclatures');
  for(const x of part){
   if(params.folder!=null &&
      String(x.hierarchicalParent)!==String(params.folder))
     throw Error('Unexpected parent folder');
   const k=(x.isParent?'F:':'P:')+
     key(x.isParent?(x.hierarchicalId??x.id):x.id);
   if(seen.has(k))throw Error('Duplicate cursor row');
   seen.add(k);all.push(x);
  }
  const more=typeof d.outcome==='boolean'
    ?d.outcome:d.outcome?.hasMore;
  if(more===false)return all;
  if(more!==true||!part.length)
    throw Error('Uncertain pagination');
  const next=key(part[part.length-1].hierarchicalId);
  if(cursors.has(next))throw Error('Repeated cursor');
  cursors.add(next);position=next;
 }
 throw Error('Cursor page budget exceeded');
}

async function folder(api,params){
 let err;
 for(const size of [100,30,10,3,1]){
  try{return await paged(api,params,size);}
  catch(e){err=e;if(!(e.status>=500))throw e;}
 }
 if(params.folder==null)throw err;
 console.log('Cursor fallback: folder='+params.folder+' point='+(params.pointId??'global'));
 for(const size of [25,10,3,1]){
  try{
   const result=await cursorPaged(api,params,size);
   console.log('Cursor fallback OK: folder='+params.folder+' rows='+result.length);
   return result;
  }catch(e){err=e;if(!(e.status>=500))throw e;}
 }
 throw err;
}
async function sync(api,prev,log=console.log){
await api.login();
const points=rows(await api.get('point/list',{product:'retail',pageSize:100}),'salesPoints');
const stores=STORE_ORDER.map(name=>{
const target=normalize(name);const matches=points.filter(p=>normalize(p.name)===target||(target==='гаджиева'&&normalize(p.name)==='гаджиево'));
if(matches.length!==1) throw Error('Sales point not unique: '+name);
return {name,id:key(matches[0].id)};
});
if(new Set(stores.map(s=>s.id)).size!==stores.length) throw Error('Duplicate sales point ID');
const nodes=new Set(),ids=new Set();
async function walk(parent=null,depth=0){
if(depth>12) throw Error('Catalog nesting limit');
const arr=await folder(api,{folder:parent,withBalance:false});
const children=[],leaves=[];
for(const x of arr){
const name=String(x.name??'').trim(); if(!name) throw Error('Unnamed catalog row');
if(x.isParent){
if(parent===null&&EXCLUDE_ROOTS.includes(normalize(name)))continue;
const hid=key(x.hierarchicalId??x.id);if(nodes.has(hid))throw Error('Duplicate catalog folder');nodes.add(hid);
const sub=await walk(hid,depth+1).catch(e=>{if(!e.folderContext){e.message+="; folder="+JSON.stringify(name)+" id="+hid;e.folderContext=true;}throw e;});children.push({name,hid,...sub});
} else {
if(parent===null)throw Error('Root-level product requires catalog mapping');
const id=key(x.id);if(ids.has(id))throw Error('Duplicate catalog product ID');ids.add(id);
leaves.push({id,name,cost:numeric(x.cost),stock:Array(stores.length).fill(null),pointCosts:Array(stores.length).fill(null)});
}
}
return {children,leaves};
}
const roots=(await walk()).children;
let leafFolders=[];
function gather(n){if(n.leaves.length)leafFolders.push(n);n.children.forEach(gather);}
roots.forEach(gather);
if(!ids.size)throw Error('Empty global catalog');
log(`Global catalog: ${ids.size} products; ${leafFolders.length} folders; ${stores.length} stores`);
// We deliberately never treat missing rows as confirmed zero stock.
// If the API omits a row, retain the published file unchanged and report how many are unknown.
let unknown=0;
for(let si=0;si<stores.length;si++){
const store=stores[si];let missing=0,positive=0;
for(const n of leafFolders){
const results=await folder(api,{pointId:store.id,folder:n.hid,withBalance:true});
const mapped=new Map(results.filter(x=>!x.isParent).map(x=>[key(x.id),x]));
for(const leaf of n.leaves){
const r=mapped.get(leaf.id);
const b=numeric(r?.balance);
leaf.stock[si]=b;leaf.pointCosts[si]=numeric(r?.cost);
if(b===null)missing++; else if(b>0)positive++;
}
}
unknown+=missing;log(`Stock ${store.name}: positive=${positive}; unknown=${missing}; requests=${api.count()}`);
}
if(unknown)throw Error(`Unknown balances: ${unknown}. data.json unchanged; verify API omission semantics.`);
const categories=[];let total=0;
for(const root of roots.slice().sort(byName)){
const items=[];
function collect(n){
if(n.leaves.length){
const leaves=n.leaves.slice().sort(byName);
const prices=leaves.map(l=>{const preferred=l.pointCosts[0];if(preferred>0)return preferred;if(l.cost>0)return l.cost;const candidates=l.pointCosts.filter(c=>c>0);return candidates.length?Math.min(...candidates):null;});
if(prices.some(p=>p===null))throw Error('Missing valid prices in '+n.name);
const flavors=leaves.map(l=>({name:clean(l.name,n.name),stores:l.stock.flatMap((v,i)=>v>0?[i]:[])}));
items.push({name:n.name,meta:'',price:Math.min(...prices),color:colorFor(n.name),flavors});total+=flavors.length;
}
n.children.slice().sort(byName).forEach(collect);
}
collect(root);if(items.length)categories.push({name:root.name,items});
}
const oldCount=prev.categories.reduce((a,c)=>a+c.items.reduce((b,it)=>b+it.flavors.length,0),0);
if(total<oldCount)throw Error(`Catalog shrank from ${oldCount} to ${total}; manual review required`);
const newCats=new Set(categories.map(c=>normalize(c.name)));
if(prev.categories.some(c=>!EXCLUDE_ROOTS.includes(normalize(c.name))&&!newCats.has(normalize(c.name))))throw Error('Previously published category missing; manual review required');
log(`Result: ${categories.length} categories; ${total} positions; old positions=${oldCount}; requests=${api.count()}`);
return {stores:stores.map(s=>s.name),categories};
}
async function main(){
const started=Date.now();const prev=JSON.parse(fs.readFileSync('data.json','utf8'));
if(!Array.isArray(prev.categories)||!Array.isArray(prev.stores))throw Error('Unexpected current data.json format');
const api=client(process.env);const content=await sync(api,prev);
if(JSON.stringify(content)===JSON.stringify({stores:prev.stores,categories:prev.categories}))console.log('No changes.');
else {const tmp='data.json.saby.tmp';fs.writeFileSync(tmp,JSON.stringify({updated:new Date().toISOString(),...content}));fs.renameSync(tmp,'data.json');console.log('Candidate data.json generated locally.');}
console.log(`Completed in ${Math.round((Date.now()-started)/1000)} s; requests=${api.count()}`);
}
if(require.main===module)main().catch(e=>{console.error('Sync stopped: '+e.message);process.exitCode=1;});
module.exports={sync,client,paged,STORE_ORDER};
