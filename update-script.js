// Saby catalog synchronization — candidate, preview only until reviewed.
'use strict';
const fs = require('node:fs');
const BASE = 'https://api.sbis.ru/retail/';
const STORE_ORDER = ['Баумана','ГУМ','Гаджиева','КТМ','Крупской','Книповича','Кольский','Ленина','Мир','ПЗ','Североморск'];
const WAREHOUSES = [[14401,14403,249],[433,303,249],[14406,14408,249],[14179,14000,249],[16974,16976,249],[14412,14414,249],[446,293,249],[409,305,249],[11101,11103,11091],[452,309,249],[18093,18095,17792]];
const EXCLUDE_ROOTS = ['вывод из ассортимента','служебный раздел'];
const COLORS = ['#9fd8ff','#ffb36b','#ff8fb1','#b9a5ff','#ffd23f','#8be28b','#7fe3d6','#f2a0ff','#ff7a59','#c9e6ff'];
const sort = new Intl.Collator('ru');
const byName = (a,b) => sort.compare(a.name,b.name) || String(a.id ?? a.hid).localeCompare(String(b.id ?? b.hid));
const normalize = x => String(x ?? '').trim().toLowerCase().replace(/ё/g,'е').replace(/^(sv|si|severvape|север вейп)\s+/,'');
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const numeric = v => (v == null || String(v).trim()==='' || typeof v==='boolean' || !Number.isFinite(Number(v))) ? null : Number(v);
const key = v => {if (v==null || String(v).trim()==='') throw Error('Missing Saby ID'); return String(v);};
const colorFor = name => {let h=0; for(const c of name) h=(h*31+c.charCodeAt(0))>>>0; return COLORS[h%COLORS.length];};
function clean(name, folder) {const f=name.trim(); if(f.toLowerCase().startsWith(folder.toLowerCase())) return f.slice(folder.length).replace(/^[\s\-–—:,/]+/,'').trim()||f; return f;}
function rows(d, fields, idKeys=['id','name']) {
let v=Array.isArray(d)?d:fields.map(f=>d?.[f]).find(x=>x!=null);
if(v && typeof v==='object' && !Array.isArray(v)) v=idKeys.some(k=>k in v)?[v]:Object.values(v);
if(!Array.isArray(v)||!v.every(x=>x&&typeof x==='object'&&!Array.isArray(x)))throw Error('Unexpected API rows: '+fields.join(','));
return v;
}
function client(env, fetcher=fetch, pause=sleep) {
let token, requests=0;
async function login(){
if(!env.SABY_APP_ID||!env.SABY_APP_SECRET||!env.SABY_SECRET_KEY) throw Error('Missing GitHub secrets');
const r=await fetcher('https://online.sbis.ru/oauth/service/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({app_client_id:env.SABY_APP_ID,app_secret:env.SABY_APP_SECRET,secret_key:env.SABY_SECRET_KEY}),redirect:'error',signal:AbortSignal.timeout(20000)});
if(!r.ok) throw Error('Authorization HTTP '+r.status);
const d=await r.json(); token=d.token||d.access_token; if(typeof token!=='string'||!token) throw Error('Missing access token');
}
async function get(path, params, encoding='repeat'){
const u=new URL(path,BASE); for(const [k,v] of Object.entries(params)) if(Array.isArray(v)){if(encoding==='json')u.searchParams.set(k,JSON.stringify(v));else for(const x of v)u.searchParams.append(k,String(x));}else if(v!=null)u.searchParams.set(k,String(v));
let relogged=false;
for(let a=1;a<=4;a++){
if(++requests>4000) throw Error('Request budget exceeded');
await pause(2000);
let r;
try {r=await fetcher(u,{headers:{'X-SBISAccessToken':token},redirect:'error',signal:AbortSignal.timeout(20000)});} catch {if(a===4) throw Error('Network/timeout'); await pause(1000*a);continue;}
if(r.ok) return r.json();
if(r.status===401&&!relogged){await login();relogged=true;a--;continue;}
if((r.status===429||r.status>=500)&&a<4){const raw=r.headers.get('retry-after');const seconds=Number(raw);if(seconds>60) throw Error('Retry-after exceeds limit');await pause(Math.max(a*1000,Number.isFinite(seconds)?seconds*1000:0));continue;}
const e=Error('HTTP '+r.status+' at '+path+' page='+params.page+' scope='+(params.folder??'root'));e.status=r.status;throw e;
}
throw Error('API retry limit');
}
return {login,get,count:()=>requests};
}
// Test 73 used page size 25 and switched to cursor navigation after page 39.
async function paged(api,params,size=25){
const all=[],seen=new Set(),cursors=new Set();let position=null,cursor=false;
for(let page=0;page<400;page++){
const nav=cursor?{order:'after',position,pageSize:size}:{page,pageSize:size};
const d=await api.get('v2/nomenclature/list',{...params,...nav});
const part=rows(d,['nomenclatures'],['id']);
for(const x of part){const k=(x.isParent?'F:':'P:')+key(x.isParent?(x.hierarchicalId??x.id):x.id);if(seen.has(k)) throw Error('Duplicate row during pagination');seen.add(k);all.push(x);}
const more=typeof d.outcome==='boolean'?d.outcome:d.outcome?.hasMore;
if(more===false) return all;
if(more!==true||!part.length) throw Error('Uncertain pagination');
if(page>=39||cursor){const next=key(part.at(-1).hierarchicalId);if(cursors.has(next))throw Error('Repeated cursor');cursors.add(next);position=next;cursor=true;}
}
throw Error('Page budget exceeded');
}
async function direct(api,store,batch){
const params={nomenclatures:batch.map(l=>l.id),warehouses:[store.warehouseId],companies:[store.companyId]};
let raw;
try{raw=await api.get('nomenclature/balances',params);}catch(e){if(![400,422].includes(e.status))throw e;raw=await api.get('nomenclature/balances',params,'json');}
const allowed=new Set(batch.map(l=>l.id));const m=new Map();
for(const x of rows(raw,['balances','nomenclatures','items','data','result'],['nomenclature'])){
const id=key(x.nomenclature);
if(!allowed.has(id)||m.has(id))throw Error('Unexpected/duplicate product ID in balance response');
// Validate scope when the API includes it.
if(x.warehouse!=null && typeof x.warehouse!=='object' && String(x.warehouse)!==String(store.warehouseId))throw Error('Unexpected warehouse in balance response');
if(x.company!=null && typeof x.company!=='object' && String(x.company)!==String(store.companyId))throw Error('Unexpected company in balance response');
m.set(id,numeric(x.balance));
}return m;
}
const composite=(...parts)=>JSON.stringify(parts);
function addUnique(map,k,v){map.set(k,map.has(k)?null:v);}
function previousIndex(prev){
if(!Array.isArray(prev.categories)||!Array.isArray(prev.stores)||new Set(prev.stores).size!==STORE_ORDER.length||prev.stores.length!==STORE_ORDER.length||STORE_ORDER.some(n=>!prev.stores.includes(n)))throw Error('Unexpected previous store list');
const items=new Map(),flavors=new Map();
for(const c of prev.categories){if(typeof c.name!=='string'||!Array.isArray(c.items))throw Error('Invalid previous category');for(const it of c.items){if(typeof it.name!=='string'||!Array.isArray(it.flavors))throw Error('Invalid previous item');addUnique(items,composite(c.name,it.name),it);
for(const f of it.flavors){if(typeof f.name!=='string'||!Array.isArray(f.stores)||f.stores.some(i=>!Number.isInteger(i)||i<0||i>=prev.stores.length))throw Error('Invalid previous flavor');addUnique(flavors,composite(c.name,it.name,f.name),new Set(f.stores.map(i=>prev.stores[i])));}}}
return {items,flavors};
}
async function sync(api,prev,log=console.log,report={},save=()=>{}){
const old=previousIndex(prev);report.complete=false;report.stock=[];report.missing=[];report.negative=[];report.invalid=[];report.priceIssues=[];report.excluded=[];report.preserved=0;report.unresolved=0;report.removed=[];
await api.login();
const points=rows(await api.get('point/list',{product:'retail',pageSize:100,page:0}),['salesPoints'],['id']);
const stores=STORE_ORDER.map((name,i)=>{const [pointId,warehouseId,companyId]=WAREHOUSES[i];const target=normalize(name);const matches=points.filter(p=>normalize(p.name)===target||(target==='гаджиева'&&normalize(p.name)==='гаджиево'));
if(matches.length!==1||String(matches[0].id)!==String(pointId))throw Error('Sales point mapping changed: '+name);
return {name,id:String(pointId),warehouseId,companyId};});report.mapping=stores;save();
const nodes=new Set(),ids=new Set();
async function walk(parent=null,depth=0){
if(depth>12) throw Error('Catalog nesting limit');
const arr=await paged(api,{folder:parent,withBalance:false});
const children=[],leaves=[];
for(const x of arr){
const name=String(x.name??'').trim(); if(!name) throw Error('Unnamed catalog row');
if(x.isParent){
if(parent===null&&EXCLUDE_ROOTS.includes(normalize(name))){report.excluded.push(name);continue;}
const hid=key(x.hierarchicalId??x.id);if(nodes.has(hid))throw Error('Duplicate catalog folder');nodes.add(hid);
const sub=await walk(hid,depth+1).catch(e=>{if(!e.folderContext){e.message+='; folder='+JSON.stringify(name)+' id='+hid;e.folderContext=true;}throw e;});children.push({name,hid,...sub});
} else {
if(parent===null)throw Error('Root-level product requires catalog mapping');
const id=key(x.id);if(ids.has(id))throw Error('Duplicate catalog product ID');ids.add(id);
leaves.push({id,name,cost:numeric(x.cost),stock:Array(stores.length).fill(null)});
}
}
return {children,leaves};
}
const roots=(await walk()).children;
const leafFolders=[];const all=[];
function gather(n,root){if(n.leaves.length){leafFolders.push(n);for(const l of n.leaves){l.root=root;l.group=n.name;l.display=clean(l.name,n.name);all.push(l);}}n.children.forEach(c=>gather(c,root));}
roots.forEach(r=>gather(r,r.name));
if(!ids.size)throw Error('Empty global catalog');
report.catalog={products:ids.size,folders:nodes.size};save();
log(`Global catalog: ${ids.size} products; ${leafFolders.length} leaf folders; ${stores.length} stores`);
const currentKeys=new Map();for(const l of all)addUnique(currentKeys,composite(l.root,l.group,l.display),l.id);
for(let si=0;si<stores.length;si++){
const store=stores[si];const stats={store:store.name,positive:0,zero:0,negative:0,missing:0,invalid:0,batches:0};report.stock.push(stats);
for(let i=0;i<all.length;i+=50){
const batch=all.slice(i,i+50);const mapped=await direct(api,store,batch);
for(const l of batch){const b=mapped.get(l.id);const rec={store:store.name,id:l.id};
if(!mapped.has(l.id)){stats.missing++;report.missing.push(rec);}
else if(b===null){stats.invalid++;report.invalid.push(rec);}
else if(b<0){stats.negative++;report.negative.push({...rec,value:b});l.stock[si]=false;continue;}
else{if(b>0)stats.positive++;else stats.zero++;l.stock[si]=b>0;continue;}
const k=composite(l.root,l.group,l.display);const v=old.flavors.get(k);
if(currentKeys.get(k)===l.id&&v instanceof Set){l.stock[si]=v.has(store.name);report.preserved++;rec.resolution='previous';rec.previousAvailable=l.stock[si];}
else{report.unresolved++;rec.resolution='unknown';}
}
stats.batches++;if(stats.batches%10===0)save();
}
if(stats.positive+stats.zero+stats.negative+stats.missing+stats.invalid!==all.length)throw Error('Incomplete stock coverage');
log(`Stock ${store.name}: ${JSON.stringify(stats)}; requests=${api.count()}`);save();
}
const categories=[];let total=0;const emitted=new Set();
for(const root of roots.slice().sort(byName)){
const items=[];
function collect(n){
if(n.leaves.length){
const leaves=n.leaves.slice().sort(byName);const prior=old.items.get(composite(root.name,n.name));
const prices=leaves.map(l=>l.cost).filter(p=>p>0);const missing=leaves.filter(l=>!(l.cost>0));
let price=prices.length?Math.min(...prices):null;
if(missing.length){const p=numeric(prior?.price);if(p>0)price=p;for(const l of missing)report.priceIssues.push({id:l.id,group:n.name,resolution:p>0?'previous group price':price>0?'known group prices only':'group omitted in preview'});}
if(price===null){n.children.slice().sort(byName).forEach(collect);return;}
const flavors=leaves.map(l=>{const k=composite(root.name,n.name,l.display);emitted.add(k);return {name:l.display,stores:l.stock.flatMap((v,i)=>v===true?[i]:[])};});
items.push({name:n.name,meta:prior?.meta??'',price,color:prior?.color??colorFor(n.name),flavors});total+=flavors.length;
}
n.children.slice().sort(byName).forEach(collect);
}
collect(root);if(items.length)categories.push({name:root.name,items});
}
const oldCount=prev.categories.reduce((a,c)=>a+c.items.reduce((b,it)=>b+it.flavors.length,0),0);
for(const [k] of old.flavors){const [root]=JSON.parse(k);if(!EXCLUDE_ROOTS.includes(normalize(root))&&!emitted.has(k))report.removed.push(JSON.parse(k));}
report.result={categories:categories.length,positions:total,oldPositions:oldCount,requests:api.count(),publishBlocked:true};
report.complete=true;save();
if(!total)throw Error('Empty candidate catalog');
// Never publish in this revision: unresolved cells are omitted from the display-only preview,
// prior-name matching is not an immutable ID match, and price/removal changes need review.
log(`Result: ${categories.length} categories; ${total} positions; old positions=${oldCount}; requests=${api.count()}`);
return {stores:stores.map(s=>s.name),categories};
}
async function main(){
if(process.env.SABY_PREVIEW!=='1')throw Error('Preview-only candidate; publication disabled');
const started=Date.now(),report={version:'preview-75',started:new Date().toISOString(),complete:false,publishBlocked:true};
const save=()=>fs.writeFileSync('sync-preview-report.json',JSON.stringify(report));
try{save();const prev=JSON.parse(fs.readFileSync('data.json','utf8'));const api=client(process.env);const content=await sync(api,prev,console.log,report,save);
fs.writeFileSync('data.preview.json',JSON.stringify({updated:new Date().toISOString(),...content}));report.candidateWritten=true;report.elapsedSeconds=Math.round((Date.now()-started)/1000);save();}
catch(e){report.error=e.message;report.complete=false;save();throw e;}
}
if(require.main===module)main().catch(e=>{console.error('Sync stopped: '+e.message);process.exitCode=1;});
module.exports={sync,client,paged,direct,STORE_ORDER};
