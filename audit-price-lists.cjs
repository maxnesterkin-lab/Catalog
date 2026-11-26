'use strict';
const {client,STORE_ORDER}=require('./update-script');
const fs=require('fs');
const api=client(process.env);
const ids=[14401,433,14406,14179,16974,14412,446,409,11101,452,18093];
const target=new Set(['11322','10569']);
const actualDate=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow'}).format(new Date());
async function read(path,params,fields){
 const out=[];
 for(let page=0;page<30;page++){
  const d=await api.get(path,{...params,page,pageSize:100});
  const field=fields.find(k=>d[k]!=null);
  const v=Array.isArray(d)?d:d[field];
  if(!v||typeof v!=='object')throw Error('Missing result field');
  const rows=Array.isArray(v)?v:v.id!=null?[v]:Object.values(v);
  out.push(...rows);
  if(d.outcome?.hasMore===false||(!d.outcome&&rows.length<100))return out;
  if(d.outcome?.hasMore!==true||!rows.length)throw Error('Incomplete pagination');
 }
 throw Error('Page limit');
}
(async()=>{await api.login();const stores=[];
 for(const [i,pointId] of ids.entries()){
  const s={store:STORE_ORDER[i],lists:[],catalog:[]};stores.push(s);
  try {const p=await read('v2/nomenclature/list',{pointId,folder:11324,withBalance:false},['nomenclatures']);
    s.catalog=p.filter(x=>target.has(String(x.id))).map(x=>[x.id,x.cost]);}catch(e){s.catalogError=e.message}
  try {
   const lists=await read('nomenclature/price-list',{pointId,actualDate},['priceLists','priceList','prices','items','data','result']);
   for(const {id,name} of lists){
    const list={id,name,items:[]};s.lists.push(list);
    const p=await read('v2/nomenclature/list',{pointId,priceListId:id,searchString:'Pasito 3',withBalance:false},['nomenclatures']);
    list.items=p.filter(x=>target.has(String(x.id))).map(x=>[x.id,x.cost]);
   }
  } catch(e){s.listError=e.message}
 }fs.writeFileSync('price-lists.json',JSON.stringify({actualDate,stores}));console.log('Pasito and active price lists checked for '+stores.length+' stores.');
})().catch(e=>{console.error(e.message);process.exitCode=1});