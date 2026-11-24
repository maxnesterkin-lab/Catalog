'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');
const [reportPath, outputDir] = process.argv.slice(2);
assert(reportPath && outputDir, 'Expected a completed Saby report and an output directory');
const read = name => fs.readFileSync(name, 'utf8');
const report = JSON.parse(read(reportPath));
const catalog = JSON.parse(read('data.json'));
const html = read('index.html');
const embedded = /(<script type="application\/json" id="embedded-catalog">)([\s\S]*?)(<\/script>)/;
const previous = html.match(embedded);
assert(previous && catalog.previewOnly === true, 'Expected a test catalog with embedded data');
assert.deepEqual(JSON.parse(previous[2]), catalog, 'The HTML and JSON snapshots differ');
assert(report.completed && report.allRequestsSucceeded && report.pointMappingsVerified, 'Incomplete Saby run');
assert.equal(report.snapshotDate, catalog.updated);
assert.equal(String(report.snapshotVersion), String(catalog.schemaVersion));
assert.deepEqual(report.stores.map(store => store.name), catalog.stores);

const variants = catalog.categories.flatMap(c => c.items.flatMap(group => group.flavors));
const targets = new Map();
for (const item of variants.filter(f => f.stockStatus.includes('missing'))) {
  assert(!targets.has(String(item.id)), 'Duplicate inventory ID');
  targets.set(String(item.id), item);
}
assert.equal(targets.size, report.targetCount);
let resolved = 0;
for (const [index, store] of report.stores.entries()) {
  const seen = new Set();
  assert(!(store.priceListConflicts || []).length, 'Conflicting price-list quantities');
  for (const row of store.items) {
    const id = String(row.id);
    assert(targets.has(id) && !seen.has(id), 'Unexpected or repeated ID');
    seen.add(id);
    if (row.status === 'missing') continue;
    assert(Number.isFinite(row.balance), 'Expected a numeric balance');
    assert.equal(row.status, row.balance > 0 ? 'positive' : row.balance < 0 ? 'negative' : 'zero');
    const item = targets.get(id);
    if (item.stockStatus[index] !== 'missing') continue;
    item.stockStatus[index] = row.balance > 0 ? 'available' : row.status;
    if (row.balance < 0) (item.negativeBalances ??= {})[index] = row.balance;
    if (row.balance > 0 && !item.stores.includes(index)) item.stores.push(index);
    resolved++;
  }
  assert.equal(seen.size, targets.size);
}
const remaining = variants.filter(f => f.stockStatus.includes('missing'));
const missingCells = remaining.reduce((sum, f) => sum + f.stockStatus.filter(s => s === 'missing').length, 0);
const summary = {checkedAt:report.finishedAt, variants:variants.length, variantsChecked:targets.size,
  newlyResolvedCells:resolved, remainingVariants:remaining.length, missingCells};
catalog.verification.latestReconciliation = summary;
const json = JSON.stringify(catalog);
fs.mkdirSync(outputDir,{recursive:true});
fs.writeFileSync(path.join(outputDir,'data.json'),json);
fs.writeFileSync(path.join(outputDir,'index.html'),html.replace(embedded,(_,start,data,end) => start + json.replace(/</g,'\\u003c') + end));
fs.writeFileSync(path.join(outputDir,'summary.json'),JSON.stringify(summary,null,2));
console.log(JSON.stringify(summary));
