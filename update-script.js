const fs = require('fs');

// Магазины для data.json (Орликовой не включаем). Порядок важен:
// в списке flavors[].stores стоят номера магазинов из этого списка (с нуля).
const STORES = ["Баумана", "ГУМ", "Гаджиева", "КТМ", "Крупской", "Книповича", "Кольский", "Ленина", "Мир", "ПЗ", "Североморск"];

async function updateCatalog() {
    console.log("Запуск обновления данных из Saby Retail...");

    const token = process.env.SABY_TOKEN;
    if (!token) {
        console.error("Ошибка: SABY_TOKEN не задан!");
        process.exit(1);
    }

    // ВАЖНО: настоящий запрос к Saby API ещё не написан.
    // Пока он не готов, скрипт ничего не записывает, чтобы не затирать
    // data.json выдуманными данными.
    const API_READY = false;
    if (!API_READY) {
        console.log("Запрос к Saby API ещё не подключён. data.json не изменён.");
        return;
    }

    try {
        // TODO: здесь запрос к Saby (методы и формат ответа нужно уточнить у Артёма)
        // const response = await fetch('https://online.sbis.ru/...', { headers: { ... } });
        // const sabyData = await response.json();

        const updatedData = {
            updated: new Date().toISOString(),
            stores: STORES,
            categories: [] // TODO: собрать из sabyData
        };

        fs.writeFileSync('data.json', JSON.stringify(updatedData, null, 2), 'utf-8');
        console.log("Файл data.json успешно обновлен!");
    } catch (error) {
        console.error("Ошибка при получении данных из Saby:", error);
        process.exit(1);
    }
}

updateCatalog();
