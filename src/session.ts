/**
 * Сесія DNTrade: вхід через кабінет navkolo, SSO у тенант, Token для API app1.dntrade.com.ua.
 *
 * Ланцюжок (так само робить браузер):
 *   1. POST https://my.navkolo.one/api/v1/login {login, password}            -> JWT (bearer, ~2.8 год) + refresh_token
 *   2. GET  /api/v1/dn-trade/get-success-registration (Authorization: Bearer) -> одноразове посилання SSO
 *   3. GET  <посилання> (з редиректами)                                       -> cookie-сесія тенанта https://<tenant>.dntrade.com.ua
 *   4. GET  <tenant>/invoices/out?iframe=1                                     -> у HTML baseUrl API і "Token"
 *
 * У DNTrade один активний Token на користувача: новий SSO-вхід (у т.ч. відкриття модуля в браузері) анулює
 * попередній. Тому сесія зберігається у файлі і перевстановлюється без пароля (resso), поки живий JWT navkolo.
 * Формат файлу сумісний з .dntrade-session.json Python-обгортки.
 */
import fs from "node:fs";
import path from "node:path";
import { phpFormEncode } from "./form.js";

export const NAVKOLO_WEB_API = "https://my.navkolo.one/api/v1";
export const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
function findUpwards(name: string, maxLevels = 4): string | null {
  let dir = process.cwd();
  for (let i = 0; i < maxLevels; i++) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Розбір .env (KEY=VALUE, лапки, коментарі). Повертає лише пари, яких ще немає у process.env. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      const end = value.indexOf(quote, 1);
      value = end > 0 ? value.slice(1, end) : value.slice(1);
      if (quote === '"') value = value.replace(/\\n/g, "\n");
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    out[m[1]] = value;
  }
  return out;
}

let dotenvLoaded = false;
/** Завантажує .env (DNTRADE_ENV_FILE, інакше .env у поточній теці або до трьох тек вище) у process.env; існуючі змінні не перезаписує. */
export function loadDotenv(file?: string): string | null {
  if (dotenvLoaded && !file) return null;
  dotenvLoaded = true;
  const p = file || process.env.DNTRADE_ENV_FILE || findUpwards(".env");
  if (!p || !fs.existsSync(p)) return null;
  for (const [k, v] of Object.entries(parseDotenv(fs.readFileSync(p, "utf8")))) if (process.env[k] === undefined) process.env[k] = v;
  return p;
}

/** Облікові дані для автоматичного входу: DNTRADE_LOGIN/DNTRADE_PASSWORD (або NAVKOLO_*) з оточення чи .env. */
export function credentialsFromEnv(): { login: string; password: string } | null {
  loadDotenv();
  const login = process.env.DNTRADE_LOGIN || process.env.NAVKOLO_LOGIN;
  const password = process.env.DNTRADE_PASSWORD || process.env.NAVKOLO_PASSWORD;
  return login && password ? { login, password } : null;
}

