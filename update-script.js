// Saby catalog synchronization.
'use strict';
const fs = require('node:fs');
const BASE = 'https://api.sbis.ru/retail/';
const WAREHOUSES = new Map([
  ['Баумана', {pointId:14401, warehouseId:14403, companyId:249}],
  ['ГУМ', {pointId:433, warehouseId:303, companyId:249}],
  ['Гаджиева', {pointId:14406, warehouseId:14408, companyId:249}],
  ['КТМ', {pointId:14179, warehouseId:14000, companyId:249}],
  ['Крупской', {pointId:16974, warehouseId:16976, companyId:249}],
  ['Книповича', {pointId:14412, warehouseId:14414, companyId:249}],
  ['Кольский', {pointId:446, warehouseId:293, companyId:249}],
  ['Ленина', {pointId:409, warehouseId:305, companyId:249}],
  ['Мир', {pointId:11101, warehouseId:11103, companyId:11091}],
  ['ПЗ', {pointId:452, warehouseId:309, companyId:249}],
  ['Североморск', {pointId:18093, warehouseId:18095, companyId:17792}],
]);
const STORE_ORDER = [...WAREHOUSES.keys()];
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
const u = new URL(path, BASE);
for (const [name, value] of Object.entries(params)) {
  if (Array.isArray(value)) {
    for (const entry of value) u.searchParams.append(name, String(entry));
  } else if (value != null) {
    u.searchParams.set(name, String(value));
  }
}
let relogged=false;
for(let a=1;a<=4;a++){
if(++requests>12000) throw Error('Request budget exceeded');
await pause(path === 'nomenclature/balances' ? 1500 : 450);
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
async function folder(api, params){
let err;
for(const size of [100,30,10,3,1]){
try{return await paged(api,params,size);}catch(e){err=e;if(!(e.status>=500))throw e;}
}
throw err;
}
async function fillWarehouseBalances(api, store, missing, storeIndex, log) {
  const batchSize = 50;
  for (let start = 0; start < missing.length; start += batchSize) {
    const batch = new Map(missing.slice(start, start + batchSize).map(leaf => [leaf.id, leaf]));
    const params = {
      nomenclatures: [...batch.keys()],
      warehouses: [store.warehouseId],
      companies: [store.companyId],
    };
    let response;
    try {
      response = await api.get('nomenclature/balances', params).catch(error => {
        if (error.status !== 400 && error.status !== 422) throw error;
        const jsonParams = Object.fromEntries(Object.entries(params).map(([name, values]) => [name, JSON.stringify(values)]));
        return api.get('nomenclature/balances', jsonParams);
      });
    } catch (error) {
      if (!(error.status >= 500)) throw error;
      log(`Warehouse ${store.name}: HTTP ${error.status}; ${batch.size} balances remain unconfirmed`);
      continue;
    }
    const fields = ['balances', 'nomenclatures', 'items', 'data', 'result'];
    const result = Array.isArray(response) ? response : response?.[fields.find(name => response?.[name] != null)];
    const records = result && typeof result === 'object'
      ? (Array.isArray(result) ? result : 'nomenclature' in result ? [result] : Object.values(result))
      : null;
    if (!records) throw Error('Invalid warehouse balance response for '+store.name);
    const seen = new Set();
    for (const record of records) {
      const id = key(record?.nomenclature);
      if (!batch.has(id) || seen.has(id)) throw Error('Unexpected or repeated warehouse item for '+store.name);
      seen.add(id);
      batch.get(id).stock[storeIndex] = numeric(record.balance);
    }
  }
}

async function sync(api,prev,log=console.log,{allowIncompletePreview=false}={}){
await api.login();
const points=rows(await api.get('point/list',{product:'retail',pageSize:100}),'salesPoints');
const stores=STORE_ORDER.map(name=>{
const target=normalize(name);const matches=points.filter(p=>normalize(p.name)===target||(target==='гаджиева'&&normalize(p.name)==='гаджиево'));
if(matches.length!==1) throw Error('Sales point not unique: '+name);
const mapping = WAREHOUSES.get(name);
if (key(matches[0].id) !== String(mapping.pointId)) throw Error('Store ID changed: '+name);
return {name,id:String(mapping.pointId),...mapping};
});
if(new Set(stores.map(s=>s.id)).size!==stores.length) throw Error('Duplicate sales point ID');
const nodes=new Set(),ids=new Set();
const deferredFolders=[];
async function walk(node,depth=0,defer=true){
if(depth>12) throw Error('Catalog nesting limit');
const parent=node.hid;
let arr;
try {
  arr=await folder(api,{folder:parent,withBalance:false});
} catch (error) {
  if (parent === null || !(error.status >= 500)) throw error;
  log(`Catalog folder ${node.name} (ID ${parent}): HTTP ${error.status}${defer ? '; retry deferred' : '; still unread'}`);
  if (defer) deferredFolders.push({node,depth});
  return false;
}
const {children,leaves}=node;
for(const x of arr){
const name=String(x.name??'').trim(); if(!name) throw Error('Unnamed catalog row');
if(x.isParent){
if(parent===null&&EXCLUDE_ROOTS.includes(normalize(name)))continue;
const hid=key(x.hierarchicalId??x.id);if(nodes.has(hid))throw Error('Duplicate catalog folder');nodes.add(hid);
const child={name,hid,children:[],leaves:[]};
children.push(child);
await walk(child,depth+1);
} else {
if(parent===null)throw Error('Root-level product requires catalog mapping');
const id=key(x.id);if(ids.has(id))throw Error('Duplicate catalog product ID');ids.add(id);
leaves.push({id,name,cost:numeric(x.cost),stock:Array(stores.length).fill(null),pointCosts:Array(stores.length).fill(null)});
}
}
return true;
}
const root={hid:null,children:[],leaves:[]};
await walk(root);
const unreadFolders=[];
for (const {node,depth} of deferredFolders) {
  if (!await walk(node,depth,false)) unreadFolders.push(node);
}
const roots=root.children;
if (unreadFolders.length && !allowIncompletePreview) {
  throw Error(`Saby did not return ${unreadFolders.length} catalog folders; publication blocked`);
}
if (unreadFolders.length) log(`Incomplete catalog preview: ${unreadFolders.length} unread folders`);
let leafFolders=[];
function gather(n){if(n.leaves.length)leafFolders.push(n);n.children.forEach(gather);}
roots.forEach(gather);
if(!ids.size)throw Error('Empty global catalog');
log(`Global catalog: ${ids.size} products; ${leafFolders.length} folders; ${stores.length} stores`);
for (const [si, store] of stores.entries()) {
  const missing = [];
  for (const n of leafFolders) {
    let results;
    try {
      results = await folder(api, {pointId:store.id,folder:n.hid,withBalance:true});
    } catch (error) {
      if (!(error.status >= 500)) throw error;
      log(`Stock ${store.name}, ${n.name}: HTTP ${error.status}; checking items by warehouse`);
      results = [];
    }
    const mapped = new Map(results.filter(x => !x.isParent).map(x => [key(x.id),x]));
    for (const leaf of n.leaves) {
      const row = mapped.get(leaf.id);
      leaf.stock[si] = numeric(row?.balance);
      leaf.pointCosts[si] = numeric(row?.cost);
      if (leaf.stock[si] === null) missing.push(leaf);
    }
  }
  await fillWarehouseBalances(api, store, missing, si, log);
  const unresolved = missing.filter(leaf => leaf.stock[si] === null).length;
  const negatives = leafFolders.reduce((count, folder) => count + folder.leaves.filter(leaf => leaf.stock[si] < 0).length, 0);
  log(`Stock ${store.name}: warehouse resolved=${missing.length-unresolved}; unknown=${unresolved}; negative=${negatives}; requests=${api.count()}`);
}
const categories=[];let total=0;
for(const root of roots.slice().sort(byName)){
const items=[];
function collect(n){
if(n.leaves.length){
const leaves=n.leaves.slice().sort(byName);
const prices=leaves.map(l=>{const preferred=l.pointCosts[0];if(preferred>0)return preferred;if(l.cost>0)return l.cost;const candidates=l.pointCosts.filter(c=>c>0);return candidates.length?Math.min(...candidates):null;});
if(prices.some(p=>p===null))throw Error('Missing valid prices in '+n.name);
const flavors = leaves.map(leaf => ({
  name: clean(leaf.name,n.name),
  stores: leaf.stock.flatMap((value,index) => value > 0 ? [index] : []),
  stockStatus: leaf.stock.map(value => value === null ? 'missing' : value < 0 ? 'negative' : value === 0 ? 'zero' : 'available'),
}));
items.push({name:n.name,meta:'',price:Math.min(...prices),color:colorFor(n.name),flavors});total+=flavors.length;
}
n.children.slice().sort(byName).forEach(collect);
}
collect(root);if(items.length)categories.push({name:root.name,items});
}
const oldCount=prev.categories.reduce((a,c)=>a+c.items.reduce((b,it)=>b+it.flavors.length,0),0);
if(!unreadFolders.length&&total<oldCount)throw Error(`Catalog shrank from ${oldCount} to ${total}; manual review required`);
const newCats=new Set(categories.map(c=>normalize(c.name)));
if(!unreadFolders.length&&prev.categories.some(c=>!EXCLUDE_ROOTS.includes(normalize(c.name))&&!newCats.has(normalize(c.name))))throw Error('Previously published category missing; manual review required');
log(`Result: ${categories.length} categories; ${total} positions; old positions=${oldCount}; requests=${api.count()}`);
return {
  stores:stores.map(s=>s.name),
  categories,
  ...(unreadFolders.length ? {unreadFolders:unreadFolders.map(({hid,name})=>({id:hid,name}))} : {}),
};
}
async function main(){
const started=Date.now();const prev=JSON.parse(fs.readFileSync('data.json','utf8'));
if(!Array.isArray(prev.categories)||!Array.isArray(prev.stores))throw Error('Unexpected current data.json format');
const api=client(process.env);
const previewPath=process.argv[2];
const content=await sync(api,prev,console.log,{allowIncompletePreview:Boolean(previewPath)});
if (previewPath) {
  if (require('node:path').resolve(previewPath) === require('node:path').resolve('data.json')) {
    throw Error('Preview must use a separate output path');
  }
  fs.writeFileSync(previewPath,JSON.stringify({updated:new Date().toISOString(),...content}));
  console.log(`Preview written; unread folders=${content.unreadFolders?.length ?? 0}; requests=${api.count()}`);
  return;
}
if(JSON.stringify(content)===JSON.stringify({stores:prev.stores,categories:prev.categories}))console.log('No changes.');
else {const tmp='data.json.saby.tmp';fs.writeFileSync(tmp,JSON.stringify({updated:new Date().toISOString(),...content}));fs.renameSync(tmp,'data.json');console.log('Candidate data.json generated locally.');}
console.log(`Completed in ${Math.round((Date.now()-started)/1000)} s; requests=${api.count()}`);
}
if(require.main===module)main().catch(e=>{console.error('Sync stopped: '+e.message);process.exitCode=1;});
module.exports={sync,client,paged,STORE_ORDER};
