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
const CONCURRENCY = 2;                                   // меньше параллельных запросов, чтобы Saby не перегружать
const PAUSE_MS = 150;                                    // пауза после каждого запроса
let lastError = "";
const PAGE_SIZE = 30;
const folderSize = new Map();                            // разделам, которые не читаются обычным запросом, запоминаем рабочий размер страницы
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
            lastError = "сеть: " + ((e.cause && e.cause.code) || e.message);
            await sleep(1500 * attempt);
            continue;
        }
        if (res.status === 401 && !relogged) { await login(); relogged = true; continue; }
        if (res.status === 429) {
            lastError = "HTTP 429 слишком частые запросы";
            const retryAfter = Number(res.headers.get("retry-after")) || 0;
            await sleep(Math.max(retryAfter * 1000, 2000 * attempt));
            continue;
        }
        if (res.status >= 500) {
            const body = (await res.text()).slice(0, 200);
            lastError = `HTTP ${res.status} ${body}`;
            if (attempt < 2) { await sleep(1000); continue; }
            const err = new Error(lastError);
            err.status = res.status;
            throw err;
        }
        const text = await res.text();
        if (!res.ok) {
            const err = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
            err.status = res.status;
            throw err;
        }
        return JSON.parse(text);
    }
    throw new Error(lastError || "запрос не удался");
}

function listUrl(pointId, folderId, size, page, withBalance = true) {
    return `${BASE}/v2/nomenclature/list?pointId=${pointId}&withBalance=${withBalance}&pageSize=${size}&page=${page}` +
        (folderId ? `&folder=${folderId}` : "");
}

// чтение раздела постранично; при tolerant=true позиции, на которых Saby падает, пропускаются
async function fetchPaged(pointId, folderId, size, tolerant, name) {
    const all = [];
    let misses = 0;
    for (let page = 0; page < 3000; page++) {
        let res;
        try {
            res = await api(listUrl(pointId, folderId, size, page));
            misses = 0;
        } catch (e) {
            if (!tolerant) throw e;
            misses++;
            let nm = "?";
            try {
                const r2 = await api(listUrl(pointId, folderId, size, page, false));
                nm = (r2.nomenclatures || []).map(x => x.name).join("; ");
            } catch (_) { /* название узнать не удалось */ }
            console.log(`ПРЕДУПРЕЖДЕНИЕ: раздел «${name}», позиция пропущена (Saby не отдаёт остаток): ${nm}`);
            if (misses >= 5) throw e;
            continue;
        }
        const arr = res.nomenclatures || [];
        all.push(...arr);
        if (!(res.outcome && res.outcome.hasMore) || arr.length === 0) break;
    }
    return all;
}

// все записи одного раздела: сначала обычный запрос, при ошибке Saby пробуем страницы поменьше
async function fetchFolder(pointId, folderId, name) {
    const key = folderId || 0;
    const hint = folderSize.get(key);
    const sizes = hint ? [hint] : [PAGE_SIZE, 10, 3, 1];
    let lastErr;
    for (const size of sizes) {
        try {
            const arr = await fetchPaged(pointId, folderId, size, size === 1, name);
            if (!hint && size !== PAGE_SIZE) {
                folderSize.set(key, size);
                console.log(`Раздел «${name}»: помог размер страницы ${size}`);
            }
            return arr;
        } catch (e) {
            lastErr = e;
            if (e.status && e.status < 500 && e.status !== 429) throw e;
        }
    }
    throw lastErr;
}

async function pool(items, n, worker) {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
        while (i < items.length) {
            const item = items[i++];
            await worker(item);
            await sleep(PAUSE_MS);
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
    const walkFailures = [];
    let frontier = [null];
    let level = 0;
    while (frontier.length) {
        const next = [];
        await pool(frontier, CONCURRENCY, async fid => {
            let arr;
            try {
                arr = await fetchFolder(structStore.id, fid, fid === null ? "корень" : nodes.get(fid).name);
            } catch (e) {
                const nm = fid === null ? "корень" : nodes.get(fid).name;
                walkFailures.push(nm);
                console.log(`ПРЕДУПРЕЖДЕНИЕ: не удалось прочитать раздел «${nm}»: ${e.message}`);
                return;
            }
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

    if (walkFailures.length > Math.max(3, nodes.size * 0.05)) {
        fail(`слишком много разделов не прочитано (${walkFailures.length}), data.json не изменён`);
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
        let failed = [];
        const load = async folder => {
            const arr = await fetchFolder(stores[si].id, folder.hid, folder.name);
            for (const it of arr) {
                if (!it.isParent) balances[si].set(it.id, Number(it.balance) || 0);
            }
        };
        await pool(leafFolders, CONCURRENCY, async folder => {
            try { await load(folder); } catch (e) { failed.push(folder); }
        });
        if (failed.length) {
            console.log(`Остатки ${stores[si].name}: повтор для ${failed.length} разделов`);
            await sleep(5000);
            const still = [];
            for (const folder of failed) {
                try { await load(folder); } catch (e) { still.push(folder.name + ": " + e.message); }
                await sleep(PAUSE_MS);
            }
            if (still.length) fail(`остатки ${stores[si].name} получены не полностью (${still.length} разделов), data.json не изменён. Пример: ${still[0]}`);
        }
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
