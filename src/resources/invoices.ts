/** Документи товарообліку (/invoices/*): усі типи накладних, тип задає Invoices.type. */
import defaultsJson from "../generated/invoice-defaults.json" with { type: "json" };
import { DntradeClient, operationExample, expectSuccess, type StatusResponse } from "../client.js";
import { DntradeError } from "../session.js";
import { clone, deepMerge, formatDate } from "../form.js";
import type { DntradeConfig } from "../config.js";

export const DOCUMENT_TYPES: Record<number, string> = {
  1: "Рахунок на оплату", 2: "Прибуткова накладна", 3: "Видаткова накладна", 4: "Оприбуткування товарів", 5: "Переміщення товарів",
  6: "Продаж по чеку", 7: "Повернення товару", 8: "Списання товарів", 9: "Продаж товару в рахунок зарплати", 10: "Інвентаризація товарів",
  11: "Повернення від співробітника", 12: "Повернення товарів постачальнику", 13: "Оприбуткування товарів з виробництва",
  14: "Вилучення товарів зі складу", 15: "Розфасовка товарів з виробництва", 16: "Звіт виробничої зміни", 17: "Замовлення у постачальника",
  18: "Замовлення клієнта", 201: "Замовлення на виробництво",
};
/** Статуси документів у пошуку: 1 активні, 0 деактивовані, 2 відмічені на вилучення, "" усі. */
export const DOCUMENT_STATUS = { active: "1", deactivated: "0", deleted: "2", all: "" } as const;

const invoiceDefaults = defaultsJson as Record<string, { section: string; title: string; invoice: Record<string, unknown> }>;

export interface DocumentItemInput {
  productId: number; quantity: number; price: number;
  storeId?: number; unitId?: number; categoryId?: number; serialNum?: string; discountTotal?: number;
}
export interface DocumentRow extends Record<string, unknown> { id: number; quantity: number; price: number; total: number; store_id: number }

/** Рядок табличної частини (DocumentsTable). */
export function productRow(item: DocumentItemInput, defaults: { storeId?: number; unitId?: number; categoryId?: number } = {}): DocumentRow {
  const total = Math.round(item.quantity * item.price * 100) / 100;
  return {
    id: item.productId, quantity: item.quantity, price: item.price, total, store_id: item.storeId ?? defaults.storeId ?? 1,
    unit_id: item.unitId ?? defaults.unitId ?? 33, real_price: item.price, discount_total: item.discountTotal ?? 0, type: 1,
    category_id: item.categoryId ?? defaults.categoryId ?? 0, price_novat: 0, vat_percent: 0, vat: 0, total_novat: 0,
    serial_num: item.serialNum ?? "", fact_quantity: item.quantity, res_quantity: item.quantity,
  };
}

/** Форма нового документа заданого типу: значення за замовчуванням з інтерфейсу розділу + параметри акаунта (cfg). */
export function newDocument(type: number, overrides: Record<string, unknown> = {}, cfg?: DntradeConfig): Record<string, unknown> {
  const d = invoiceDefaults[String(type)];
  if (!d) throw new DntradeError(`Невідомий тип документа ${type}. Доступні: ${Object.keys(invoiceDefaults).join(", ")}`);
  const inv = clone(d.invoice);
  const account = cfg ? { organization_id: cfg.organizationId, price_id: String(cfg.priceId), currency_id: String(cfg.currencyId), user_id: cfg.userId } : {};
  return deepMerge(inv, { date: formatDate(), ...account, ...overrides });
}

export interface ListDocumentsOptions {
  type: number; status?: string; page?: number; limit?: number;
  /** Поля фільтра search (note, number, partner, date, organization, user ...). */
  search?: Record<string, unknown>;
  advSearch?: Record<string, unknown>;
}
export interface CreateDocumentOptions {
  type: number; partnerId?: number | string; agreementId?: number | string; items: DocumentItemInput[];
  note?: string; date?: string; load?: 0 | 1; paid?: 0 | 1; storeId?: number; priceId?: number; organizationId?: number;
  /** Провести за мінусом, якщо товару не вистачає (сервер відповідає ask_direct). */
  confirmNegativeStock?: boolean;
  /** Будь-які інші поля Invoices. */
  fields?: Record<string, unknown>;
  labels?: unknown[];
}
export interface CreatedDocument { id: number; number: number; message?: string; raw: StatusResponse }

export class Invoices {
  constructor(private readonly client: DntradeClient, private readonly cfg: () => DntradeConfig) {}

