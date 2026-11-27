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
const {excludedFolder, planAssortment, appendNewVariants} = require('./catalog-assortment');
const normalize = x => String(x ?? '').trim().toLowerCase().replace(/ё/g,'е').replace(/^(sv|si)\s+/,'');
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const numeric = v => {
  if (typeof v !== 'number' && (typeof v !== 'string' || !v.trim())) return null;
  const number = Number(v);
  return Number.isFinite(number) ? number : null;
};
const key = v => {if (v==null || String(v).trim()==='') throw Error('Missing Saby ID'); return String(v);};
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
class PaginationError extends Error {}

function canRetryFolder(error) {
  return error.status >= 500 || error instanceof PaginationError;
}

async function paged(api,params,size){
const all=[];const seen=new Set();
for(let page=0;page<3000;page++){
const d=await api.get('v2/nomenclature/list',{...params,pageSize:size,page});
const part=rows(d,'nomenclatures');
for(const x of part){const k=(x.isParent?'F:':'P:')+key(x.isParent?(x.hierarchicalId??x.id):x.id);if(seen.has(k)) throw new PaginationError('Duplicate row during pagination at page '+page+' (pageSize '+size+')');seen.add(k);all.push(x);}
if(d?.outcome?.hasMore===false) return all;
if(d?.outcome?.hasMore!==true||!part.length) throw new PaginationError('Uncertain pagination at page '+page+' (pageSize '+size+')');
}
throw Error('Page budget exceeded');
}
async function folder(api, params){
let err;
for(const size of [100,30,10,3,1]){
try{return await paged(api,params,size);}catch(e){err=e;if(!canRetryFolder(e))throw e;}
}
throw err;
}
async function fillWarehouseBalances(api, store, missing, storeIndex, log, allowIncompletePreview) {
  async function queryBatch(leaves) {
    const batch = new Map(leaves.map(leaf => [leaf.id, leaf]));
    const params = {
      nomenclatures: [...batch.keys()],
      warehouses: [store.warehouseId],
      companies: [store.companyId],
    };
    let response;
    try {
      try {
        response = await api.get('nomenclature/balances', params);
      } catch (error) {
        if (error.status !== 400 && error.status !== 422) throw error;
        const jsonParams = Object.fromEntries(
          Object.entries(params).map(([name, values]) => [name, JSON.stringify(values)]),
        );
        response = await api.get('nomenclature/balances', jsonParams);
      }
    } catch (error) {
      if (error.status >= 500 && leaves.length > 1) {
        const middle = Math.ceil(leaves.length / 2);
        log(`Warehouse ${store.name}: HTTP ${error.status}; splitting batch of ${leaves.length}`);
        await queryBatch(leaves.slice(0, middle));
        await queryBatch(leaves.slice(middle));
      } else {
        if (!allowIncompletePreview) throw error;
        log(`Warehouse ${store.name}: ${error.message}; ${leaves.length} balances remain unconfirmed`);
      }
      return;
    }

    if (response?.outcome?.hasMore !== undefined && response.outcome.hasMore !== false) {
      throw Error('Incomplete warehouse balance response for '+store.name);
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
    // Only infer zero for requested IDs omitted from a successfully validated warehouse response.
    for (const [id, leaf] of batch) {
      if (!seen.has(id) && leaf.stock[storeIndex] === null) leaf.stock[storeIndex] = 0;
    }
  }

  for (let start = 0; start < missing.length; start += 50) {
    await queryBatch(missing.slice(start, start + 50));
  }
}

async function sync(api,prev,log=console.log,{allowIncompletePreview=false}={}){
await api.login();
const points=rows(await api.get('point/list',{product:'retail',page:0,pageSize:100}),'salesPoints');
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
  if (parent === null || !canRetryFolder(error)) throw error;
  log(`Catalog folder ${node.name} (ID ${parent}): ${error.message}${defer ? '; retry deferred' : '; still unread'}`);
  if (defer) deferredFolders.push({node,depth});
  return false;
}
const {children,leaves}=node;
for(const x of arr){
const name=String(x.name??'').trim(); if(!name) throw Error('Unnamed catalog row');
if(x.isParent){
if(excludedFolder(name, parent===null))continue;
const hid=key(x.hierarchicalId??x.id);if(nodes.has(hid))throw Error('Duplicate catalog folder');nodes.add(hid);
const child={name,hid,department:node.department || name,children:[],leaves:[]};
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
if (unreadFolders.length) log(`Catalog discovery: ${unreadFolders.length} unread folders; existing IDs will still be checked by warehouse`);
let leafFolders=[];
function gather(n){if(n.leaves.length)leafFolders.push(n);n.children.forEach(gather);}
roots.forEach(gather);
if(!ids.size)throw Error('Empty global catalog');
log(`Global catalog: ${ids.size} products; ${leafFolders.length} folders; ${stores.length} stores`);
if (JSON.stringify(prev.stores) !== JSON.stringify(stores.map(s => s.name))) throw Error('Store order changed');
const workingCategories = structuredClone(prev.categories);
const additions = planAssortment(workingCategories, leafFolders);
leafFolders = leafFolders.filter(folder => folder.leaves.length);
const byId = new Map(leafFolders.flatMap(folder => folder.leaves.map(leaf => [leaf.id, leaf])));
const warehouseOnly = [];
for (const category of workingCategories) {
  for (const group of category.items) {
    for (const variant of group.flavors) {
      const id = key(variant.id);
      if (byId.has(id)) continue;
      const leaf = {id, cost:null, stock:Array(stores.length).fill(null), pointCosts:Array(stores.length).fill(null)};
      warehouseOnly.push(leaf);
      byId.set(id, leaf);
    }
  }
}
for (const [si, store] of stores.entries()) {
  const missing = [...warehouseOnly];
  for (const n of leafFolders) {
    let results;
    try {
      results = await paged(api, {pointId:store.id,folder:n.hid,withBalance:true}, 100);
    } catch (error) {
      if (!canRetryFolder(error)) throw error;
      log(`Stock ${store.name}, ${n.name}: ${error.message}; checking items by warehouse`);
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
  await fillWarehouseBalances(api, store, missing, si, log, allowIncompletePreview);
  const unresolved = missing.filter(leaf => leaf.stock[si] === null).length;
  const negatives = leafFolders.reduce((count, folder) => count + folder.leaves.filter(leaf => leaf.stock[si] < 0).length, 0);
  log(`Stock ${store.name}: warehouse resolved=${missing.length-unresolved}; unknown=${unresolved}; negative=${negatives}; requests=${api.count()}`);
}
appendNewVariants(additions, log);
const priceDate = new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow'}).format(new Date());
const categories = workingCategories.map(category => ({
  ...category,
  items: category.items.map(group => {
    const flavors = group.flavors.map(previous => {
      const leaf = byId.get(key(previous.id));
      const price = leaf.cost;
      const storePrices = {...previous.storePrices};
      leaf.pointCosts.forEach((value, index) => {
        if (value > 0) storePrices[index] = {price:value, date:priceDate};
      });
      const {negativeBalances: oldNegatives, ...item} = previous;
      const negatives = Object.fromEntries(leaf.stock.flatMap((value, i) => value < 0 ? [[i, value]] : []));
      return {
        ...item,
        storePrices,
        ...(price ? {price, priceStatus:'confirmed'} : {}),
        stores: leaf.stock.flatMap((value, i) => value > 0 ? [i] : []),
        stockStatus: leaf.stock.map(value => value === null ? 'missing' : value < 0 ? 'negative' : value === 0 ? 'zero' : 'available'),
        ...(Object.keys(negatives).length ? {negativeBalances: negatives} : {}),
      };
    });
    const prices = flavors.map(f => f.price).filter(value => value > 0);
    return {...group, flavors, ...(prices.length ? {
      price: Math.min(...prices), minKnownPrice: Math.min(...prices), maxKnownPrice: Math.max(...prices),
    } : {})};
  }),
}));
const total = categories.reduce((sum, cat) => sum + cat.items.reduce((n, group) => n + group.flavors.length, 0), 0);
log(`Result: ${categories.length} categories; ${total} positions; requests=${api.count()}`);
return {stores: stores.map(s=>s.name), categories, ...(allowIncompletePreview && unreadFolders.length ? {
  unreadFolders: unreadFolders.map(({hid,name})=>({id:hid,name})),
} : {})};
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
