/**
 * Живий цикл файлів у ОДНОРАЗОВОМУ тенанті (створює і видаляє дані; запуск лише з --yes):
 * контрагент -> товар -> замовлення клієнта (18) і замовлення постачальнику (17) ->
 * завантажити файли (шлях, текст, base64), список, завантажити вміст і звірити sha256, видалити файл ->
 * файл у картці контрагента (1001) -> універсальний виклик docfilesGetlist -> очищення.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { Dntrade, DntradeError, ORDER_TYPES } from "../src/index.js";

if (!process.argv.includes("--yes")) {
  console.error("Тест створює і видаляє дані в акаунті. Запускайте лише в тестовому кабінеті: npm run files-check -- --yes");
  process.exit(2);
}
const dn = Dntrade.load();
const mark = `files-check ${Date.now().toString(36)}`;
const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dntrade-files-check-"));
const undo: Array<[string, () => Promise<unknown>]> = [];
const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => { const r = await fn(); console.log("ok ", name, typeof r === "object" && r ? JSON.stringify(r).slice(0, 150) : r ?? ""); return r; };

try {
  await dn.ensureDefaults();
  console.log("кабінет:", dn.session.status().tenantUrl);
  const partner = await step("partners.create", () => dn.partners.create({ title: `Тест контрагент ${mark}`, phone: "+3806" + Date.now().toString().slice(-8) }));
  undo.push(["partner", () => dn.partners.delete(partner.id)]);
  const product = await step("products.create", () => dn.products.create({ title: `Тест товар ${mark}`, prices: [{ priceId: 1, price: 10 }, { priceId: 2, price: 15 }] }));
  undo.push(["product", () => dn.products.delete(product.id)]);
  const agreements = await dn.partners.agreements(partner.id);

  const order = await step("invoices.create (замовлення клієнта 18)", () => dn.invoices.create({ type: ORDER_TYPES.client, partnerId: partner.id, agreementId: agreements[0]?.id, note: mark, load: 0, items: [{ productId: product.id, quantity: 1, price: 15 }], confirmNegativeStock: true }));
  undo.push(["order18", () => dn.invoices.delete(order.id)]);

  // файли: з диска (pdf), текст, base64-зображення
  const pdfPath = path.join(tmp, "Специфікація замовлення.pdf");
  const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n% dntrade files-check\n"), crypto.randomBytes(2048), Buffer.from("\n%%EOF\n")]);
  fs.writeFileSync(pdfPath, pdf);
  const note = `Коментар до замовлення ${mark}`;
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const up = await step("files.uploadToDocument (3 файли)", () => dn.files.uploadToDocument(order.id, [pdfPath, { name: "коментар.txt", data: note, encoding: "utf8" }, { name: "макет.png", data: png.toString("base64"), encoding: "base64" }]));
  assert.equal(up.uploaded.length, 3, `очікувалось 3 нових файли, сервер: ${up.messageSuccess || ""} ${up.messageError || ""}`);

  const files = await step("files.listForDocument", () => dn.files.listForDocument(order.id));
  for (const [title, expected] of [["Специфікація замовлення.pdf", pdf], ["коментар.txt", Buffer.from(note, "utf8")], ["макет.png", png]] as const) {
    const f = files.find((x) => x.title === title);
    assert.ok(f, `немає файлу ${title} у списку: ${files.map((x) => x.title).join(", ")}`);
    const d = await dn.files.download(f!);
    assert.equal(sha(d.data), sha(expected), `вміст ${title} не збігається (${d.size} B, ${d.contentType})`);
    assert.equal(d.fileName, title);
    console.log(`ok  download ${title}: ${d.size} B, ${d.contentType}`);
  }
  const saved = await step("files.downloadTo", () => dn.files.downloadTo(files[0], tmp + path.sep + "out" + path.sep).then((r) => ({ name: path.basename(r.path), size: r.size, type: r.contentType })));
  assert.equal(saved.name, files[0].title);

  const listed = await dn.invoices.list({ type: ORDER_TYPES.client, search: { note: mark } });
  console.log("ok  invoices.list: лічильник файлів у списку замовлень =", listed.items.find((i) => i.id === order.id)?.files);

  const toDelete = files.find((x) => x.title === "макет.png")!;
  await step("files.delete", () => dn.files.delete(toDelete.id));
  assert.equal((await dn.files.listForDocument(order.id)).length, 2);

  // замовлення постачальнику (17)
  const supplierOrder = await step("invoices.create (замовлення постачальнику 17)", () => dn.invoices.create({ type: ORDER_TYPES.supplier, partnerId: partner.id, agreementId: agreements[0]?.id, note: mark, load: 0, items: [{ productId: product.id, quantity: 2, price: 10 }], confirmNegativeStock: true }));
  undo.push(["order17", () => dn.invoices.delete(supplierOrder.id)]);
  const up17 = await step("files.upload (17)", () => dn.files.upload(ORDER_TYPES.supplier, supplierOrder.id, [{ name: "рахунок постачальника.txt", data: "рахунок", encoding: "utf8" }]));
  assert.equal(up17.uploaded.length, 1);

  // картка контрагента (1001) і універсальний виклик
  const upPartner = await step("files.upload (контрагент 1001)", () => dn.files.upload(1001, partner.id, [{ name: "договір.txt", data: "договір", encoding: "utf8" }]));
  assert.equal(upPartner.uploaded.length, 1);
  const viaCall = await step("call(docfilesGetlist)", () => dn.call<{ status: string; data: unknown[] }>("docfilesGetlist", { query: { doc_id: partner.id, doc_type: 1001 } }).then((r) => ({ status: r.status, files: r.data.length })));
  assert.equal(viaCall.files, 1);

  // прибрати файли до видалення записів
  for (const [t, id] of [[ORDER_TYPES.client, order.id], [ORDER_TYPES.supplier, supplierOrder.id], [1001, partner.id]] as const)
    for (const f of await dn.files.list(t, id)) await dn.files.delete(f.id);
  console.log("ok  файли тестових записів видалено");
  console.log("ALL OK");
} catch (e) {
  console.error("FAIL:", e instanceof DntradeError ? `${e.message}${e.body ? " " + JSON.stringify(e.body).slice(0, 300) : ""}` : e);
  process.exitCode = 1;
} finally {
  for (const [name, fn] of undo.reverse()) { try { await fn(); console.log("cleanup", name); } catch (e) { console.log("cleanup", name, "->", (e as Error).message); } }
  fs.rmSync(tmp, { recursive: true, force: true });
}