/** Файл сесії: DNTRADE_SESSION_FILE, інакше .dntrade-session.json у поточній теці або до трьох тек вище, інакше ~/.dntrade/session.json. */
export function resolveSessionFile(): string {
  loadDotenv();
  if (process.env.DNTRADE_SESSION_FILE) return path.resolve(process.env.DNTRADE_SESSION_FILE);
  let dir = process.cwd();
  for (let i = 0; i < 4; i++) {
    const candidate = path.join(dir, ".dntrade-session.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const home = process.env.HOME || process.env.USERPROFILE || process.cwd();
  return path.join(home, ".dntrade", "session.json");
}
export const DEFAULT_SESSION_FILE = resolveSessionFile();

export class DntradeError extends Error {
  constructor(message: string, public readonly status?: number, public readonly body?: unknown) {
    super(message);
    this.name = "DntradeError";
  }
}
export class DntradeAuthError extends DntradeError {
  constructor(message: string, status?: number, body?: unknown) {
    super(message, status, body);
    this.name = "DntradeAuthError";
  }
}

export interface CookieRecord { name: string; value: string; domain: string; path: string; secure: boolean; expires: number | null }
export interface SessionData {
  api_base: string; token: string; tenant_url: string;
  bearer?: string | null; refresh_token?: string | null; cookies?: CookieRecord[]; saved_at?: string;
}

// ------------------------------------------------------------------ cookies (мінімальний jar для SSO-редиректів)
export class CookieJar {
  private cookies = new Map<string, CookieRecord>();
  static fromList(list: CookieRecord[] = []): CookieJar { const jar = new CookieJar(); for (const c of list) jar.cookies.set(`${c.domain}|${c.path}|${c.name}`, c); return jar; }
  toList(): CookieRecord[] { return [...this.cookies.values()]; }
  get size(): number { return this.cookies.size; }
  setFromResponse(url: string, setCookie: string[]): void {
    const host = new URL(url).hostname;
    for (const line of setCookie) {
      const [pair, ...attrs] = line.split(";");
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      const rec: CookieRecord = { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), domain: host, path: "/", secure: false, expires: null };
      for (const a of attrs) {
        const [k, v = ""] = a.trim().split("=");
        const key = k.toLowerCase();
        if (key === "domain" && v) rec.domain = v.replace(/^\./, "");
        else if (key === "path" && v) rec.path = v;
        else if (key === "secure") rec.secure = true;
        else if (key === "expires" && v) { const t = Date.parse(v); if (!Number.isNaN(t)) rec.expires = Math.floor(t / 1000); }
        else if (key === "max-age" && v) rec.expires = Math.floor(Date.now() / 1000) + Number(v);
      }
      this.cookies.set(`${rec.domain}|${rec.path}|${rec.name}`, rec);
    }
  }
  headerFor(url: string): string {
    const u = new URL(url);
    const now = Math.floor(Date.now() / 1000);
    return [...this.cookies.values()]
      .filter((c) => (u.hostname === c.domain || u.hostname.endsWith("." + c.domain)) && u.pathname.startsWith(c.path) && (!c.secure || u.protocol === "https:") && (c.expires === null || c.expires > now))
      .map((c) => `${c.name}=${c.value}`).join("; ");
  }
}

async function fetchWithCookies(jar: CookieJar, url: string, init: RequestInit = {}, maxRedirects = 10): Promise<{ response: Response; finalUrl: string }> {
  let current = url;
  for (let i = 0; i <= maxRedirects; i++) {
    const headers = new Headers(init.headers || {});
    headers.set("User-Agent", USER_AGENT);
    const cookie = jar.headerFor(current);
    if (cookie) headers.set("Cookie", cookie);
    const response = await fetch(current, { ...init, headers, redirect: "manual" });
    jar.setFromResponse(current, response.headers.getSetCookie());
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const loc = response.headers.get("location");
      if (!loc) return { response, finalUrl: current };
      await response.arrayBuffer().catch(() => undefined);
      current = new URL(loc, current).toString();
      init = { ...init, method: "GET", body: undefined };
      continue;
    }
    return { response, finalUrl: current };
  }
  throw new DntradeAuthError("Забагато редиректів під час SSO");
}

