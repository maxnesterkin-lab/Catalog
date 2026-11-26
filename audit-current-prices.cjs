'use strict';
const fs = require('node:fs');
const {client} = require('./update-script');
const data = JSON.parse(fs.readFileSync('data.json','utf8'));
const wanted = new Set(data.categories.flatMap(c=>c.items.flatMap(g=>g.flavors.map(f=>String(f.id)))));
const primary = 14401; // same primary point as the published catalog
const folders = ["11324","7898","7596","9279","7842","12202","7788","11596","8113","9792","726","9612","10052","9274","8132","10317","8428","12503","12646","8126","10699","8473","8117","8124","8110","10048","8121","8118","8691","10046","10050","10237","10896","10469","11595","10044","13719","10078","11837","11993","10331","10333","11565","13758","8156","10772","11564","11653","10293","14066","11835","10330","11164","11936","10914","10040","13865","13591","11694","10816","10042","13592","10332","8321","14496","11856","283","11246","14359","544","11245","549","325","326","9486","11914","7366","8084","8085","8052","10915","10708","12207","12545","12520","11657","12098","12099","11658","8732","11868","8733","335","13439","11623","339","10658","13446","13442","352","9147","9583","12386","391","9444","7028","9103","9639","14217","11652","418","421","7513","13673","7541","438","12424","8002","12303","13728","13727","12336","9453","7118","8177","461","462","8285","474","11018","14332","10534","13693","500","501","508","11215","7542","13440","284","10710","10712","10714","10716","10718","10720","10722","10724","10726","10728","10730","10732","10734","10736","9390","10738","10740","558","551","552","8907","11326","553","10246","8421","8030","10993","285","8419","735","8506","7964","9226","11243","11397","8782","9376","13412","13657","13411","13409","574","10676","7082","582","8718","12172","10101","9707","13779","7044","7237","9565","594","7088","12475","595","596","9284","7883","11387","7692","9797","7619","9936","13794","13826","13810","603","11972","11956","604","12506","8539","613","9969","8885","7901","12642","13349","621","7630","623","10755","8627","6835","9039","629","11528","9040","10987","8781","10674","640","10675","641","642","7281","8219","10876","8220","8221","10645","648","11607","13832","11348","11848","14433","13848","8641","9925","655","6834","7328","7944","659","661","9227","9300","8677","13971","13972","10244","13973","13974","13975","13976","13977","9625","7649","673","674","9415","10572","676","11453","679","10996","10571","11049","681","11296","684","7670","14186","14187","14188","9335","9336","8406","7608","7459","8665","700","8516","9312","10962","7217","708","12151","709","12130","14254","14116","12505","12504","9948","10625","11717","7157","716","11291","7158","7963","7843","10985","10213","8615","9400","12579","721","8436","11","12","13","7782","8490","10951","15","16","14","17","12097","18","19","20","8028","10991","12093","8033","8322","8325","7222","7219","21","22","23","25","24","26","27","10309","8502","8498","29","30","31","32","33","34","8817","8821","12095","12647","13374","35","36","38","10265","28","39","40","41","42","45","43","7772","44","12096","46","47","7220","9497","48","49","291","14470","14459","14010","10157","10323","13572","9760","14011","9744"];
const result = {startedAt:new Date().toISOString(), prices:{}, pointPrices:{}, defaultPrices:{}, sample:[], failedFolders:[]};
const target = new Set(['11322','10569']);
const api = client(process.env);
function rows(d,field){
  const value=d[field]; if(Array.isArray(value))return value;
  if(value&&typeof value==='object')return 'id' in value?[value]:Object.values(value);
  throw Error('Missing '+field);
}
function price(row){return ['number','string'].includes(typeof row.cost)&&Number.isFinite(Number(row.cost))&&Number(row.cost)>0?Number(row.cost):null}
async function readFolder(folder,pointId, dest, sample=false){
 const seen=new Set();
 for(let page=0;page<120;page++){
  const d=await api.get('v2/nomenclature/list',{folder,pointId,withBalance:false,page,pageSize:100});
  const part=rows(d,'nomenclatures');
  for(const row of part){
   const id=String(row.id),key=(row.isParent?'F':'P')+id;if(seen.has(key))throw Error('repeated row');seen.add(key);
   if(!row.isParent&&wanted.has(id)&&price(row)!==null){if(dest[id]!=null&&dest[id]!==price(row))throw Error('conflicting price');dest[id]=price(row)}
   if(sample&&target.has(id))result.sample.push({point:pointId??'global',id,price:price(row)});
  }
  if(d.outcome?.hasMore===false)return;
  if(d.outcome?.hasMore!==true||!part.length)throw Error('incomplete response');
 }
 throw Error('page limit');
}
async function main(){
 await api.login();
 for(const pt of [primary,null,433,14406,14179,16974,14412,446,409,11101,452,18093]){
  try{await readFolder(folders[0],pt,{},true)}catch(e){console.log('Pasito sample unavailable for point '+pt)}
 }
 console.log('Pasito 3 sample '+JSON.stringify(result.sample));
 for(const [index,folder] of folders.entries()){
  for(const [pt,field] of [[primary,'pointPrices'],[null,'defaultPrices']]){
   const pagePrices={};
   try {await readFolder(folder,pt,pagePrices);Object.assign(result[field],pagePrices)}
   catch(e){result.failedFolders.push({folder,point:pt,message:e.message})}
  }
  if((index+1)%50===0)console.log('Folders read '+(index+1)+'/'+folders.length);
 }
 result.prices={...result.defaultPrices,...result.pointPrices};
 result.finishedAt=new Date().toISOString();
 fs.writeFileSync('price-audit.json',JSON.stringify(result));
 console.log('Verified '+Object.keys(result.prices).length+' of '+wanted.size+'; folder read failures '+result.failedFolders.length);
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
