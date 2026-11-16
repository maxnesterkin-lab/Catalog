// Этап 1б: «разведка» по каталогу. Смотрим, какие товары и остатки отдаёт Saby
// для магазина SV Баумана (id=14401). data.json на этом этапе НЕ меняется.
// Ключи берутся из секретов GitHub и в журнал не попадают.

const APP_ID = process.env.SABY_APP_ID;
const APP_SECRET = process.env.SABY_APP_SECRET;
const SECRET_KEY = process.env.SABY_SECRET_KEY;
const POINT_ID = 14401; // SV Баумана

function fail(msg) {
    console.error("ОШИБКА: " + msg);
    process.exit(1);
}

// Запрос, который не роняет скрипт: просто печатает, что получилось
async function tryCall(label, url, headers) {
    try {
        const res = await fetch(url, { headers });
        const text = await res.text();
        console.log(`[${label}] HTTP ${res.status}`);
        if (!res.ok) {
            console.log("   " + text.slice(0, 300));
            return null;
        }
        return JSON.parse(text);
    } catch (e) {
        console.log(`[${label}] сбой: ${e}`);
        return null;
    }
}

function firstArray(obj) {
    if (Array.isArray(obj)) return obj;
    for (const k of Object.keys(obj || {})) {
        if (Array.isArray(obj[k])) return obj[k];
    }
    return [];
}

function show(label, obj, n) {
    if (!obj) return;
    console.log(`--- ${label}: ключи ответа: ${Object.keys(obj).join(", ")}`);
    const arr = firstArray(obj);
    console.log(`--- ${label}: записей: ${arr.length}`);
    if (arr[0]) console.log(`--- ${label}: поля первой записи: ${Object.keys(arr[0]).join(", ")}`);
    arr.slice(0, n).forEach((x, i) => console.log(`#${i + 1} ` + JSON.stringify(x).slice(0, 900)));
    if (obj.outcome) console.log(`--- ${label}: outcome: ${JSON.stringify(obj.outcome)}`);
}

async function main() {
    if (!APP_ID || !APP_SECRET || !SECRET_KEY) {
        fail("не заданы секреты SABY_APP_ID, SABY_APP_SECRET, SABY_SECRET_KEY");
    }

    const authRes = await fetch("https://online.sbis.ru/oauth/service/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_client_id: APP_ID, app_secret: APP_SECRET, secret_key: SECRET_KEY })
    });
    const auth = await authRes.json();
    const token = auth.token || auth.access_token;
    if (!token) fail("нет токена в ответе на вход");
    console.log("Вход выполнен.");
    const headers = { "X-SBISAccessToken": token };
    const base = "https://api.sbis.ru/retail";

    const iso = new Date().toISOString().slice(0, 10);
    const [y, m, d] = iso.split("-");
    const ru = `${d}.${m}.${y}`;

    // 1. Прайс-листы: пробуем оба формата даты
    const p1 = await tryCall("Прайс (ГГГГ-ММ-ДД)", `${base}/nomenclature/price-list?pointId=${POINT_ID}&actualDate=${iso}&pageSize=50`, headers);
    show("Прайс (ГГГГ-ММ-ДД)", p1, 5);
    const p2 = await tryCall("Прайс (ДД.ММ.ГГГГ)", `${base}/nomenclature/price-list?pointId=${POINT_ID}&actualDate=${ru}&pageSize=50`, headers);
    show("Прайс (ДД.ММ.ГГГГ)", p2, 5);

    // 2. Товары из каталога (без прайс-листа) с остатками: версии v2 и v1
    const c2 = await tryCall("Каталог v2", `${base}/v2/nomenclature/list?pointId=${POINT_ID}&withBalance=true&pageSize=30&page=0`, headers);
    show("Каталог v2", c2, 8);
    const c1 = await tryCall("Каталог v1", `${base}/nomenclature/list?pointId=${POINT_ID}&withBalance=true&pageSize=30&page=0`, headers);
    show("Каталог v1", c1, 8);

    // 3. Если нашёлся прайс-лист, берём товары по нему
    const prices = firstArray(p1).length ? firstArray(p1) : firstArray(p2);
    if (prices[0] && prices[0].id) {
        const pl = await tryCall("Товары по прайсу", `${base}/v2/nomenclature/list?pointId=${POINT_ID}&priceListId=${prices[0].id}&withBalance=true&pageSize=30&page=0`, headers);
        show("Товары по прайсу", pl, 8);
    }

    console.log("Разведка завершена. data.json не изменён.");
}

main().catch(e => fail(String(e)));