  async list(opts: ListDocumentsOptions) {
    const body = operationExample<Record<string, unknown>>("invoicesFullsearch") || { search: {}, adv_search: {}, type: opts.type, page: 0, limit: 50, total: 0 };
    deepMerge(body, { search: { status: opts.status ?? DOCUMENT_STATUS.active, note: "", number: "", partner: "", ...(opts.search || {}) }, adv_search: opts.advSearch || {}, type: opts.type, page: opts.page ?? 0, limit: opts.limit ?? 50, total: 0 });
    return expectSuccess(await this.client.post<StatusResponse & { items: Record<string, unknown>[]; total_count: string | number; limit: string | number }>("/invoices/fullsearch", body), "invoices.list");
  }

  async get(id: number | string) {
    return expectSuccess(await this.client.get<StatusResponse & { data: Record<string, unknown>; products: DocumentRow[]; currency?: unknown }>("/invoices/update", { id }), `invoices.get ${id}`);
  }

  async create(opts: CreateDocumentOptions): Promise<CreatedDocument> {
    const inv = newDocument(opts.type, {
      ...(opts.partnerId !== undefined ? { partner_id: opts.partnerId } : {}),
      ...(opts.agreementId !== undefined ? { agreement_id: opts.agreementId } : {}),
      ...(opts.note !== undefined ? { note: opts.note } : {}),
      ...(opts.date !== undefined ? { date: opts.date } : {}),
      ...(opts.load !== undefined ? { load: opts.load } : {}),
      ...(opts.paid !== undefined ? { paid: opts.paid } : {}),
      ...(opts.priceId !== undefined ? { price_id: opts.priceId } : {}),
      ...(opts.organizationId !== undefined ? { organization_id: opts.organizationId } : {}),
      ...(opts.fields || {}),
    }, this.cfg());
    const rows = opts.items.map((it) => productRow(it, { storeId: opts.storeId ?? this.cfg().storeId, unitId: this.cfg().unitId }));
    const body: Record<string, unknown> = { Invoices: inv, direct_sell: 0, confirm_inactive_references: 0, DocumentsTable: rows, Labels: opts.labels || [] };
    let resp = await this.client.post<StatusResponse>("/invoices/create", body);
    if (resp?.status === "error" && resp.ask_direct) {
      if (!opts.confirmNegativeStock) throw new DntradeError(`invoices.create: не вистачає залишку (повторіть з confirmNegativeStock=true): ${resp.ask_direct.replace(/<[^>]+>/g, " ").trim()}`, undefined, resp);
      body.direct_sell = 1;
      resp = await this.client.post<StatusResponse>("/invoices/create", body);
    }
    expectSuccess(resp, "invoices.create");
    return { id: Number(resp.id), number: Number(resp.number), message: resp.message, raw: resp };
  }

  /** Часткове оновлення: читає документ, накладає зміни полів і/або нову табличну частину, зберігає. */
  async update(id: number | string, changes: { fields?: Record<string, unknown>; items?: DocumentItemInput[]; rows?: DocumentRow[]; confirmNegativeStock?: boolean; storeId?: number }) {
    const current = await this.get(id);
    const inv = deepMerge(clone(current.data), changes.fields || {});
    const rows = changes.rows ?? (changes.items ? changes.items.map((it) => productRow(it, { storeId: changes.storeId ?? this.cfg().storeId, unitId: this.cfg().unitId })) : current.products);
    const body: Record<string, unknown> = { Invoices: inv, direct_sell: 0, confirm_inactive_references: 0, DocumentsTable: rows };
    let resp = await this.client.post<StatusResponse>("/invoices/update", body, { id });
    if (resp?.status === "error" && resp.ask_direct) {
      if (!changes.confirmNegativeStock) throw new DntradeError(`invoices.update: не вистачає залишку (повторіть з confirmNegativeStock=true): ${resp.ask_direct.replace(/<[^>]+>/g, " ").trim()}`, undefined, resp);
      body.direct_sell = 1;
      resp = await this.client.post<StatusResponse>("/invoices/update", body, { id });
    }
    return expectSuccess(resp, `invoices.update ${id}`);
  }

  async saveNote(id: number | string, note: string) { return expectSuccess(await this.client.post<StatusResponse>("/invoices/savenote", { id, note }), "invoices.saveNote"); }
  /** Відмітити на вилучення (status 2); повторний виклик знімає відмітку. */
  async markDeleted(id: number | string) { return expectSuccess(await this.client.post<StatusResponse>("/invoices/delete", {}, { id }), `invoices.markDeleted ${id}`); }
  /** Видалити остаточно (незворотно). Документ має бути відмічений на вилучення. */
  async deletePermanent(ids: Array<number | string>) {
    const resp = await this.client.post<{ message_success?: string; message_error?: string }>("/invoices/deletepermanent", { id: ids });
    if (resp?.message_error) throw new DntradeError(`invoices.deletePermanent: ${resp.message_error}`, undefined, resp);
    return resp;
  }
  /** Відмітити на вилучення і видалити остаточно. */
  async delete(id: number | string) { await this.markDeleted(id); return this.deletePermanent([id]); }
}
