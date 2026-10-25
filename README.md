# dntrade-sdk

Самодостатній SDK і MCP-сервер для внутрішнього API DNTrade (модуль «navkolo.торгівля», `https://app1.dntrade.com.ua`).
Специфікація API — `openapi/dntrade.openapi.yaml` (406 операцій, 150 підтверджено живими викликами); з неї генеруються
типи (`src/generated/types.ts`), індекс операцій для універсального виклику (`operations.json`) і форми документів
за типами (`invoice-defaults.json`).

## Встановлення і вхід

```bash
cd dntrade-sdk && npm install && npm run build
npx dntrade login ./navkolo      # файл: [URL] / логін / пароль; або NAVKOLO_LOGIN + NAVKOLO_PASSWORD
npx dntrade status
```

`login` проходить кабінет navkolo → SSO → тенант DNTrade і зберігає сесію (cookie тенанта, Token API, JWT navkolo)
у `.dntrade-session.json` (права 600). Файл шукається так: `DNTRADE_SESSION_FILE`, потім `.dntrade-session.json`
у поточній теці і до трьох тек вище, потім `~/.dntrade/session.json`. Формат сумісний з Python-обгорткою проекту.

У DNTrade **один активний Token на користувача**: новий SSO-вхід (також відкриття модуля в браузері) анулює попередній.
Відновлення сесії автоматичне, в такому порядку:

1. при 401/403 — повторний SSO за збереженим JWT navkolo (`resso`, без пароля), поки JWT живий (~2.8 год після входу);
2. якщо JWT прострочений, SSO не вдався або файлу сесії немає — повний вхід за `DNTRADE_LOGIN` і `DNTRADE_PASSWORD`
   з оточення або `.env`; нова сесія зберігається у файл.

`.env` шукається так: `DNTRADE_ENV_FILE`, інакше `.env` у поточній теці або до трьох тек вище (зразок: `.env.example`).
Для MCP-сервера (робоча тека може бути будь-якою) задайте `DNTRADE_ENV_FILE` або самі змінні у блоці `env` конфігурації.
Без облікових даних у `.env` агент працює лише з уже збереженою сесією (`dntrade login` виконує людина).
Перевірка автологіну: `npm run auto-login-check` (псує копію сесії і переконується, що SDK входить сам).

## Використання з коду

```ts
import { Dntrade } from "dntrade-sdk";

const dn = Dntrade.load();
const partners = await dn.partners.list({ title: "Рівер" });
const products = await dn.products.search("кулька");
const doc = await dn.invoices.create({
  type: 3,                                   // видаткова накладна
  partnerId: partners.items[0].id,
  items: [{ productId: products[0].id, quantity: 2, price: 72.5 }],
  note: "з SDK", load: 1,
  confirmNegativeStock: false,               // true — провести за мінусом, якщо залишку не вистачає
});
await dn.invoices.update(doc.id, { fields: { note: "оновлено" } });
await dn.invoices.markDeleted(doc.id);       // відмітити на вилучення (оборотно)
await dn.invoices.deletePermanent([doc.id]); // остаточно

// будь-яка операція специфікації
const ops = findOperations("partners debt");
await dn.call("partnersGetdebtinfo", { body: { id: 100006 } });
```

Ресурси фасаду `Dntrade`: `invoices` (усі типи документів, `DOCUMENT_TYPES`), `partners` (+ договори), `products`
(+ категорії, ціни, залишки), `references` (організації, склади, типи цін, валюти, користувачі, каси, підрозділи,
рахунки, категорії, одиниці, види витрат), `cashOrders` (21/22), `payments` (41/42), `reports` (12 звітів),
`files` (файли документів і записів довідників), `call`.
Типізований клієнт openapi-fetch: `dn.client.typed.POST("/invoices/fullsearch", { body })`.

## Файли документів

До документів (замовлення клієнта, замовлення постачальнику, накладні, касові ордери, платежі тощо) і до записів
довідників (контрагенти, товари, склади ...) можна прикріплювати файли до 10 МБ кожен. Файл прив'язується до пари
`docType` + `docId`: для документів товарообліку `docType` дорівнює типу документа (18 замовлення клієнта,
17 замовлення у постачальника, 3 видаткова накладна ...), довідники мають власні коди (1001 контрагенти, 1000 товари;
повний перелік — `DOC_FILE_TYPES`, `npx dntrade files types`).

