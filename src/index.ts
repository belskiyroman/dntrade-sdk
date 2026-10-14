/**
 * dntrade-sdk: SDK для внутрішнього API DNTrade (модуль navkolo.торгівля).
 *
 *   import { Dntrade } from "dntrade-sdk";
 *   const dn = Dntrade.load();                       // сесія з .dntrade-session.json (після `dntrade login`)
 *   const docs = await dn.invoices.list({ type: 3 }); // видаткові накладні
 *   const created = await dn.invoices.create({ type: 3, partnerId: 100001, items: [{ productId: 5, quantity: 1, price: 72.5 }] });
 *   await dn.call("partnersFullsearch", { body: { search: { title: "Іван" }, page: 0, limit: 20 } }); // будь-яка операція
 */
export * from "./session.js";
export * from "./client.js";
export * from "./form.js";
export * from "./resources/invoices.js";
export * from "./resources/partners.js";
export * from "./resources/products.js";
export * from "./resources/references.js";
export * from "./resources/finance.js";
export * from "./resources/reports.js";
export * from "./config.js";

import { DntradeClient, type CallOptions } from "./client.js";
import { DntradeSession, resolveSessionFile } from "./session.js";
import { Invoices } from "./resources/invoices.js";
import { Partners } from "./resources/partners.js";
import { Products } from "./resources/products.js";
import { References } from "./resources/references.js";
import { CashOrders, Payments } from "./resources/finance.js";
import { Reports } from "./resources/reports.js";
import { configFromEnv, envDefinedKeys, type DntradeConfig } from "./config.js";

/** Фасад: усі ресурси + універсальний виклик. */
export class Dntrade {
  readonly client: DntradeClient;
  /** Параметри акаунта (ідентифікатори організації, складу, каси, рахунку, типів цін, валюти, користувача, одиниці, категорій). */
  config: DntradeConfig;
  private discovered = false;
  readonly invoices: Invoices;
  readonly partners: Partners;
  readonly products: Products;
  readonly references: References;
  readonly cashOrders: CashOrders;
  readonly payments: Payments;
  readonly reports: Reports;

  constructor(session: DntradeSession, config: Partial<DntradeConfig> = {}) {
    this.config = configFromEnv(config);
    const cfg = () => this.config;
    this.client = new DntradeClient(session);
    this.invoices = new Invoices(this.client, cfg);
    this.partners = new Partners(this.client, cfg);
    this.products = new Products(this.client, cfg);
    this.references = new References(this.client);
    this.cashOrders = new CashOrders(this.client, cfg);
    this.payments = new Payments(this.client, cfg);
    this.reports = new Reports(this.client);
  }
  static load(file: string = resolveSessionFile(), opts: { relogin?: boolean; config?: Partial<DntradeConfig> } = {}): Dntrade {
    return new Dntrade(DntradeSession.load(file, { relogin: opts.relogin }), opts.config);
  }

  /**
   * Визначає параметри акаунта через API: перша організація, перший склад, головна каса й рахунок (main=1),
   * роздрібний тип цін (type 3) і закупівельний (type 1), основна валюта (rate 1), поточний користувач, одиниця «шт»,
   * перші категорії контрагентів і товарів. Значення, задані в оточенні (DNTRADE_*), не перекриваються.
   */
  async discoverDefaults(): Promise<DntradeConfig> {
    const fixed = new Set(envDefinedKeys());
    const set = (key: keyof DntradeConfig, value: unknown) => { const n = Number(value); if (!fixed.has(key) && Number.isFinite(n) && n > 0) this.config[key] = n; };
    const first = (v: unknown): Record<string, unknown> | null => (Array.isArray(v) && v.length ? (v[0] as Record<string, unknown>) : null);
    const find = (v: unknown, pred: (x: Record<string, unknown>) => boolean) => (Array.isArray(v) ? (v as Record<string, unknown>[]).find(pred) : undefined);
    const tryGet = async (kind: Parameters<References["get"]>[0]) => { try { return await this.references.get(kind); } catch { return null; } };
    const orgs = await tryGet("organizations"); if (first(orgs)) set("organizationId", first(orgs)!.id);
    const stores = await tryGet("stores"); if (first(stores)) set("storeId", (find(stores, (s) => Number(s.is_sell) === 1) || first(stores)!).id);
    const cashboxes = await tryGet("cashboxes"); if (first(cashboxes)) set("cashboxId", (find(cashboxes, (c) => Number(c.main) === 1) || first(cashboxes)!).id);
    const accounts = await tryGet("accounts"); if (first(accounts)) set("accountId", (find(accounts, (a) => Number(a.main) === 1 || Number(a.default_acc) === 1) || first(accounts)!).id);
    const prices = await tryGet("price_types");
    if (first(prices)) { set("priceId", (find(prices, (p) => String(p.type) === "3") || first(prices)!).id); set("purchasePriceId", (find(prices, (p) => String(p.type) === "1") || first(prices)!).id); }
    const currencies = await tryGet("currencies"); if (first(currencies)) set("currencyId", (find(currencies, (c) => Number(c.rate) === 1) || first(currencies)!).id);
    const users = await tryGet("users"); if (first(users)) set("userId", first(users)!.id);
    const units = await tryGet("units"); if (first(units)) set("unitId", (find(units, (u) => String(u.label).toLowerCase() === "шт") || first(units)!).id);
    const pcats = await tryGet("partner_categories"); if (first(pcats)) set("partnerCategoryId", first(pcats)!.id);
    const cats = await tryGet("product_categories"); if (first(cats)) set("productCategoryId", first(cats)!.id);
    this.discovered = true;
    return this.config;
  }
  /** Один раз визначити параметри акаунта, якщо ще не визначено. */
  async ensureDefaults(): Promise<DntradeConfig> { return this.discovered ? this.config : this.discoverDefaults(); }
  get session(): DntradeSession { return this.client.session; }
  call<T = unknown>(operationId: string, opts?: CallOptions): Promise<T> { return this.client.call<T>(operationId, opts); }
}
