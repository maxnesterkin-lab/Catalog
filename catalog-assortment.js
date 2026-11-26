'use strict';

// Keep the catalog's existing public departments and their editorial grouping.
const excludedIds = new Set(['13756', '3805', '14326', '14306']);
const excludedDepartments = new Set([
  'вывод из ассортимента', 'зажигалки', 'курительные принадлежности', 'прочее',
  'энергетические напитки', 'системы нагревания табака', 'табачные изделия', 'служебный раздел',
]);
const norm = value => value.toLowerCase().replace(/ё/g, 'е').trim();
function excludedFolder(name, isRoot) {
  const value = norm(name);
  return value.includes('орликов') || value === 'сигареты' ||
    value.includes('вывод из ассортимента') || (isRoot && excludedDepartments.has(value));
}
const tokens = value => norm(value).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function includesWords(text, name) {
  return (' ' + text + ' ').includes(' ' + tokens(name) + ' ');
}

function deviceGroup(category, folder, leaf) {
  const words = tokens(leaf.name + ' ' + folder.name);
  for (const group of category.items) {
    const [brand, series] = group.name.split(' — ');
    if (series && brand.split(' / ').some(b => includesWords(words, b)) && includesWords(words, series)) {
      return group;
    }
  }
  return null;
}

function planAssortment(categories, folders) {
  const byId = new Map();
  const locations = new Map();
  for (const category of categories) {
    for (const group of category.items) {
      const destination = {category, group};
      if (group.folderId != null) {
        const key = String(group.folderId);
        if (!locations.has(key)) locations.set(key, []);
        locations.get(key).push(destination);
      }
      for (const variant of group.flavors) {
        const id = String(variant.id);
        if (byId.has(id)) throw Error('Duplicate published product ID: ' + id);
        byId.set(id, destination);
      }
    }
  }

  const additions = [];
  for (const folder of folders) {
    const peers = folder.leaves.map(f => byId.get(f.id)).filter(Boolean);
    const locationsHere = [...peers, ...(locations.get(folder.hid) || [])];
    const departments = new Set(locationsHere.map(p => p.category));
    const sourceCategory = categories.find(c => norm(c.name) === norm(folder.department));
    const defaultCategory = departments.size === 1 ? [...departments][0] : sourceCategory;
    folder.leaves = folder.leaves.filter(leaf => {
      if (byId.has(leaf.id)) return true;
      let category = defaultCategory;
      const isPart = /^(?:картридж|испарител)/i.test(leaf.name);
      if (category?.name === 'Системы и устройства' && isPart) {
        category = categories.find(c => c.name === 'Комплектующие для систем');
      }
      if (!category || excludedIds.has(leaf.id) || /орликов|бустер.*щ[её]лоч/i.test(leaf.name)) return false;
      const options = [...new Set(locationsHere.filter(p => p.category === category).map(p => p.group))];
      let group;
      if (category.name === 'Системы и устройства') {
        group = deviceGroup(category, folder, leaf);
        if (!group && options.length === 1) group = options[0];
      } else {
        group = options.find(p => norm(p.name) === norm(folder.name));
        if (!group && options.length === 1) group = options[0];
      }
      // A split source folder can contain several public groups. Prefer
      // names carried by the SKU, e.g. ICEBURN and VOLT POWER.
      if (options.length > 1 && category.name !== 'Системы и устройства') {
        const words = tokens(leaf.name);
        const matches = options.filter(p => p.name.split(/\s+\/\s+|\s+—\s+/).some(part =>
          includesWords(words, part.replace(/^Табак жевательный\s+/i, ''))));
        if (matches.length === 1) group = matches[0];
      }
      if (category.name === 'Комплектующие для систем' && /plonq/i.test(leaf.name) &&
          /meta/i.test(leaf.name) && isPart) {
        group = category.items.find(p => p.name === 'Картриджи PLONQ Meta') || group;
      }
      let groupName = folder.name;
      if (!group && category.name === 'Системы и устройства') {
        const words = tokens(folder.name + ' ' + leaf.name);
        const brands = category.items.map(p => p.name.split(' — ')[0]);
        const brand = brands.find(b => b.split(' / ').some(name => includesWords(words, name)));
        groupName = (brand || 'Другие производители') + ' — ' + folder.name;
      }
      additions.push({category, group, groupName, folder, leaf});
      return true;
    });
  }
  return additions;
}

function appendNewVariants(additions, log) {
  let count = 0, deferred = 0;
  for (const {category, group, groupName, folder, leaf} of additions) {
    const isLoop = /loop energy/i.test(group?.name || groupName);
    const price = [leaf.pointCosts[0], leaf.cost, ...leaf.pointCosts].find(v => v > 0);
    if (!price && !isLoop) { deferred++; continue; }
    let target = group || category.items.find(p => p.name === groupName);
    if (!target) {
      target = {folderId:folder.hid, name:groupName, meta:'', color:category.items[0]?.color || '#9fd8ff', flavors:[]};
      category.items.push(target);
    }
    // Keep the source name for new models and SKUs. It identifies the model
    // even if the public group combines multiple source folders.
    target.flavors.push({id:leaf.id, name:leaf.name, price:price || 480, priceStatus:price ? 'confirmed' : 'manual_fallback'});
    count++;
  }
  log(`New positions: added=${count}; awaiting price=${deferred}`);
}

module.exports = {excludedFolder, planAssortment, appendNewVariants};
