/**
 * Димовий тест у ОДНОРАЗОВОМУ тенанті: контрагент -> товар -> видаткова накладна (створити, прочитати, оновити,
 * відмітити на вилучення, видалити остаточно) -> касовий ордер -> очищення. Запускати лише там, де можна створювати дані.
 */
import { Dntrade, DntradeError, operationExample, deepMerge } from "../src/index.js";

const dn = Dntrade.load();
const mark = `sdk-smoke ${Date.now().toString(36)}`;
const created: Array<() => Promise<unknown>> = [];
const step = async (name: string, fn: () => Promise<unknown>) => { const r = await fn(); console.log("ok ", name, typeof r === "object" && r ? JSON.stringify(r).slice(0, 140) : r); return r; };

try {
  console.log("session:", JSON.stringify(dn.session.status()));
  const stores = (await dn.references.get("stores")) as Array<{ id: number; title: string }>;
  console.log("stores:", stores.map((s) => `${s.id}:${s.title}`).join(", "));
  const partner = await step("partners.create", () => dn.partners.create({ title: `Тест контрагент ${mark}`, phone: "+3806" + Date.now().toString().slice(-8) }));
  created.push(() => dn.partners.delete(partner.id));
  const agreements = await step("partners.agreements", () => dn.partners.agreements(partner.id));
  const product = await step("products.create", () => dn.products.create({ title: `Тест товар ${mark}`, prices: [{ priceId: 1, price: 10 }, { priceId: 2, price: 15 }] }));
  created.push(() => dn.products.delete(product.id));
  await step("products.search", () => dn.products.search("Тест товар"));
  const doc = await step("invoices.create", () => dn.invoices.create({ type: 3, partnerId: partner.id, agreementId: agreements[0]?.id, note: mark, load: 0, items: [{ productId: product.id, quantity: 2, price: 15 }], confirmNegativeStock: true }));
  created.push(() => dn.invoices.delete(doc.id).catch(() => undefined));
  await step("invoices.get", () => dn.invoices.get(doc.id).then((r) => ({ number: r.data.number, total: r.data.total_price, rows: r.products.length })));
  await step("invoices.update", () => dn.invoices.update(doc.id, { fields: { note: `${mark} updated` }, confirmNegativeStock: true }));
  await step("invoices.list", () => dn.invoices.list({ type: 3, search: { note: mark } }).then((r) => ({ total: r.total_count, found: r.items.map((i) => i.id) })));
  await step("invoices.delete", () => dn.invoices.delete(doc.id));
  created.pop();
  const cash = await step("cashOrders.create", () => dn.cashOrders.create({ type: 21, partnerId: partner.id, sum: 10, note: mark }));
  await step("cashOrders.delete", () => dn.cashOrders.delete(cash.id));
  await step("call(partnersFullsearch)", () => {
    const body = deepMerge(operationExample<Record<string, unknown>>("partnersFullsearch")!, { search: { status: "1", title: "Тест контрагент" }, page: 0, limit: 5 });
    return dn.call("partnersFullsearch", { body }).then((r) => ({ status: (r as { status?: string }).status, items: ((r as { items?: unknown[] }).items || []).length }));
  });
  await step("reports.run(sell)", () => dn.reports.run("sell").then((r) => Object.keys(r as object)));
} catch (e) {
  console.error("FAIL:", e instanceof DntradeError ? e.message : e);
  process.exitCode = 1;
} finally {
  for (const undo of created.reverse()) { try { await undo(); console.log("cleanup ok"); } catch (e) { console.log("cleanup:", (e as Error).message); } }
}