```ts
import { Dntrade, ORDER_TYPES } from "dntrade-sdk";
const dn = Dntrade.load();

// тип документа визначається за id автоматично
const { uploaded } = await dn.files.uploadToDocument(orderId, [
  "/шлях/до/рахунку.pdf",                                         // файл з диска
  { name: "коментар.txt", data: "текст", encoding: "utf8" },       // вміст з пам'яті
  { name: "макет.png", data: base64String, encoding: "base64" },
]);
const files = await dn.files.listForDocument(orderId);          // id (UUID), title, size, date, user
const file = await dn.files.download(files[0]);                 // { fileName, contentType, size, data: Buffer }
await dn.files.downloadTo(files[0], "./downloads/");            // зберегти на диск з оригінальним ім'ям
await dn.files.delete(files[0].id);                             // видалити (незворотно)

// явний docType: замовлення постачальнику, картка контрагента
await dn.files.upload(ORDER_TYPES.supplier, supplierOrderId, ["./накладна.pdf"]);
await dn.files.list(1001, partnerId);
```

Сервер віддає вміст як `application/octet-stream`, а в імені лише розширення (`.pdf`), тому передавайте в
`download`/`downloadTo` об'єкт файлу зі списку: SDK візьме оригінальне ім'я з `title` і визначить тип за розширенням.
Якщо передати лише id, файл буде названо `file-<id>.<розширення>`.

CLI: `npx dntrade files list <docId> [--type N]`, `files upload <docId> <шлях...> [--type N]`,
`files download <fileId> [--doc docId [--type N]] [--name ім'я] [--out шлях]`, `files delete <fileId>`, `files types`.

