#!/usr/bin/env node
/**
 * MCP-сервер (stdio) для агентів: високорівневі інструменти для документів, контрагентів, товарів, довідників,
 * каси/банку та звітів + універсальний виклик будь-якої операції специфікації.
 *
 *   DNTRADE_SESSION_FILE=/шлях/.dntrade-session.json node dist/mcp/server.js
 *
 * Сесія створюється людиною командою `dntrade login`; сервер лише читає файл сесії й оновлює його при повторному SSO.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Dntrade } from "../index.js";
import { DntradeError, resolveSessionFile } from "../session.js";
import { findOperations, getOperation } from "../client.js";
import { DOCUMENT_TYPES } from "../resources/invoices.js";
import { REFERENCE_KINDS } from "../resources/references.js";
import { REPORT_KINDS } from "../resources/reports.js";
import { DOC_FILE_TYPES, MAX_FILE_SIZE, type FileInput } from "../resources/files.js";
import os from "node:os";
import path from "node:path";

let dn: Dntrade | null = null;
let discovering: Promise<unknown> | null = null;
function api(): Dntrade {
  if (!dn) {
    dn = Dntrade.load(resolveSessionFile());
    // параметри акаунта (організація, склад, каса, рахунок, типи цін...) визначаються через API, якщо не задані у DNTRADE_*
    discovering = dn.ensureDefaults().catch((e: unknown) => process.stderr.write(`[dntrade] автовизначення параметрів акаунта не вдалося: ${String(e)}\n`));
  }
  return dn;
}
async function ready(): Promise<Dntrade> { const d = api(); if (discovering) await discovering; return d; }
const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 1) }] });
const fail = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: e instanceof DntradeError ? `Помилка: ${e.message}${e.body ? "\n" + JSON.stringify(e.body).slice(0, 1500) : ""}` : String(e) }] });
async function run(fn: () => Promise<unknown>) { try { await ready(); return text(await fn()); } catch (e) { return fail(e); } }

const server = new McpServer({ name: "dntrade", version: "0.1.0" }, { instructions: [
  "DNTrade (navkolo.торгівля): облік товарів, документів, контрагентів, каси й банку.",
  "Документи товарообліку мають тип: 3 видаткова накладна, 2 прибуткова, 1 рахунок, 18 замовлення клієнта, 17 замовлення постачальнику, 5 переміщення, 7 повернення (повний список: dntrade_document_types).",
  "Видалення двокрокове: markDeleted (можна скасувати) і deletePermanent (незворотно). Перед створенням документа знайдіть контрагента (dntrade_search_partners) і товари (dntrade_search_products).",
  "Для операцій без окремого інструменту: dntrade_find_operations -> dntrade_call(operationId).",
  "Параметри акаунта (організація, склад, каса, рахунок, типи цін, валюта, користувач) визначаються автоматично або з DNTRADE_*: dntrade_defaults показує поточні значення.",
  "Файли (до 10 МБ) прикріплюються до документів товарообліку (замовлення клієнта 18, замовлення постачальнику 17, накладні тощо), контрагентів, співробітників, товарів і авансових звітів: dntrade_upload_files / dntrade_list_files / dntrade_download_file / dntrade_delete_file; для документів товарообліку docType можна не вказувати.",
].join(" ") });

const idSchema = z.union([z.number(), z.string()]).describe("id документа/запису");
const itemsSchema = z.array(z.object({
  productId: z.number().describe("id товару"), quantity: z.number().describe("кількість"), price: z.number().describe("ціна за одиницю"),
  storeId: z.number().optional().describe("склад (типово 1)"), unitId: z.number().optional(), categoryId: z.number().optional(), serialNum: z.string().optional(),
})).min(1).describe("таблична частина документа");

// ---- документи
server.tool("dntrade_document_types", "Список типів документів товарообліку (код -> назва).", {}, async () => text(DOCUMENT_TYPES));
server.tool("dntrade_list_documents", "Пошук/список документів товарообліку заданого типу (video: type 3 = видаткові накладні). Повертає items з id, number, date, partner, total, status.", {
  type: z.number().describe("тип документа, напр. 3"), status: z.enum(["1", "0", "2", ""]).optional().describe("1 активні (типово), 0 деактивовані, 2 на вилученні, порожньо = усі"),
  page: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(500).optional(),
  search: z.record(z.unknown()).optional().describe("фільтр: note, number, partner, date (DD-MM-YYYY), organization, user ..."),
}, async (a) => run(() => api().invoices.list({ type: a.type, status: a.status, page: a.page, limit: a.limit, search: a.search })));
server.tool("dntrade_get_document", "Документ товарообліку за id: поля (data) і таблична частина (products).", { id: idSchema }, async (a) => run(() => api().invoices.get(a.id)));
server.tool("dntrade_create_document", "Створити документ товарообліку (накладну, рахунок, замовлення тощо). Поверне id і номер.", {
  type: z.number().describe("тип документа (dntrade_document_types)"), partnerId: z.union([z.number(), z.string()]).optional().describe("id контрагента (обов'язково для продажів/закупівель)"),
  agreementId: z.union([z.number(), z.string()]).optional().describe("id договору контрагента"), items: itemsSchema,
  note: z.string().optional(), date: z.string().optional().describe("DD-MM-YYYY HH:mm:ss, типово зараз"), load: z.union([z.literal(0), z.literal(1)]).optional().describe("відгружено/проведено по складу"),
  paid: z.union([z.literal(0), z.literal(1)]).optional(), storeId: z.number().optional(), priceId: z.number().optional().describe("тип цін (типово 2 роздрібна)"),
  confirmNegativeStock: z.boolean().optional().describe("провести за мінусом, якщо товару не вистачає"), fields: z.record(z.unknown()).optional().describe("інші поля Invoices"),
}, async (a) => run(() => api().invoices.create(a)));
server.tool("dntrade_update_document", "Оновити поля документа і/або замінити табличну частину.", {
  id: idSchema, fields: z.record(z.unknown()).optional().describe("зміни полів Invoices, напр. {note: '...', paid: 1}"), items: itemsSchema.optional(), confirmNegativeStock: z.boolean().optional(),
}, async (a) => run(() => api().invoices.update(a.id, { fields: a.fields, items: a.items, confirmNegativeStock: a.confirmNegativeStock })));
server.tool("dntrade_delete_document", "Відмітити документ на вилучення; з permanent=true — видалити остаточно (незворотно).", { id: idSchema, permanent: z.boolean().optional() },
  async (a) => run(async () => (a.permanent ? api().invoices.delete(a.id) : api().invoices.markDeleted(a.id))));

// ---- контрагенти
server.tool("dntrade_search_partners", "Пошук контрагентів за назвою/телефоном/email (fullsearch).", {
  title: z.string().optional(), phone: z.string().optional(), email: z.string().optional(), status: z.enum(["1", "0", "2", ""]).optional(), page: z.number().int().optional(), limit: z.number().int().optional(),
}, async (a) => run(() => api().partners.list(a)));
server.tool("dntrade_get_partner", "Контрагент за id з договорами, рахунками, контактами.", { id: idSchema }, async (a) => run(() => api().partners.get(a.id)));
server.tool("dntrade_create_partner", "Створити контрагента (категорія 1 клієнти, 2 постачальники).", {
  title: z.string(), categoryId: z.number().optional(), type: z.number().optional().describe("1 фізична особа, 2 юридична (типово 2)"), phone: z.string().optional(), email: z.string().optional(),
  address: z.string().optional(), boss: z.string().optional(), indfeenum: z.string().optional().describe("ЄДРПОУ/ІПН"), priceId: z.number().optional(), fields: z.record(z.unknown()).optional(),
}, async (a) => run(() => api().partners.create(a)));
server.tool("dntrade_update_partner", "Оновити поля контрагента.", { id: idSchema, changes: z.record(z.unknown()) }, async (a) => run(() => api().partners.update(a.id, a.changes)));
server.tool("dntrade_delete_partner", "Відмітити контрагента на вилучення; permanent=true — остаточно.", { id: idSchema, permanent: z.boolean().optional() },
  async (a) => run(async () => (a.permanent ? api().partners.delete(a.id) : api().partners.markDeleted(a.id))));
server.tool("dntrade_partner_agreements", "Договори контрагента (agreement_id потрібен платежам).", { partnerId: idSchema }, async (a) => run(() => api().partners.agreements(a.partnerId)));

// ---- товари
server.tool("dntrade_search_products", "Швидкий пошук товарів за назвою/кодом/штрихкодом; повертає id, code, title, price.", { text: z.string(), storeId: z.number().optional() }, async (a) => run(() => api().products.search(a.text, a.storeId)));
server.tool("dntrade_list_products", "Список товарів з фільтрами (fullsearch).", { title: z.string().optional(), code: z.string().optional(), barcode: z.string().optional(), status: z.enum(["1", "0", "2", ""]).optional(), page: z.number().int().optional(), limit: z.number().int().optional() },
  async (a) => run(() => api().products.list(a)));
server.tool("dntrade_get_product", "Товар за id.", { id: idSchema, storeId: z.number().optional() }, async (a) => run(() => api().products.get(a.id, a.storeId)));
server.tool("dntrade_create_product", "Створити товар (kind: 1 товар, 2 послуга). Ціни: priceId 1 закупка, 2 роздрібна.", {
  title: z.string(), categoryId: z.number().optional(), unitId: z.number().optional().describe("одиниця виміру, типово 33 (шт)"), kind: z.number().optional(), barcode: z.string().optional(), sku: z.string().optional(), note: z.string().optional(),
  prices: z.array(z.object({ priceId: z.number(), price: z.number(), currencyId: z.number().optional() })).optional(), fields: z.record(z.unknown()).optional(),
}, async (a) => run(() => api().products.create(a)));
server.tool("dntrade_update_product", "Оновити поля товару.", { id: idSchema, changes: z.record(z.unknown()), storeId: z.number().optional() }, async (a) => run(() => api().products.update(a.id, a.changes, a.storeId)));
server.tool("dntrade_set_product_price", "Встановити ціну товару для типу цін.", { id: idSchema, priceId: z.number(), price: z.number(), storeId: z.number().optional() }, async (a) => run(() => api().products.setPrice(a.id, a.priceId, a.price, a.storeId)));
server.tool("dntrade_product_balances", "Залишки товару по складах.", { id: idSchema }, async (a) => run(() => api().products.balances(a.id)));
server.tool("dntrade_delete_product", "Відмітити товар на вилучення; permanent=true — остаточно.", { id: idSchema, permanent: z.boolean().optional() },
  async (a) => run(async () => (a.permanent ? api().products.delete(a.id) : api().products.markDeleted([a.id]))));

// ---- довідники, каса, банк, звіти
server.tool("dntrade_references", "Довідник: організації, склади, типи цін, валюти, користувачі, каси, підрозділи, рахунки, категорії, одиниці, види витрат.", {
  kind: z.enum(Object.keys(REFERENCE_KINDS) as [string, ...string[]]),
}, async (a) => run(() => api().references.get(a.kind as keyof typeof REFERENCE_KINDS)));
server.tool("dntrade_list_cash_orders", "Касові ордери (21 прибутковий, 22 видатковий).", { status: z.enum(["1", "0", "2", ""]).optional(), page: z.number().int().optional(), limit: z.number().int().optional() }, async (a) => run(() => api().cashOrders.list(a)));
server.tool("dntrade_create_cash_order", "Створити касовий ордер.", { type: z.union([z.literal(21), z.literal(22)]), partnerId: idSchema.optional(), agreementId: idSchema.optional(), sum: z.number(), note: z.string().optional(), cashboxId: z.number().optional(), date: z.string().optional(), fields: z.record(z.unknown()).optional() },
  async (a) => run(() => api().cashOrders.create(a)));
server.tool("dntrade_delete_cash_order", "Відмітити касовий ордер на вилучення; permanent=true — остаточно.", { id: idSchema, permanent: z.boolean().optional() }, async (a) => run(async () => (a.permanent ? api().cashOrders.delete(a.id) : api().cashOrders.markDeleted(a.id))));
server.tool("dntrade_list_payments", "Банківські платежі (41 вхідне, 42 вихідне доручення).", { status: z.enum(["1", "0", "2", ""]).optional(), page: z.number().int().optional(), limit: z.number().int().optional() }, async (a) => run(() => api().payments.list(a)));
server.tool("dntrade_create_payment", "Створити банківський платіж (потрібен договір контрагента: agreementId).", { type: z.union([z.literal(41), z.literal(42)]), partnerId: idSchema, agreementId: idSchema, sum: z.number(), note: z.string().optional(), accountId: z.number().optional(), date: z.string().optional(), fields: z.record(z.unknown()).optional() },
  async (a) => run(() => api().payments.create(a)));
server.tool("dntrade_delete_payment", "Відмітити платіж на вилучення; permanent=true — остаточно.", { id: idSchema, permanent: z.boolean().optional() }, async (a) => run(async () => (a.permanent ? api().payments.delete(a.id) : api().payments.markDeleted(a.id))));
server.tool("dntrade_report", "Звіт за період: sell, balance, gross_profit, profit_and_loss, cashflow, cash, partners, payments, costs, oldest, relize, structural_unit.", {
  kind: z.enum(Object.keys(REPORT_KINDS) as [string, ...string[]]), dateFrom: z.string().optional().describe("DD-MM-YYYY"), dateTo: z.string().optional().describe("DD-MM-YYYY"), search: z.record(z.unknown()).optional(),
}, async (a) => run(() => api().reports.run(a.kind as keyof typeof REPORT_KINDS, a)));

// ---- файли документів
const docTypeSchema = z.number().int().optional().describe("код розділу: тип документа товарообліку (18 замовлення клієнта, 17 замовлення постачальнику, 3 видаткова ...), 1001 контрагент, 1014 співробітник, 1000 товар, 100 авансовий звіт (повний перелік: dntrade_file_doc_types; касові ордери, платежі, склади файли не підтримують). Для документів товарообліку можна не вказувати — визначиться за id");
server.tool("dntrade_file_doc_types", "Коди docType, для яких сервер підтримує файли (код -> розділ).", {}, async () => text(DOC_FILE_TYPES));
server.tool("dntrade_list_files", "Файли, прикріплені до документа/запису: id, title, size, date, user.", { docId: idSchema, docType: docTypeSchema },
  async (a) => run(async () => { const t = await api().files.resolveType(a.docId, a.docType); return { docType: t, docId: a.docId, files: await api().files.list(t, a.docId) }; }));
server.tool("dntrade_upload_files", `Прикріпити файли (до ${MAX_FILE_SIZE / 1048576} МБ кожен) до документа/запису, напр. до замовлення клієнта. Кожен файл: path (локальний шлях) або name + contentBase64 або name + text.`, {
  docId: idSchema, docType: docTypeSchema,
  files: z.array(z.object({
    path: z.string().optional().describe("абсолютний шлях до локального файлу"), name: z.string().optional().describe("ім'я файлу (обов'язкове для contentBase64/text)"),
    contentBase64: z.string().optional().describe("вміст у base64"), text: z.string().optional().describe("текстовий вміст (UTF-8)"), contentType: z.string().optional(),
  })).min(1),
}, async (a) => run(async () => {
  const inputs: FileInput[] = a.files.map((f, i) => {
    if (f.path) return { path: f.path, name: f.name, contentType: f.contentType };
    if (!f.name) throw new DntradeError(`files[${i}]: потрібне name для contentBase64/text`);
    if (f.contentBase64 !== undefined) return { name: f.name, data: f.contentBase64, encoding: "base64" as const, contentType: f.contentType };
    if (f.text !== undefined) return { name: f.name, data: f.text, encoding: "utf8" as const, contentType: f.contentType };
    throw new DntradeError(`files[${i}]: задайте path, contentBase64 або text`);
  });
  const t = await api().files.resolveType(a.docId, a.docType);
  const r = await api().files.upload(t, a.docId, inputs);
  return { docType: t, docId: a.docId, uploaded: r.uploaded, messageSuccess: r.messageSuccess, messageError: r.messageError };
}));
server.tool("dntrade_download_file", "Завантажити файл за id (UUID з dntrade_list_files): зберігає на диск (saveTo — шлях або тека; типово DNTRADE_FILES_ROOT або тимчасова тека) і повертає шлях. Передайте docId (і docType, якщо це не документ товарообліку), щоб зберегти з оригінальним ім'ям. inline=true — додатково повернути вміст (текст, зображення або base64, до 2 МБ).", {
  fileId: z.string().describe("id файлу (UUID)"), docId: idSchema.optional().describe("запис, до якого прикріплено файл (для оригінального імені)"), docType: docTypeSchema,
  fileName: z.string().optional().describe("ім'я для збереження, якщо docId невідомий"), saveTo: z.string().optional(), inline: z.boolean().optional(),
}, async (a) => {
  try {
    await ready();
    const dir = process.env.DNTRADE_FILES_ROOT || path.join(os.tmpdir(), "dntrade-files");
    const target = a.saveTo || dir + path.sep;
    let file: string | { id: string; title: string } = a.fileId;
    if (a.docId !== undefined && !a.fileName) {
      const t = await api().files.resolveType(a.docId, a.docType);
      const found = await api().files.find(t, a.docId, a.fileId);
      if (found) file = found;
    }
    const f = await api().files.downloadTo(file, target, { fileName: a.fileName });
    const meta = { fileId: f.id, fileName: f.fileName, contentType: f.contentType, size: f.size, path: f.path };
    const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [{ type: "text", text: JSON.stringify(meta, null, 1) }];
    if (a.inline && f.size <= 2 * 1024 * 1024) {
      const ct = (f.contentType || "").split(";")[0].trim();
      if (/^image\/(png|jpeg|gif|webp)$/.test(ct)) content.push({ type: "image", data: f.data.toString("base64"), mimeType: ct });
      else if (/^text\/|json|xml|csv/.test(ct)) content.push({ type: "text", text: f.data.toString("utf8") });
      else content.push({ type: "text", text: `base64:${f.data.toString("base64")}` });
    }
    return { content };
  } catch (e) { return fail(e); }
});
server.tool("dntrade_delete_file", "Видалити прикріплений файл за id (UUID, незворотно).", { fileId: z.string().describe("id файлу (UUID)") }, async (a) => run(() => api().files.delete(a.fileId)));

// ---- універсальні
server.tool("dntrade_find_operations", "Знайти операції API за словами (operationId, шлях, назва). '+' означає підтверджену живим викликом операцію.", { query: z.string(), verifiedOnly: z.boolean().optional(), limit: z.number().int().optional() },
  async (a) => text(findOperations(a.query, a).map((o) => ({ operationId: o.operationId, method: o.method, path: o.path, summary: o.summary, verified: o.verified, query: o.query, bodyKeys: o.bodyKeys }))));
server.tool("dntrade_operation_example", "Приклад тіла запиту і список полів відповіді для операції (з реального виклику).", { operationId: z.string() },
  async (a) => run(async () => { const o = getOperation(a.operationId); return { operationId: o.operationId, method: o.method, path: o.path, query: o.query, bodyExample: o.bodyExample, responseProps: o.responseProps }; }));
server.tool("dntrade_call", "Виконати будь-яку операцію специфікації за operationId (див. dntrade_find_operations). Обережно: операції delete/deletepermanent незворотні.", {
  operationId: z.string(), query: z.record(z.unknown()).optional().describe("параметри запиту, напр. {id: 41}"), body: z.unknown().optional().describe("тіло запиту (JSON)"),
}, async (a) => run(() => api().call(a.operationId, { query: a.query, body: a.body })));
server.tool("dntrade_session_status", "Стан сесії DNTrade (тенант, чи живий JWT navkolo).", {}, async () => run(async () => api().session.status()));
server.tool("dntrade_defaults", "Параметри акаунта, що підставляються у документи (організація, склад, каса, рахунок, типи цін, валюта, користувач, одиниця, категорії); refresh=true — визначити заново через API.", { refresh: z.boolean().optional() },
  async (a) => run(async () => (a.refresh ? api().discoverDefaults() : api().config)));

const transport = new StdioServerTransport();
await server.connect(transport);
