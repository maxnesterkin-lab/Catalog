// Этап 1: «разведка». Скрипт входит в Saby, смотрит точки продаж, прайс-лист
// и товары с остатками и ПЕЧАТАЕТ образец в журнал GitHub Actions.
// data.json на этом этапе НЕ меняется.
// Ключи берутся из секретов GitHub, в журнал они не попадают.

const APP_ID = process.env.SABY_APP_ID;
const APP_SECRET = process.env.SABY_APP_SECRET;
const SECRET_KEY = process.env.SABY_SECRET_KEY;

function fail(msg) {
    console.error("ОШИБКА: " + msg);
    process.exit(1);
}

async function call(label, url, options) {
    const res = await fetch(url, options);
    const text = await res.text();
    console.log(`[${label}] HTTP ${res.status}`);
    if (!res.ok) {
        console.log(text.slice(0, 400));
        fail(`${label}: запрос не удался`);
    }
    try {
        return JSON.parse(text);
    } catch (e) {
        console.log(text.slice(0, 400));
        fail(`${label}: ответ не JSON`);
    }
}

function firstArray(obj) {
    // ищем в ответе первый массив объектов (названия полей уточним по журналу)
    if (Array.isArray(obj)) return obj;
    for (const k of Object.keys(obj || {})) {
        if (Array.isArray(obj[k])) return obj[k];
    }
    return [];
}

function show(label, obj, n) {
    console.log(`--- ${label}: ключи ответа: ${Object.keys(obj || {}).join(", ")}`);
    const arr = firstArray(obj);
    console.log(`--- ${label}: записей в первом списке: ${arr.length}`);
    arr.slice(0, n).forEach((x, i) => console.log(`#${i + 1} ` + JSON.stringify(x).slice(0, 700)));
}

async function main() {
    if (!APP_ID || !APP_SECRET || !SECRET_KEY) {
        fail("не заданы секреты SABY_APP_ID, SABY_APP_SECRET, SABY_SECRET_KEY");
    }

    // 1. Вход
    const auth = await call("Вход", "https://online.sbis.ru/oauth/service/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_client_id: APP_ID, app_secret: APP_SECRET, secret_key: SECRET_KEY })
    });
    const token = auth.token || auth.access_token;
    if (!token) fail("в ответе на вход нет токена. Ключи в ответе: " + Object.keys(auth).join(", "));
    console.log("Токен получен.");
    const headers = { "X-SBISAccessToken": token };

    // 2. Точки продаж
    const pointsResp = await call("Точки продаж",
        "https://api.sbis.ru/retail/point/list?product=retail&withPrices=true&pageSize=100", { headers });
    const points = pointsResp.salesPoints || firstArray(pointsResp);
    console.log(`Найдено точек продаж: ${points.length}`);
    points.forEach(p => console.log(`  id=${p.id} | ${p.name || ""} | ${p.address || ""} | прайс по умолчанию: ${p.defaultPriceList}`));
    if (!points.length) fail("список точек пуст");

    // 3. Прайс-лист первой точки
    const point = points[0];
    const today = new Date().toISOString().slice(0, 10);
    const priceResp = await call("Прайс-лист",
        `https://api.sbis.ru/retail/nomenclature/price-list?pointId=${point.id}&actualDate=${today}&pageSize=50`, { headers });
    show("Прайс-листы", priceResp, 5);
    const prices = firstArray(priceResp);
    const priceListId = (prices[0] && prices[0].id) || point.defaultPriceList;
    console.log(`Беру прайс-лист: ${priceListId}`);

    // 4. Товары с остатками первой точки
    const listResp = await call("Товары",
        `https://api.sbis.ru/retail/nomenclature/list?pointId=${point.id}&priceListId=${priceListId}&withBalance=true&pageSize=30&page=0`, { headers });
    show("Товары", listResp, 8);

    console.log("Разведка завершена. data.json не изменён.");
}

main().catch(e => fail(String(e)));