Змінна `DNTRADE_FILES_ROOT` (необов'язково) обмежує читання і запис файлів однією текою: шляхи поза нею
відхиляються. Рекомендовано задавати її для MCP-сервера, щоб агент не міг надіслати в DNTrade довільний локальний файл.

## MCP-сервер для агента

```json
{
  "mcpServers": {
    "dntrade": {
      "command": "node",
      "args": ["/абсолютний/шлях/dntrade-sdk/dist/mcp/server.js"],
      "env": {
        "DNTRADE_SESSION_FILE": "/абсолютний/шлях/.dntrade-session.json",
        "DNTRADE_ENV_FILE": "/абсолютний/шлях/.env",
        "DNTRADE_FILES_ROOT": "/абсолютний/шлях/до/теки/з/файлами"
      }
    }
  }
}
```

Інструменти: `dntrade_document_types`, `dntrade_list_documents`, `dntrade_get_document`, `dntrade_create_document`,
`dntrade_update_document`, `dntrade_delete_document`, `dntrade_search_partners`, `dntrade_get_partner`,
`dntrade_create_partner`, `dntrade_update_partner`, `dntrade_delete_partner`, `dntrade_partner_agreements`,
`dntrade_search_products`, `dntrade_list_products`, `dntrade_get_product`, `dntrade_create_product`,
`dntrade_update_product`, `dntrade_set_product_price`, `dntrade_product_balances`, `dntrade_delete_product`,
`dntrade_references`, `dntrade_list_cash_orders`, `dntrade_create_cash_order`, `dntrade_delete_cash_order`,
`dntrade_list_payments`, `dntrade_create_payment`, `dntrade_delete_payment`, `dntrade_report`,
`dntrade_file_doc_types`, `dntrade_list_files`, `dntrade_upload_files`, `dntrade_download_file`, `dntrade_delete_file`,
`dntrade_find_operations`, `dntrade_operation_example`, `dntrade_call`, `dntrade_session_status`, `dntrade_defaults`.

Файли в MCP: `dntrade_upload_files` приймає для кожного файлу `path` (локальний шлях), або `name` + `contentBase64`,
або `name` + `text`; `docType` для документів товарообліку можна не вказувати. `dntrade_download_file` зберігає файл
у `saveTo` (типово `DNTRADE_FILES_ROOT` або тимчасова тека) і повертає шлях; з `inline: true` додатково повертає
вміст: текст, зображення (агент його бачить) або base64, до 2 МБ. Щоб зберегти файл з оригінальним ім'ям,
передайте в `dntrade_download_file` також `docId` (і `docType` для записів довідників).

Перевірка: `npm run mcp-check` (піднімає сервер через stdio, викликає інструменти читання).
Файли без мережі й акаунта: `npm run files-offline` (SDK) і `npm run files-mcp-offline` (MCP через stdio) на мок-сервері.
Живий цикл файлів у одноразовому тенанті (створює і видаляє дані): `npm run files-check -- --yes`.
Димовий тест у одноразовому тенанті (створює і видаляє тестові дані): `npm run smoke`.

## Незалежність від акаунта

SDK і MCP-сервер не прив'язані до конкретного акаунта чи тенанта:

- адреса тенанта (`https://<tenant>.dntrade.com.ua`) і API визначаються під час входу через кабінет navkolo і зберігаються
  лише у файлі сесії; інший логін дає інший тенант;
- ідентифікатори акаунта, які підставляються у документи (організація, склад, каса, рахунок, типи цін, валюта,
  користувач, одиниця виміру, категорії), беруться в такому порядку: змінні `DNTRADE_*` → автовизначення через API
  (`dn.discoverDefaults()`, у MCP-сервері виконується при старті) → вбудовані типові значення нового кабінету DNTrade;
- приклади у специфікації санітизовані (`openapi/config/sanitize.json` у пайплайні), жодних реальних назв, контактів чи кодів.

| Змінна | Значення за замовчуванням | Призначення |
| --- | --- | --- |
| `DNTRADE_LOGIN`, `DNTRADE_PASSWORD` | — | автоматичний вхід |
| `DNTRADE_SESSION_FILE` | `.dntrade-session.json` | файл сесії |
| `DNTRADE_ENV_FILE` | `.env` поруч або вище | звідки читати `.env` |
| `DNTRADE_FILES_ROOT` | без обмеження | тека, поза якою не можна читати/писати файли |
| `DNTRADE_ORGANIZATION_ID` | перша організація / 1 | `organization_id` документів |
| `DNTRADE_STORE_ID` | склад з `is_sell=1` / 1 | склад рядків документа |
| `DNTRADE_CASHBOX_ID` | головна каса (`main=1`) / 1 | касові ордери |
| `DNTRADE_ACCOUNT_ID` | головний рахунок / 1 | банківські платежі |
| `DNTRADE_PRICE_ID` | роздрібний тип цін (`type=3`) / 2 | ціни продажу |
| `DNTRADE_PURCHASE_PRICE_ID` | закупівельний (`type=1`) / 1 | закупівельні ціни |
| `DNTRADE_CURRENCY_ID` | валюта з курсом 1 / 1 | валюта документів |
| `DNTRADE_USER_ID` | перший користувач / 1 | автор документів |
| `DNTRADE_UNIT_ID` | одиниця «шт» / 33 | одиниця за замовчуванням |
| `DNTRADE_PARTNER_CATEGORY_ID` | перша категорія / 1 | категорія нових контрагентів |
| `DNTRADE_PRODUCT_CATEGORY_ID` | перша категорія / 1 | категорія нових товарів |

Поточні значення: `npx dntrade defaults` або інструмент MCP `dntrade_defaults`.

## Кодування тіла запитів

Типово SDK надсилає `application/x-www-form-urlencoded` з PHP-вкладеними ключами, як сам фронтенд (`phpFormEncode`):
саме так підтверджені всі операції. Сервер приймає і JSON (`contentType: "json"` у `session.request`/`dn.call`), але
деякі операції (наприклад `products/create`) повертають 500 на порожніх об'єктах у JSON, тому JSON вмикайте точково.

## Обмеження

- Тип документа 6 «Продаж по чеку» через `/invoices/create` не підтверджений (сервер вимагає касу; поле не знайдено).
- Операції з `x-verified: false` у специфікації доступні через `dn.call`, але їх тіла виведені статично.
- Файл сесії містить cookie тенанта і JWT navkolo: зберігайте його як секрет.
- Офіційний API DNTrade (`api.dntrade.com.ua`) для navkolo-тенантів недоступний.
