/** Довідники: організації, склади, типи цін, валюти, користувачі, каси, підрозділи, рахунки, категорії, одиниці, види витрат. */
import { DntradeClient } from "../client.js";

export const REFERENCE_KINDS = {
  organizations: { method: "GET", path: "/organizations/getuserlist", pick: null },
  stores: { method: "GET", path: "/stores/getuserstores", pick: "stores" },
  price_types: { method: "GET", path: "/products/getuserprices", pick: "data" },
  currencies: { method: "GET", path: "/currency/getlist", pick: "data" },
  users: { method: "GET", path: "/user/getuserlist", pick: "users" },
  cashboxes: { method: "GET", path: "/checkboxes/getlist", pick: null },
  subdivisions: { method: "GET", path: "/subdivision/getlistbyorganization", pick: null },
  accounts: { method: "GET", path: "/accounts/getlistbyorganization", pick: null },
  partner_categories: { method: "GET", path: "/catpartner/getpartnercategories", pick: "data" },
  product_categories: { method: "GET", path: "/categories/getcategoriesroot", pick: "categories" },
  units: { method: "GET", path: "/products/getunits", pick: "data" },
  costs: { method: "GET", path: "/costs/getlist", pick: "data" },
  profit_kinds: { method: "GET", path: "/profitlist/getlist", pick: null },
  channels: { method: "GET", path: "/channels/getchannels", pick: null },
  order_statuses: { method: "GET", path: "/orderstatuses/all", pick: null },
} as const;
export type ReferenceKind = keyof typeof REFERENCE_KINDS;

export class References {
  constructor(private readonly client: DntradeClient) {}
  async get(kind: ReferenceKind, query?: Record<string, unknown>): Promise<unknown> {
    const def = REFERENCE_KINDS[kind];
    const resp = await this.client.session.request<Record<string, unknown> | unknown[]>(def.method, def.path, { query });
    if (def.pick && resp && !Array.isArray(resp) && def.pick in resp) return (resp as Record<string, unknown>)[def.pick];
    return resp;
  }
}
