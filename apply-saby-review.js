'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const current = JSON.parse(fs.readFileSync('data.json'));
const review = JSON.parse(fs.readFileSync(process.argv[2]));
assert.deepEqual(review.stores, current.stores);
const date = new Intl.DateTimeFormat('sv-SE', {timeZone:'Europe/Moscow'}).format(new Date(review.updated));
const variants = catalog => catalog.categories.flatMap(c => c.items.flatMap(p => p.flavors));
const reviewed = new Map();
for (const f of variants(review)) {
  const id = String(f.id);
  assert(!reviewed.has(id), 'Repeated variant ID');
  assert.equal(f.storePrices.length, current.stores.length);
  assert.equal(f.stockStatus.length, current.stores.length);
  reviewed.set(id, f);
}
let prices = 0, resolved = 0, found = 0, balances = 0;
for (const group of current.categories.flatMap(c => c.items)) {
  for (const item of group.flavors) {
    const f = reviewed.get(String(item.id));
    assert(f, 'Variant missing from review: ' + item.id);
    if (Number.isFinite(f.catalogPrice) && f.catalogPrice > 0) {
      item.price = f.catalogPrice;
      item.priceStatus = 'confirmed';
    }
    for (const [i, price] of f.storePrices.entries()) {
      if (Number.isFinite(price) && price > 0) {
        item.storePrices ??= {};
        item.storePrices[i] = {price, date};
        prices++;
      }
      const status = f.stockStatus[i];
      if (status === 'missing') continue;
      assert(['available','zero','negative'].includes(status));
      const old = item.stockStatus[i];
      if ((old === 'missing' || old === 'negative') && status !== 'negative') {
        resolved++;
        if (status === 'available') {
          found++;
          console.log('Found stock:', item.id, item.name, current.stores[i]);
        }
      }
      item.stockStatus[i] = status;
      if (status === 'negative') {
        item.negativeBalances ??= {};
        item.negativeBalances[i] = f.negativeBalances[i];
      } else if (item.negativeBalances) delete item.negativeBalances[i];
      balances++;
    }
    if (item.negativeBalances && !Object.keys(item.negativeBalances).length) delete item.negativeBalances;
    if (item.negativeBalances) item.needsInventoryReview = true;
    else if (item.needsInventoryReview && !item.stockStatus.includes('missing')) delete item.needsInventoryReview;
    item.stores = item.stockStatus.flatMap((s,i) => s === 'available' ? [i] : []);
  }
  const values = group.flavors.map(f => f.price).filter(x => Number.isFinite(x) && x > 0);
  if (values.length) {
    group.minKnownPrice = group.price = Math.min(...values);
    group.maxKnownPrice = Math.max(...values);
  }
}
console.log({prices, balances, resolved, found});
assert(prices || balances, 'No confirmed store observations');
current.lastPartialReview = review.updated;
fs.writeFileSync('data.json', JSON.stringify(current));
