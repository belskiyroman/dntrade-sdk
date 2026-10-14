/** Товари (/products/*), категорії товарів (/categories/*). */
import { DntradeClient, operationExample, expectSuccess, type StatusResponse } from "../client.js";
import { DntradeError } from "../session.js";
import { clone, deepMerge } from "../form.js";
import type { DntradeConfig } from "../config.js";

export interface ProductInput {
  title: string; categoryId?: number; unitId?: number; /** 1 товар, 2 послуга, 3 складений, 4 сертифікат */ kind?: number;
  barcode?: string; sku?: string; note?: string; prices?: Array<{ priceId: number; price: number; currencyId?: number }>;
  fields?: Record<string, unknown>;
}

export class Products {
  constructor(private readonly client: DntradeClient, private readonly cfg: () => DntradeConfig) {}

  /** Швидкий пошук (назва/код/штрихкод) для підбору в документ. */
  async search(text: string, storeId = this.cfg().storeId) { return this.client.get<Array<{ id: number; code: number | string; barcode?: string; sku?: string; title: string; price?: number }>>("/products/search", { search: text, store_id: storeId }); }

  async list(opts: { title?: string; code?: string; barcode?: string; status?: string; page?: number; limit?: number; search?: Record<string, unknown> } = {}) {
    const body = operationExample<Record<string, unknown>>("productsFullsearch") || { search: {}, page: 0, limit: 20 };
    deepMerge(body, { search: { status: opts.status ?? "1", title: opts.title ?? "", code: opts.code ?? "", barcode: opts.barcode ?? "", ...(opts.search || {}) }, page: opts.page ?? 0, limit: opts.limit ?? 20 });
    return expectSuccess(await this.client.post<StatusResponse & { items: Record<string, unknown>[]; total_count?: string | number }>("/products/fullsearch", body), "products.list");
  }

  async get(id: number | string, storeId = this.cfg().storeId) {
    return expectSuccess(await this.client.get<StatusResponse & { data: Record<string, unknown>; tags?: unknown[]; category?: unknown; compositeTable?: unknown; extrabarcodes?: unknown[] }>("/products/update", { id, store_id: storeId }), `products.get ${id}`);
  }

  async create(input: ProductInput) {
    const products = {
      id: 0, code: "", sku: input.sku ?? "", composite_count: 1, title: input.title, website_title: "", website_short_description: "", website_description: "",
      unit_id: String(input.unitId ?? this.cfg().unitId), service: input.kind ?? 1, off_part: 1, cost_off: 0, min_balance: "", discount_ignore: 0, is_sell_with: 0, required_to_sell: 0,
      sell_with_list: [], image_path: [""], barcode: input.barcode ?? "", weighable: 0, cost_id: "", note: input.note ?? "", status: 1, extra_quantity: 0,
      category_id: input.categoryId ?? this.cfg().productCategoryId, fiscal_artucul: "", expiration_date: "", storage_conditions: "", website_synch: 0, website_category: [], useAutocorrect: 0,
      rozetka_options: {}, extrabarcodes: [], serial_on: 0, serial_required_sell: 0, warranty_period: 0, warranty_type: 2, warranty_print: 0, mods_on: 0,
      product_owner_id: 0, short_title: "", min_store_split: 0, compositeTable: {}, ...(input.fields || {}),
    };
    const prices = (input.prices || []).map((p) => ({ price_id: p.priceId, price: p.price, currency: { id: p.currencyId ?? this.cfg().currencyId } }));
    const resp = expectSuccess(await this.client.post<StatusResponse & { code?: number }>("/products/create", { Products: products, Tags: [], Prices: prices, direct: 0 }), "products.create");
    return { id: Number(resp.id), code: resp.code, raw: resp };
  }

  async update(id: number | string, changes: Record<string, unknown>, storeId = this.cfg().storeId) {
    const current = await this.get(id, storeId);
    const data = deepMerge(clone(current.data), changes);
    if (!("compositeTable" in data)) (data as Record<string, unknown>).compositeTable = current.compositeTable ?? {};
    return expectSuccess(await this.client.post<StatusResponse>("/products/update", { Products: data, Tags: current.tags || [], direct: 0 }, { id, store_id: storeId }), `products.update ${id}`);
  }

  async setPrice(id: number | string, priceId: number, price: number, storeId = this.cfg().storeId) { await this.client.post("/products/saveprice", { id, price_id: priceId, price, store_id: storeId }); return { ok: true }; }
  async prices(id: number | string, storeId = this.cfg().storeId) { return this.client.get<{ status?: string; prices?: Array<{ price_id: number; price: string }> }>("/products/prices", { id, store_id: storeId }); }
  async balances(id: number | string) { return this.client.post<unknown>("/products/productbalances", { id, product_id: id }); }

  async markDeleted(ids: Array<number | string>) { return expectSuccess(await this.client.post<StatusResponse>("/products/delete", { id: ids }), "products.markDeleted"); }
  async deletePermanent(ids: Array<number | string>) {
    const resp = await this.client.post<{ message_success?: string; message_error?: string }>("/products/deletepermanent", { id: ids });
    if (resp?.message_error) throw new DntradeError(`products.deletePermanent: ${resp.message_error}`, undefined, resp);
    return resp;
  }
  async delete(id: number | string) { await this.markDeleted([id]); return this.deletePermanent([id]); }

  // ---- категорії
  async categories() { return this.client.get<unknown>("/categories/getcategoriesroot"); }
  async createCategory(title: string, opts: { storeId?: number; parentId?: number; fields?: Record<string, unknown> } = {}) {
    const categories = { id: 0, title, root: { id: opts.parentId ?? 0, title: "" }, image: "", printer: "", sort_num: "", use_in_cashwindow: 1, website_export: 0, store_id: opts.storeId ?? this.cfg().storeId, akcuz: 0, akcuz_tax: "", apply_tax_letter_to_descendants: 0, spot2d: 0, uktzed: "", tax_percent: "", taxObject: "0", hasAcuzMarka: 0, askPrice: 0, ask_price_percent: 0, use_pdv: 0, pdv_letter: "", pdv: 0, mark_up: "", round_to: "1.00", update_products: 0, for_order: 0, integration_category: [], rozetka_brand: {}, ...(opts.fields || {}) };
    const resp = expectSuccess(await this.client.post<StatusResponse>("/categories/create", { Categories: categories, Tags: [] }), "products.createCategory");
    return { id: Number(resp.id), raw: resp };
  }
  async deleteCategory(id: number | string) { return expectSuccess(await this.client.post<StatusResponse>("/categories/delete", {}, { id }), `products.deleteCategory ${id}`); }
}
