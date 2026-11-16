// Обновление data.json из Saby Retail.
// 1) обходит весь каталог (разделы -> бренды -> вкусы) по магазину SV Баумана,
// 2) для остальных магазинов запрашивает только остатки,
// 3) записывает data.json (если данные изменились).
// Ключи берутся из секретов GitHub и в журнал не попадают.

const fs = require('fs');

const APP_ID = process.env.SABY_APP_ID;
const APP_SECRET = process.env.SABY_APP_SECRET;
const SECRET_KEY = process.env.SABY_SECRET_KEY;

const BASE = "https://api.sbis.ru/retail";
const STRUCTURE_STORE = "Баумана";                       // по нему читаем структуру каталога и цены
const STORE_ORDER = ["Баумана", "ГУМ", "Гаджиева", "КТМ", "Крупской", "Книповича", "Кольский", "Ленина", "Мир", "ПЗ", "Североморск"];
const EXCLUDE_ROOTS = ["вывод из ассортимента"];         // служебные разделы, которые не показываем
const CONCURRENCY = 5;
let PAGE_SIZE = 100;
let requests = 0;
let headers = {};

function fail(msg) {
    console.error("ОШИБКА: " + msg);
    process.exit(1);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function login() {
    const res = await fetch("https://online.sbis.ru/oauth/service/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_client_id: APP_ID, app_secret: APP_SECRET, secret_key: SECRET_KEY })
    });
    if (!res.ok) fail(`вход в Saby не удался (HTTP ${res.status})`);
    const data = await res.json();
    const token = data.token || data.access_token;
    if (!token) fail("в ответе на вход нет токена");
    headers = { "X-SBISAccessToken": token };
}

// запрос с повторами при перегрузке и повторным входом, если токен истёк
async function api(url) {
    let relogged = false;
    for (let attempt = 1; attempt <= 5; attempt++) {
        requests++;
        let res;
        try {
            res = await fetch(url, { headers });
        } catch (e) {
            await sleep(1500 * attempt);
            continue;
        }
        if (res.status === 401 && !relogged) { await login(); relogged = true; continue; }
        if (res.status === 429 || res.status >= 500) { await sleep(2000 * attempt); continue; }
        const text = await res.text();
        if (!res.ok) {
            const err = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
            err.status = res.status;
            throw err;
        }
        return JSON.parse(text);
    }
    throw new Error("запрос не удался после повторов: " + url.split("?")[0]);
}

// все записи одного раздела (с постраничной подгрузкой)
async function fetchFolder(pointId, folderId) {
    const all = [];
    for (let page = 0; page < 300; page++) {
        const url = `${BASE}/v2/nomenclature/list?pointId=${pointId}&withBalance=true&pageSize=${PAGE_SIZE}&page=${page}` +
            (folderId ? `&folder=${folderId}` : "");
        let res;
        try {
            res = await api(url);
        } catch (e) {
            if (e.status === 400 && PAGE_SIZE > 30) { PAGE_SIZE = 30; page = -1; all.length = 0; continue; }
            throw e;
        }
        const arr = res.nomenclatures || [];
        all.push(...arr);
        if (!(res.outcome && res.outcome.hasMore) || arr.length === 0) break;
    }
    return all;
}

async function pool(items, n, worker) {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
        while (i < items.length) {
            const item = items[i++];
            await worker(item);
        }
    }));
}

const collator = new Intl.Collator("ru");
const byName = (a, b) => collator.compare(a.name || "", b.name || "");
const normStore = name => String(name || "").replace(/^(SV|SI)\s+/i, "").trim().toLowerCase();

const COLORS = ["#9fd8ff", "#ffb36b", "#ff8fb1", "#b9a5ff", "#ffd23f", "#8be28b", "#7fe3d6", "#f2a0ff", "#ff7a59", "#c9e6ff"];
function colorFor(name) {
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return COLORS[h % COLORS.length];
}

// убираем название бренда из начала названия вкуса
function cleanFlavor(flavor, folderName) {
    const f = flavor.trim();
    if (f.toLowerCase().startsWith(folderName.toLowerCase())) {
        const rest = f.slice(folderName.length).replace(/^[\s\-–—:,/]+/, "").trim();
        if (rest) return rest;
    }
    return f;
}

