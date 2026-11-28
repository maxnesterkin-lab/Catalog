'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {client, WAREHOUSES, STORE_ORDER, fillWarehouseBalances} = require('./update-script');
const status = v => v == null ? 'missing' : v < 0 ? 'negative' : v === 0 ? 'zero' : 'available';
function collect(prev) {
  if (!Array.isArray(prev.categories) || JSON.stringify(prev.stores)!==JSON.stringify(STORE_ORDER)) throw Error('Unexpected catalog/store order');
  const ids=new Map();
  for(const category of prev.categories) for(const group of category.items) for(const item of group.flavors) {
    if(item.id==null || !String(item.id).trim() || ids.has(String(item.id))) throw Error('Missing or duplicate product ID');
    if(!Array.isArray(item.stockStatus)||item.stockStatus.length!==STORE_ORDER.length) throw Error('Invalid prior stock status: '+item.id);
    ids.set(String(item.id),item);
  }
  if(!ids.size)throw Error('Empty catalog');
  return ids;
}
async function benchmark(api,prev,batchSize=100,log=console.log) {
  if(![50,100,200].includes(batchSize))throw Error('Batch size must be 50, 100 or 200');
  const ids=collect(prev);
  const leaves=[...ids.keys()].map(id=>({id,stock:Array(STORE_ORDER.length).fill(null)}));
  const stats=[];
  await api.login();
  for(const [si,name] of STORE_ORDER.entries()) {
    const store={name,...WAREHOUSES.get(name)};
    const t=Date.now(), before=api.count();
    // Cross-check a small deterministic sample of both previously stocked and other IDs
    // using the proven 50-ID batch size before the full sweep.
    const available=leaves.filter(l=>ids.get(l.id).stockStatus[si]==='available');
    const others=leaves.filter(l=>ids.get(l.id).stockStatus[si]!=='available');
    const sample=[...available.slice(0,25),...others.slice(0,25)].map(l=>({id:l.id,stock:Array(STORE_ORDER.length).fill(null)}));
    await fillWarehouseBalances(api,store,sample,si,log,false,50);
    await fillWarehouseBalances(api,store,leaves,si,log,false,batchSize);
    const sampled=new Map(sample.map(l=>[l.id,l.stock[si]]));
    const differences=leaves.filter(l=>sampled.has(l.id)&&status(sampled.get(l.id))!==status(l.stock[si])).length;
    const unknown=leaves.filter(l=>l.stock[si]===null).length;
    const positive=leaves.filter(l=>l.stock[si]>0).length;
    const negative=leaves.filter(l=>l.stock[si]<0).length;
    const changed=leaves.filter(l=>status(l.stock[si])!==ids.get(l.id).stockStatus[si]).length;
    const report={store:name,batchSize,seconds:Math.round((Date.now()-t)/1000),requests:api.count()-before,positive,negative,unknown,changed,sampled:sample.length,sampleDifferences:differences};
    stats.push(report);log('Fast stock: '+JSON.stringify(report));
    if(unknown)throw Error('Unconfirmed balances in '+name+'; benchmark stopped');
    if(!positive&&available.length)throw Error('Previously stocked warehouse now entirely empty: '+name);
    if(differences)throw Error('Sample comparison differs in '+name+'; check for live changes or response truncation');
  }
  const byId=new Map(leaves.map(l=>[l.id,l.stock]));
  const candidate={...prev,categories:prev.categories.map(c=>({...c,items:c.items.map(g=>({...g,flavors:g.flavors.map(item=>{
    const balances=byId.get(String(item.id));
    const {negativeBalances:oldNegatives,...rest}=item;
    const negatives=Object.fromEntries(balances.flatMap((v,i)=>v<0?[[i,v]]:[]));
    return {...rest,stores:balances.flatMap((v,i)=>v>0?[i]:[]),stockStatus:balances.map(status),...(Object.keys(negatives).length?{negativeBalances:negatives}:{})};
  })}))}))};
  return {candidate,stats};
}
async function main(){
  const output=process.argv[2];
  if(!output||path.resolve(output)===path.resolve('data.json'))throw Error('A separate preview path is required');
  const size=Number(process.argv[3]||100),start=Date.now();
  const api=client(process.env);
  const prev=JSON.parse(fs.readFileSync('data.json','utf8'));
  const {candidate,stats}=await benchmark(api,prev,size);
  // Keep the original overall update timestamp: prices and names were not queried.
  const report={batchSize:size,positions:collect(prev).size,requests:api.count(),seconds:Math.round((Date.now()-start)/1000),stores:stats};
  fs.writeFileSync(output,JSON.stringify({...candidate,stockUpdated:new Date().toISOString()}));
  fs.writeFileSync(output+'.report.json',JSON.stringify(report,null,2));
  console.log('Fast stock result: '+JSON.stringify(report));
}
if(require.main===module)main().catch(e=>{console.error('Fast stock stopped: '+e.message);process.exitCode=1;});
module.exports={benchmark,collect};
