/**
 * Клієнт API: типізований клієнт openapi-fetch + універсальний виклик будь-якої операції специфікації за operationId
 * + пошук операцій за текстом (для агентів).
 */
import createClient, { type Client } from "openapi-fetch";
import type { paths } from "./generated/types.js";
import operationsJson from "./generated/operations.json" with { type: "json" };
import { DntradeSession, DntradeError, resolveSessionFile } from "./session.js";
import { clone } from "./form.js";

export interface OperationQueryParam { name: string; required: boolean; type: string }
export interface OperationInfo {
  operationId: string; method: string; path: string; server: string | null; tag: string | null; summary: string;
  verified: boolean; sections: string[]; query: OperationQueryParam[]; pathParams: string[];
  bodyKeys: string[]; bodyRequired: boolean; bodyExample: unknown; responseProps: string[];
}
export const operations: OperationInfo[] = operationsJson as OperationInfo[];
const byId = new Map(operations.map((o) => [o.operationId, o]));

export function getOperation(operationId: string): OperationInfo {
  const op = byId.get(operationId);
  if (!op) throw new DntradeError(`Невідома операція: ${operationId}. Пошук: findOperations("...")`);
  return op;
}

/** Приклад тіла запиту з реального виклику (копія), якщо операцію підтверджено записом. */
export function operationExample<T = Record<string, unknown>>(operationId: string): T | null {
  const op = byId.get(operationId);
  return op?.bodyExample ? clone(op.bodyExample as T) : null;
}

export interface FindOptions { verifiedOnly?: boolean; tag?: string; limit?: number }
/** Пошук операцій за словами з operationId, шляху, назви, тегу, розділів інтерфейсу. */
export function findOperations(text: string, opts: FindOptions = {}): OperationInfo[] {
  const words = text.toLowerCase().split(/[\s,/]+/).filter(Boolean);
  const scored = operations
    .filter((o) => (!opts.verifiedOnly || o.verified) && (!opts.tag || o.tag === opts.tag))
    .map((o) => {
      const hay = `${o.operationId} ${o.path} ${o.summary} ${o.tag} ${o.sections.join(" ")}`.toLowerCase();
      let score = 0;
      for (const w of words) { if (o.operationId.toLowerCase().includes(w)) score += 3; else if (o.path.toLowerCase().includes(w)) score += 2; else if (hay.includes(w)) score += 1; }
      if (o.verified) score += 0.5;
      return { o, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, opts.limit ?? 20).map((x) => x.o);
}

export interface CallOptions { query?: Record<string, unknown>; body?: unknown; path?: Record<string, string | number>; contentType?: "json" | "form" }

export class DntradeClient {
  /** Типізований клієнт openapi-fetch (шляхи й схеми зі специфікації). Token підставляється з сесії на кожен запит. */
  readonly typed: Client<paths>;

  constructor(public readonly session: DntradeSession) {
    this.typed = createClient<paths>({
      baseUrl: session.apiBase,
      fetch: async (request: Request) => {
        const headers = new Headers(request.headers);
        headers.set("Token", session.token);
        headers.set("Accept", "application/json");
        return fetch(new Request(request, { headers }));
      },
    });
  }

  /** Завантажити сесію з файлу (DNTRADE_SESSION_FILE або .dntrade-session.json поруч). */
  static load(file: string = resolveSessionFile(), opts: { relogin?: boolean } = {}): DntradeClient {
    return new DntradeClient(DntradeSession.load(file, opts));
  }

  /** Універсальний виклик операції специфікації за operationId. */
  async call<T = unknown>(operationId: string, opts: CallOptions = {}): Promise<T> {
    const op = getOperation(operationId);
    if (op.server) throw new DntradeError(`${operationId} належить кабінету navkolo (${op.server}); використовуйте dntrade login`);
    let apiPath = op.path;
    for (const p of op.pathParams) {
      const v = opts.path?.[p];
      if (v === undefined) throw new DntradeError(`${operationId}: потрібен параметр шляху ${p}`);
      apiPath = apiPath.replace(`{${p}}`, encodeURIComponent(String(v)));
    }
    const missing = op.query.filter((q) => q.required && (opts.query?.[q.name] === undefined || opts.query?.[q.name] === ""));
    if (missing.length) throw new DntradeError(`${operationId}: обов'язкові параметри запиту: ${missing.map((q) => q.name).join(", ")}`);
    return this.session.request<T>(op.method, apiPath, { query: opts.query, body: opts.body, contentType: opts.contentType });
  }

  get<T = unknown>(apiPath: string, query?: Record<string, unknown>): Promise<T> { return this.session.request<T>("GET", apiPath, { query }); }
  post<T = unknown>(apiPath: string, body?: unknown, query?: Record<string, unknown>): Promise<T> { return this.session.request<T>("POST", apiPath, { body, query }); }
}

/** Типовий конверт відповіді DNTrade. */
export interface StatusResponse { status?: "success" | "error" | string; title?: string; message?: string; id?: number; number?: number; ask_direct?: string; [k: string]: unknown }

export function expectSuccess<T extends StatusResponse>(resp: T, context: string): T {
  if (!resp || typeof resp !== "object") throw new DntradeError(`${context}: порожня відповідь`);
  if (resp.status === "error" || (resp as { message_error?: string }).message_error) {
    const msg = [resp.title, resp.message || (resp as { message_error?: string }).message_error, resp.ask_direct].filter(Boolean).join(": ");
    throw new DntradeError(`${context}: ${msg || "status=error"}`, undefined, resp);
  }
  return resp;
}