// ------------------------------------------------------------------ navkolo
export async function navkoloLogin(login: string, password: string): Promise<{ token: string; refresh_token?: string }> {
  const res = await fetch(`${NAVKOLO_WEB_API}/login`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": USER_AGENT }, body: JSON.stringify({ login, password }) });
  if (!res.ok) throw new DntradeAuthError(`Вхід у my.navkolo.one не вдався: HTTP ${res.status}`, res.status);
  const body = (await res.json()) as { token?: string; refresh_token?: string };
  if (!body.token) throw new DntradeAuthError("Вхід у my.navkolo.one не повернув token");
  return { token: body.token, refresh_token: body.refresh_token };
}

export async function navkoloSsoLink(bearer: string): Promise<string> {
  const res = await fetch(`${NAVKOLO_WEB_API}/dn-trade/get-success-registration`, { headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json", "User-Agent": USER_AGENT } });
  if (res.status === 401 || res.status === 403) throw new DntradeAuthError("JWT my.navkolo.one недійсний або прострочений: виконайте login", res.status);
  if (!res.ok) throw new DntradeAuthError(`Не вдалося отримати посилання SSO: HTTP ${res.status}`, res.status);
  const body = (await res.json()) as { status?: string; link?: string; errorMessage?: string } | null;
  if (body === null) throw new DntradeAuthError("Модуль «navkolo.торгівля» не підключений до цього акаунта: на my.navkolo.one/dashboard натисніть «Підключити продукт» і відкрийте модуль кнопкою «Перейти»");
  if (!body.link || body.status !== "success") throw new DntradeAuthError(`Інтеграція dn_trade не готова (статус ${body.status}): ${body.errorMessage || "відкрийте модуль у кабінеті один раз"}`);
  return body.link;
}

export function extractToken(html: string): { apiBase: string | null; token: string | null } {
  const base = html.match(/baseUrl:\s*'([^']+)'/);
  const token = html.match(/"Token":\s*"([^"]+)"/);
  return { apiBase: base ? base[1].replace(/\/$/, "") : null, token: token ? token[1] : null };
}

export async function openDntrade(bearer: string): Promise<SessionData> {
  const jar = new CookieJar();
  const link = await navkoloSsoLink(bearer);
  const { response, finalUrl } = await fetchWithCookies(jar, link, { headers: { Accept: "text/html" } });
  await response.arrayBuffer().catch(() => undefined);
  const u = new URL(finalUrl);
  const tenantUrl = `${u.protocol}//${u.host}`;
  const page = await fetchWithCookies(jar, `${tenantUrl}/invoices/out?iframe=1`, { headers: { Accept: "text/html" } });
  const { apiBase, token } = extractToken(await page.response.text());
  if (!apiBase || !token) throw new DntradeAuthError("На сторінці /invoices/out не знайдено baseUrl або Token: SSO не спрацював");
  return { api_base: apiBase, token, tenant_url: tenantUrl, cookies: jar.toList() };
}

/** Файл облікових даних: необов'язковий рядок з URL, далі логін і пароль по одному в рядку (як ./navkolo). */
export function readCredentials(file?: string): { login: string; password: string } {
  if (!file) {
    const env = credentialsFromEnv();
    if (env) return env;
  }
  const p = file || process.env.NAVKOLO_CREDENTIALS_FILE || process.env.DNTRADE_CREDENTIALS_FILE || path.resolve(process.cwd(), "navkolo");
  if (!fs.existsSync(p)) throw new DntradeAuthError(`Немає облікових даних: задайте DNTRADE_LOGIN/DNTRADE_PASSWORD (оточення або .env) або файл ${p}`);
  const lines = fs.readFileSync(p, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).filter((l) => !/^https?:\/\//i.test(l));
  if (lines.length < 2) throw new DntradeAuthError(`У файлі ${p} очікую два рядки: логін і пароль`);
  return { login: lines[0], password: lines[1] };
}

function jwtExp(token?: string | null): number | null {
  try { const payload = token!.split(".")[1]; return (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: number }).exp ?? null; } catch { return null; }
}

// ------------------------------------------------------------------ сесія
export interface RequestOptions {
  query?: Record<string, unknown>;
  body?: unknown;
  /** "form" (типово: так само, як фронтенд; порожні масиви й об'єкти не передаються) або "json" (сервер приймає, але
   *  деякі операції, напр. products/create, падають на порожніх об'єктах у JSON). */
  contentType?: "json" | "form";
  /** Повернути сирий результат замість розібраного JSON. */
  raw?: boolean;
  timeoutMs?: number;
}
export interface RawResult { status: number; headers: Headers; text: string }

export class DntradeSession {
  apiBase: string; token: string; tenantUrl: string; bearer: string | null; refreshToken: string | null;
  jar: CookieJar;
  readonly file: string | null;
  relogin: boolean;
  timeoutMs: number;
  private ressoDone = false;

  constructor(data: SessionData, opts: { file?: string | null; relogin?: boolean; timeoutMs?: number } = {}) {
    this.apiBase = (data.api_base || "").replace(/\/$/, "");
    this.token = data.token;
    this.tenantUrl = (data.tenant_url || "").replace(/\/$/, "");
    this.bearer = data.bearer ?? null;
    this.refreshToken = data.refresh_token ?? null;
    this.jar = CookieJar.fromList(data.cookies || []);
    this.file = opts.file === undefined ? DEFAULT_SESSION_FILE : opts.file;
    this.relogin = opts.relogin ?? true;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  /** Завантажує сесію з файлу. Якщо файлу немає, але є DNTRADE_LOGIN/DNTRADE_PASSWORD, повертає порожню сесію, яка увійде при першому запиті. */
  static load(file: string = DEFAULT_SESSION_FILE, opts: { relogin?: boolean; timeoutMs?: number } = {}): DntradeSession {
    if (!fs.existsSync(file)) {
      if (credentialsFromEnv()) return new DntradeSession({ api_base: "", token: "", tenant_url: "" }, { file, ...opts });
      throw new DntradeAuthError(`Немає збереженої сесії ${file}. Виконайте dntrade login або задайте DNTRADE_LOGIN/DNTRADE_PASSWORD у .env`);
    }
    return new DntradeSession(JSON.parse(fs.readFileSync(file, "utf8")) as SessionData, { file, ...opts });
  }

  /** Повний вхід за логіном і паролем (оточення/.env або передані) і збереження сесії. */
  async login(credentials?: { login: string; password: string }): Promise<void> {
    const creds = credentials || credentialsFromEnv();
    if (!creds) throw new DntradeAuthError("Немає облікових даних для входу: задайте DNTRADE_LOGIN/DNTRADE_PASSWORD (оточення або .env)");
    const tokens = await navkoloLogin(creds.login, creds.password);
    const fresh = await openDntrade(tokens.token);
    this.apiBase = fresh.api_base; this.token = fresh.token; this.tenantUrl = fresh.tenant_url; this.jar = CookieJar.fromList(fresh.cookies);
    this.bearer = tokens.token; this.refreshToken = tokens.refresh_token ?? null;
    this.save();
  }

  /** Гарантує робочу сесію: без Token — вхід за .env. */
  async ensure(): Promise<void> {
    if (!this.token) {
      if (!credentialsFromEnv()) throw new DntradeAuthError("Немає Token: виконайте dntrade login або задайте DNTRADE_LOGIN/DNTRADE_PASSWORD у .env");
      process.stderr.write("[dntrade] сесії немає: вхід за DNTRADE_LOGIN/DNTRADE_PASSWORD\n");
      await this.login();
    }
  }

  toJSON(): SessionData {
    return { api_base: this.apiBase, token: this.token, tenant_url: this.tenantUrl, bearer: this.bearer, refresh_token: this.refreshToken, cookies: this.jar.toList(), saved_at: new Date().toISOString() };
  }
  save(): void {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.toJSON()), { mode: 0o600 });
    fs.chmodSync(this.file, 0o600);
  }
  status() {
    const exp = jwtExp(this.bearer);
    return { tenantUrl: this.tenantUrl, apiBase: this.apiBase, tokenLength: this.token?.length ?? 0, cookies: this.jar.size, bearerExpires: exp ? new Date(exp * 1000).toISOString() : null, bearerValid: !!exp && exp * 1000 > Date.now(), file: this.file };
  }

  /** Перевстановлює cookie і Token за збереженим JWT navkolo (без пароля). */
  async resso(): Promise<void> {
    if (!this.bearer) throw new DntradeAuthError("У сесії немає JWT navkolo: виконайте dntrade login");
    const fresh = await openDntrade(this.bearer);
    this.apiBase = fresh.api_base; this.token = fresh.token; this.tenantUrl = fresh.tenant_url; this.jar = CookieJar.fromList(fresh.cookies);
    this.save();
  }
  /** Відновлення після 401/403: спершу повторний SSO за JWT navkolo, якщо JWT прострочений або його немає — повний вхід за .env. Один раз на сесію. */
  private async maybeResso(reason: string): Promise<boolean> {
    if (!this.relogin || this.ressoDone) return false;
    this.ressoDone = true;
    const exp = jwtExp(this.bearer);
    const bearerLooksValid = !!this.bearer && (!exp || exp * 1000 > Date.now() + 60_000);
    if (bearerLooksValid) {
      try {
        process.stderr.write(`[dntrade] ${reason}: повторний SSO за JWT navkolo\n`);
        await this.resso();
        return true;
      } catch (e) {
        if (!(e instanceof DntradeAuthError) || !credentialsFromEnv()) throw e;
        process.stderr.write(`[dntrade] повторний SSO не вдався (${e.message}); вхід за логіном і паролем\n`);
      }
    } else if (!credentialsFromEnv()) {
      throw new DntradeAuthError(`${reason}: JWT navkolo прострочений, виконайте dntrade login або задайте DNTRADE_LOGIN/DNTRADE_PASSWORD у .env`);
    } else {
      process.stderr.write(`[dntrade] ${reason}: JWT navkolo прострочений, вхід за логіном і паролем\n`);
    }
    await this.login();
    return true;
  }

  /** Запит до API app1. Повертає розібраний JSON (або RawResult при raw=true). 401/403 -> один повторний SSO. */
  async request<T = unknown>(method: string, apiPath: string, opts: RequestOptions = {}): Promise<T> {
    await this.ensure();
    let url = this.apiBase + apiPath;
    if (opts.query && Object.keys(opts.query).length) url += (url.includes("?") ? "&" : "?") + phpFormEncode(opts.query);
    const headers: Record<string, string> = { Token: this.token, Accept: "application/json", "User-Agent": USER_AGENT };
    let body: string | undefined;
    if (opts.body !== undefined && method !== "GET") {
      if ((opts.contentType ?? "form") === "json") { headers["Content-Type"] = "application/json"; body = JSON.stringify(opts.body); }
      else { headers["Content-Type"] = "application/x-www-form-urlencoded"; body = phpFormEncode(opts.body); }
    }
    const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs) });
    const text = await res.text();
    // Недійсний Token: 401/403, або 404 «Введений домен не зареєстрований» (домен тенанта зашитий у Token)
    const authFailure = res.status === 401 || res.status === 403 || (res.status === 404 && /домен не зареєстрован/i.test(text));
    if (authFailure && (await this.maybeResso(`HTTP ${res.status} ${method} ${apiPath}`))) return this.request<T>(method, apiPath, opts);
    if (opts.raw) return { status: res.status, headers: res.headers, text } as unknown as T;
    if (authFailure) throw new DntradeAuthError(`HTTP ${res.status} ${method} ${apiPath}: сесія недійсна, виконайте dntrade login або задайте DNTRADE_LOGIN/DNTRADE_PASSWORD у .env`, res.status, text.slice(0, 300));
    if (!res.ok) throw new DntradeError(`HTTP ${res.status} ${method} ${apiPath}: ${text.slice(0, 300)}`, res.status, text.slice(0, 1000));
    if (!text.trim()) return null as T; // деякі операції (products/saveprice) відповідають порожнім тілом
    try { return JSON.parse(text) as T; } catch { throw new DntradeError(`${method} ${apiPath}: відповідь не JSON (можливо, сесія закінчилась): ${text.slice(0, 200)}`, res.status, text.slice(0, 1000)); }
  }

  /** GET сторінки тенанта з cookie-сесією. */
  async fetchPage(tenantPath: string): Promise<string> {
    await this.ensure();
    const { response, finalUrl } = await fetchWithCookies(this.jar, this.tenantUrl + tenantPath, { headers: { Accept: "text/html" } });
    const html = await response.text();
    const lost = finalUrl.includes("/site/login") || (html.includes('name="LoginForm') && !html.includes("$http"));
    if (lost) {
      if (await this.maybeResso("сесію тенанта втрачено")) return this.fetchPage(tenantPath);
      throw new DntradeAuthError("Сесія тенанта DNTrade недійсна: виконайте dntrade login");
    }
    return html;
  }
}

/** Повний вхід з паролем (кроки 1-4) і збереження сесії. Запускає людина, не агент. */
export async function loginAndSave(credentials?: { login: string; password: string }, file: string = DEFAULT_SESSION_FILE): Promise<DntradeSession> {
  const { login, password } = credentials || readCredentials();
  const tokens = await navkoloLogin(login, password);
  const data = await openDntrade(tokens.token);
  const session = new DntradeSession({ ...data, bearer: tokens.token, refresh_token: tokens.refresh_token ?? null }, { file });
  session.save();
  return session;
}
