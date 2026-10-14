/** Касові ордери (/cashboxorder/*) і банківські платежі (/payments/*). */
import { DntradeClient, operationExample, expectSuccess, type StatusResponse } from "../client.js";
import { DntradeError } from "../session.js";
import { clone, deepMerge, formatDate } from "../form.js";
import type { DntradeConfig } from "../config.js";

/** Типи: касові 21 прибутковий, 22 видатковий; банк 41 вхідне, 42 вихідне платіжне доручення. */
export const CASH_ORDER_TYPES: Record<number, string> = { 21: "Прибутковий касовий ордер", 22: "Видатковий касовий ордер" };
export const PAYMENT_TYPES: Record<number, string> = { 41: "Платіжне доручення вхідне", 42: "Платіжне доручення вихідне" };

interface DocOpts { type: number; partnerId?: number | string; agreementId?: number | string; sum: number; note?: string; date?: string; cashboxId?: number; accountId?: number; organizationId?: number; costId?: number | string; subdivisionId?: number | string; fields?: Record<string, unknown> }

class FinanceDocs {
  constructor(protected readonly client: DntradeClient, protected readonly cfg: () => DntradeConfig, private readonly ctrl: "cashboxorder" | "payments", private readonly key: "Cashboxorder" | "Payments") {}

  async list(opts: { status?: string; type?: number; page?: number; limit?: number; search?: Record<string, unknown> } = {}) {
    const body = operationExample<Record<string, unknown>>(`${this.ctrl}Fullsearch`) || { search: {}, page: 0, limit: 20 };
    deepMerge(body, { search: { status: opts.status ?? "1", ...(opts.search || {}) }, page: opts.page ?? 0, limit: opts.limit ?? 20, ...(opts.type ? { type: opts.type } : {}) });
    return expectSuccess(await this.client.post<StatusResponse & { items: Record<string, unknown>[]; total_count?: string | number }>(`/${this.ctrl}/fullsearch`, body), `${this.ctrl}.list`);
  }
  async get(id: number | string) { return expectSuccess(await this.client.get<StatusResponse & { data: Record<string, unknown> }>(`/${this.ctrl}/update`, { id }), `${this.ctrl}.get ${id}`); }

  async create(opts: DocOpts) {
    const template = operationExample<Record<string, Record<string, unknown>>>(`${this.ctrl}Create`);
    const doc: Record<string, unknown> = template?.[this.key] ? clone(template[this.key]) : {};
    const isCash = this.ctrl === "cashboxorder";
    const cfg = this.cfg();
    deepMerge(doc, {
      id: 0, type: opts.type, number: "", status: 1, note: opts.note ?? "", total_sum: opts.sum, organization_id: opts.organizationId ?? cfg.organizationId,
      currency_id: String(cfg.currencyId), user_id: cfg.userId,
      ...(isCash ? { date_order: opts.date ?? formatDate(), cashbox_id: opts.cashboxId ?? cfg.cashboxId, object_id: opts.partnerId ?? "" } : { date: opts.date ?? formatDate(), account_id: opts.accountId ?? cfg.accountId, cashbox_id: String(cfg.cashboxId), partner_id: opts.partnerId ?? "" }),
      agreement_id: opts.agreementId ?? "", cost_id: opts.costId ?? "", subdivision_id: opts.subdivisionId ?? "", makefrom_relations: "", makefrom_type: "", ...(opts.fields || {}),
    });
    const resp = expectSuccess(await this.client.post<StatusResponse>(`/${this.ctrl}/create`, { [this.key]: doc }), `${this.ctrl}.create`);
    return { id: Number(resp.id), raw: resp };
  }
  async update(id: number | string, changes: Record<string, unknown>) {
    const current = await this.get(id);
    return expectSuccess(await this.client.post<StatusResponse>(`/${this.ctrl}/update`, { [this.key]: deepMerge(clone(current.data), changes) }, { id }), `${this.ctrl}.update ${id}`);
  }
  async saveNote(id: number | string, note: string) { return expectSuccess(await this.client.post<StatusResponse>(`/${this.ctrl}/savenote`, { id, note }), `${this.ctrl}.saveNote`); }
  async markDeleted(id: number | string) { return expectSuccess(await this.client.post<StatusResponse>(`/${this.ctrl}/delete`, {}, { id }), `${this.ctrl}.markDeleted ${id}`); }
  async deletePermanent(ids: Array<number | string>) {
    const resp = await this.client.post<{ message_success?: string; message_error?: string }>(`/${this.ctrl}/deletepermanent`, { id: ids });
    if (resp?.message_error) throw new DntradeError(`${this.ctrl}.deletePermanent: ${resp.message_error}`, undefined, resp);
    return resp;
  }
  async delete(id: number | string) { await this.markDeleted(id); return this.deletePermanent([id]); }
}

export class CashOrders extends FinanceDocs { constructor(client: DntradeClient, cfg: () => DntradeConfig) { super(client, cfg, "cashboxorder", "Cashboxorder"); } }
export class Payments extends FinanceDocs { constructor(client: DntradeClient, cfg: () => DntradeConfig) { super(client, cfg, "payments", "Payments"); } }