async function main() {
    if (!APP_ID || !APP_SECRET || !SECRET_KEY) {
        fail("не заданы секреты SABY_APP_ID, SABY_APP_SECRET, SABY_SECRET_KEY");
    }
    const started = Date.now();
    await login();
    console.log("Вход выполнен.");

    // 1. Точки продаж -> нужные магазины
    const pointsResp = await api(`${BASE}/point/list?product=retail&pageSize=100`);
    const points = pointsResp.salesPoints || [];
    const stores = [];
    for (const name of STORE_ORDER) {
        const p = points.find(x => normStore(x.name) === name.toLowerCase());
        if (p) stores.push({ name, id: p.id });
        else console.log(`ПРЕДУПРЕЖДЕНИЕ: точка «${name}» не найдена в Saby, пропускаю`);
    }
    if (!stores.length) fail("ни одна нужная точка не найдена");
    console.log(`Магазинов: ${stores.length}`);

    const structStore = stores.find(s => s.name === STRUCTURE_STORE) || stores[0];

    // 2. Обход каталога по структурному магазину
    const nodes = new Map();      // hierarchicalId -> {hid,name,leaves,children}
    const roots = [];
    const balances = stores.map(() => new Map());   // индекс магазина -> (id товара -> остаток)
    const structIdx = stores.indexOf(structStore);
    let frontier = [null];
    let level = 0;
    while (frontier.length) {
        const next = [];
        await pool(frontier, CONCURRENCY, async fid => {
            const arr = await fetchFolder(structStore.id, fid);
            for (const it of arr) {
                if (it.isParent) {
                    const hid = it.hierarchicalId != null ? it.hierarchicalId : it.id;
                    const node = { hid, name: it.name || "", leaves: [], children: [] };
                    nodes.set(hid, node);
                    if (fid === null) roots.push(node); else nodes.get(fid).children.push(node);
                    next.push(hid);
                } else if (fid !== null) {
                    const bal = Number(it.balance) || 0;
                    nodes.get(fid).leaves.push({ id: it.id, name: it.name || "", cost: Number(it.cost) || 0 });
                    balances[structIdx].set(it.id, bal);
                }
            }
        });
        level++;
        console.log(`Уровень ${level}: разделов найдено ${next.length}`);
        frontier = next;
    }

    const rootsUsed = roots.filter(r => !EXCLUDE_ROOTS.includes(r.name.trim().toLowerCase()));
    console.log(`Корневых разделов: ${roots.length}, показываем: ${rootsUsed.length}`);

    // папки, внутри которых лежат товары (вкусы)
    const leafFolders = [];
    (function collect(list) {
        for (const n of list) {
            if (n.leaves.length) leafFolders.push(n);
            collect(n.children);
        }
    })(rootsUsed);
    console.log(`Папок с товарами: ${leafFolders.length}`);

    // 3. Остатки по остальным магазинам
    for (let si = 0; si < stores.length; si++) {
        if (si === structIdx) continue;
        await pool(leafFolders, CONCURRENCY, async folder => {
            const arr = await fetchFolder(stores[si].id, folder.hid);
            for (const it of arr) {
                if (!it.isParent) balances[si].set(it.id, Number(it.balance) || 0);
            }
        });
        console.log(`Остатки: ${stores[si].name} готово`);
    }

    // 4. Сборка data.json
    const categories = [];
    let totalFlavors = 0;
    for (const root of rootsUsed.slice().sort(byName)) {
        const items = [];
        (function collect(node) {
            if (node.leaves.length) {
                const leaves = node.leaves.slice().sort(byName);
                const costs = leaves.map(l => l.cost).filter(c => c > 0);
                items.push({
                    name: node.name,
                    meta: "",
                    price: costs.length ? Math.min(...costs) : 0,
                    color: colorFor(node.name),
                    flavors: leaves.map(l => ({
                        name: cleanFlavor(l.name, node.name),
                        stores: stores.map((s, si) => (balances[si].get(l.id) || 0) > 0 ? si : -1).filter(x => x >= 0)
                    }))
                });
                totalFlavors += leaves.length;
            }
            node.children.slice().sort(byName).forEach(collect);
        })(root);
        if (items.length) categories.push({ name: root.name, items });
    }
    if (!totalFlavors) fail("товары не найдены, data.json не изменён");

    const content = { stores: stores.map(s => s.name), categories };

    // пишем файл только если данные изменились
    let old = null;
    try {
        const prev = JSON.parse(fs.readFileSync("data.json", "utf-8"));
        old = JSON.stringify({ stores: prev.stores, categories: prev.categories });
    } catch (e) { /* файла нет или он пустой */ }
    if (old === JSON.stringify(content)) {
        console.log("Данные не изменились, data.json не трогаю.");
    } else {
        fs.writeFileSync("data.json", JSON.stringify({ updated: new Date().toISOString(), ...content }), "utf-8");
        console.log("data.json обновлён.");
    }
    console.log(`Категорий: ${categories.length}, позиций (вкусов): ${totalFlavors}, запросов к Saby: ${requests}, время: ${Math.round((Date.now() - started) / 1000)} с`);
}

main().catch(e => fail(String(e && e.message || e)));
