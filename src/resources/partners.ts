/** Контрагенти (/partners/*) і договори (/agreement/*). */
import { DntradeClient, operationExample, expectSuccess, type StatusResponse } from "../client.js";
import { DntradeError } from "../session.js";
import { clone, deepMerge } from "../form.js";
import type { DntradeConfig } from "../config.js";

export interface PartnerInput {
  title: string; categoryId?: number; /** 1 фізична особа, 2 юридична (так у формі DNTrade: type) */ type?: number;
  phone?: string; email?: string; address?: string; boss?: string; indfeenum?: string; priceId?: number; birthday?: string;
  fields?: Record<string, unknown>;
}

export class Partners {
  constructor(private readonly client: DntradeClient, private readonly cfg: () => DntradeConfig) {}

  async list(opts: { title?: string; phone?: string; email?: string; status?: string; categoryId?: number; page?: number; limit?: number; search?: Record<string, unknown> } = {}) {
    const body = operationExample<Record<string, unknown>>("partnersFullsearch") || { search: {}, page: 0, limit: 20, category_id: 0 };
    deepMerge(body, { search: { status: opts.status ?? "1", title: opts.title ?? "", phone: opts.phone ?? "", email: opts.email ?? "", ...(opts.search || {}) }, category_id: opts.categoryId ?? 0, page: opts.page ?? 0, limit: opts.limit ?? 20 });
    return expectSuccess(await this.client.post<StatusResponse & { items: Record<string, unknown>[]; total_count?: string | number }>("/partners/fullsearch", body), "partners.list");
  }
  /** Швидкий пошук за назвою/телефоном (як у полі вибору контрагента). */
  async search(text: string) { return this.client.get<unknown>("/partners/search", { search: text }); }

  async get(id: number | string) {
    return expectSuccess(await this.client.get<StatusResponse & { data: Record<string, unknown>; agreements?: unknown[]; accounts?: unknown[]; tags?: unknown[]; contact?: unknown[] }>("/partners/update", { id }), `partners.get ${id}`);
  }

  async create(input: PartnerInput) {
    const partners = {
      id: 0, title: input.title, category_id: { id: input.categoryId ?? this.cfg().partnerCategoryId }, type: input.type ?? 2, indfeenum: input.indfeenum ?? "", phone: input.phone ?? "",
      delivery: "", address: input.address ?? "", boss: input.boss ?? "", email: input.email ?? "", birthday: input.birthday ?? "", price_id: String(input.priceId ?? this.cfg().priceId),
      discount_number: "", keyexist: "", status: 1, vat_payer: 0, vat_rate: 0, fee_included: 0, ...(input.fields || {}),
    };
    const resp = expectSuccess(await this.client.post<StatusResponse>("/partners/create", { Partners: partners, Tags: [], update_tags: 1 }), "partners.create");
    return { id: Number(resp.id), raw: resp };
  }

  async update(id: number | string, changes: Record<string, unknown>) {
    const current = await this.get(id);
    const data = deepMerge(clone(current.data), changes) as Record<string, unknown>;
    if (data.category_id !== undefined && typeof data.category_id !== "object") data.category_id = { id: Number(data.category_id) };
    return expectSuccess(await this.client.post<StatusResponse>("/partners/update", { Partners: data, Tags: current.tags || [], update_tags: 1 }, { id }), `partners.update ${id}`);
  }

  async markDeleted(id: number | string) { return expectSuccess(await this.client.post<StatusResponse>("/partners/delete", {}, { id }), `partners.markDeleted ${id}`); }
  async deletePermanent(ids: Array<number | string>) {
    const resp = await this.client.post<{ message_success?: string; message_error?: string }>("/partners/deletepermanent", { id: ids });
    if (resp?.message_error) throw new DntradeError(`partners.deletePermanent: ${resp.message_error}`, undefined, resp);
    return resp;
  }
  async delete(id: number | string) { await this.markDeleted(id); return this.deletePermanent([id]); }

  /** Договори контрагента (потрібні платежам і документам). */
  async agreements(partnerId: number | string): Promise<Array<{ id: number; title: string; currency_id: number; main?: number }>> {
    const resp = await this.client.get<{ data?: Array<{ id: number; title: string; currency_id: number; main?: number }> } | unknown[]>("/agreement/getlist", { id: partnerId });
    return Array.isArray(resp) ? (resp as never) : (resp?.data ?? []);
  }
  async createAgreement(partnerId: number | string, opts: { title: string; currencyId?: number; isDefault?: boolean } ) {
    const body = { Agreement: { id: 0, title: opts.title, currency_id: opts.currencyId ?? this.cfg().currencyId, own_id: partnerId, default_agree: opts.isDefault === false ? 0 : 1, status: 1, debt_control: 0, debt_limit: "", debt_days: "", debt_block: 0 } };
    return expectSuccess(await this.client.post<StatusResponse>("/agreement/create", body), "partners.createAgreement");
  }
}
