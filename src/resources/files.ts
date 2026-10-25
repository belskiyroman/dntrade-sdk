/**
 * Файли, прикріплені до документів і записів довідників (/docfiles/*).
 * Файл прив'язується до пари (docType, docId): docType — код розділу (для документів товарообліку дорівнює типу
 * документа: 18 замовлення клієнта, 17 замовлення постачальнику, 3 видаткова накладна ...; довідники: 1001 контрагенти,
 * 1000 товари тощо — див. DOC_FILE_TYPES). Обмеження сервера: до 10 МБ на файл.
 */
import fs from "node:fs";
import path from "node:path";
import { DntradeClient, expectSuccess, type StatusResponse } from "../client.js";
import { DntradeError } from "../session.js";
import docFileTypesJson from "../generated/doc-file-types.json" with { type: "json" };

export const MAX_FILE_SIZE = 10 * 1024 * 1024;

/** Коди docType для файлів (DOCUMENT_TYPE розділу інтерфейсу), згенеровано зі специфікації (info.x-doc-file-types). */
export const DOC_FILE_TYPES: Record<number, string> = Object.fromEntries(Object.entries(docFileTypesJson as Record<string, string>).map(([k, v]) => [Number(k), v]));
/** Типи замовлень: 18 замовлення клієнта, 17 замовлення у постачальника, 201 замовлення на виробництво. */
export const ORDER_TYPES = { client: 18, supplier: 17, production: 201 } as const;

/** Файл: id — рядок UUID; size у вигляді інтерфейсу ("2.04 Кб"); date DD-MM-YYYY HH:mm. */
export interface DocFile { id: string; title: string; size?: string | number; date?: string; user?: string; preview?: string | null; [k: string]: unknown }

/** Вхідний файл: шлях на диску або вміст у пам'яті. */
export type FileInput =
  | string
  | { path: string; name?: string; contentType?: string }
  | { name: string; data: Uint8Array | ArrayBuffer | Blob | string; contentType?: string; encoding?: "base64" | "utf8" };

const MIME: Record<string, string> = {
  ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".txt": "text/plain", ".csv": "text/csv", ".json": "application/json", ".xml": "application/xml", ".html": "text/html",
  ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".zip": "application/zip",
};
export const guessContentType = (name: string) => MIME[path.extname(name).toLowerCase()] || "application/octet-stream";

/** Необов'язкове обмеження: якщо задано DNTRADE_FILES_ROOT, читати/писати файли можна лише всередині цієї теки. */
export function assertAllowedPath(p: string): string {
  const resolved = path.resolve(p);
  const root = process.env.DNTRADE_FILES_ROOT ? path.resolve(process.env.DNTRADE_FILES_ROOT) : null;
  if (root && resolved !== root && !resolved.startsWith(root + path.sep)) throw new DntradeError(`Шлях ${resolved} поза DNTRADE_FILES_ROOT (${root})`);
  return resolved;
}

async function toBlobPart(input: FileInput): Promise<{ name: string; blob: Blob }> {
  if (typeof input === "string" || "path" in input) {
    const p = assertAllowedPath(typeof input === "string" ? input : input.path);
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new DntradeError(`Файл не знайдено: ${p}`);
    const name = (typeof input === "string" ? undefined : input.name) || path.basename(p);
    const type = (typeof input === "string" ? undefined : input.contentType) || guessContentType(name);
    return { name, blob: new Blob([Uint8Array.from(fs.readFileSync(p))], { type }) };
  }
  const type = input.contentType || guessContentType(input.name);
  if (input.data instanceof Blob) return { name: input.name, blob: input.data.type ? input.data : new Blob([input.data], { type }) };
  if (typeof input.data === "string") {
    const bytes = input.encoding === "base64" ? Buffer.from(input.data, "base64") : Buffer.from(input.data, "utf8");
    return { name: input.name, blob: new Blob([Uint8Array.from(bytes)], { type }) };
  }
  const bytes = input.data instanceof ArrayBuffer ? new Uint8Array(input.data) : Uint8Array.from(input.data);
  return { name: input.name, blob: new Blob([bytes], { type }) };
}

export interface UploadResult { uploaded: DocFile[]; messageSuccess?: string; messageError?: string; raw: StatusResponse }
export interface DownloadResult { id: string; fileName: string; contentType: string | null; size: number; data: Buffer }

export class DocFiles {
  constructor(private readonly client: DntradeClient) {}

  /** Список файлів запису: id, title, size, date, user, preview. */
  async list(docType: number, docId: number | string): Promise<DocFile[]> {
    const resp = await this.client.get<StatusResponse & { data?: DocFile[] }>("/docfiles/getlist", { doc_id: docId, doc_type: docType });
    expectSuccess(resp, `files.list ${docType}/${docId}`);
    return Array.isArray(resp.data) ? resp.data : [];
  }

  /** Завантажити один або кілька файлів (до 10 МБ кожен). Повертає щойно додані файли (за різницею списку). */
  async upload(docType: number, docId: number | string, files: FileInput[]): Promise<UploadResult> {
    if (!files.length) throw new DntradeError("files.upload: не передано жодного файлу");
    const parts = await Promise.all(files.map(toBlobPart));
    const tooBig = parts.filter((p) => p.blob.size > MAX_FILE_SIZE);
    if (tooBig.length) throw new DntradeError(`files.upload: розмір файлу не повинен перевищувати 10 МБ: ${tooBig.map((p) => `${p.name} (${(p.blob.size / 1048576).toFixed(1)} МБ)`).join(", ")}`);
    const before = new Set((await this.list(docType, docId)).map((f) => String(f.id)));
    const form = new FormData();
    for (const p of parts) form.append("files[]", p.blob, p.name);
    form.append("doc_id", String(docId));
    form.append("doc_type", String(docType));
    const resp = await this.client.session.request<StatusResponse & { message_success?: string; message_error?: string }>("POST", "/docfiles/upload", { body: form, contentType: "multipart" });
    expectSuccess({ ...resp, message_error: undefined } as StatusResponse, "files.upload");
    const after = await this.list(docType, docId);
    const uploaded = after.filter((f) => !before.has(String(f.id)));
    if (!uploaded.length && resp?.message_error) throw new DntradeError(`files.upload: ${String(resp.message_error).replace(/<[^>]+>/g, " ").trim()}`, undefined, resp);
    return { uploaded, messageSuccess: resp?.message_success, messageError: resp?.message_error || undefined, raw: resp };
  }

  /**
   * Вміст файлу. Сервер повертає в Content-Disposition лише розширення (".pdf") і тип application/octet-stream,
   * тому ім'я береться з DocFile.title (передайте об'єкт зі списку або fileName), а тип — за розширенням.
   */
  async download(file: string | number | DocFile, opts: { fileName?: string } = {}): Promise<DownloadResult> {
    const id = typeof file === "object" ? String(file.id) : String(file);
    const r = await this.client.session.requestBinary("POST", "/docfiles/download", { body: { id } });
    const serverName = r.fileName && !/^\.[^.]*$/.test(path.basename(r.fileName)) ? path.basename(r.fileName) : null;
    // path.extname(".pdf") === "" (вважається прихованим файлом), тому «.pdf» як ім'я трактуємо як розширення
    const base = r.fileName ? path.basename(r.fileName) : "";
    const ext = path.extname(base) || (/^\.[^.]+$/.test(base) ? base : "");
    const fileName = opts.fileName || (typeof file === "object" ? file.title : null) || serverName || `file-${id}${ext}`;
    const generic = !r.contentType || /^(application\/octet-stream|binary\/octet-stream)/i.test(r.contentType);
    const contentType = generic ? guessContentType(fileName) : r.contentType;
    return { id, fileName, contentType, size: r.data.length, data: r.data };
  }

  /** Зберегти файл на диск. Якщо target — тека (або закінчується на /), використовується ім'я файлу. */
  async downloadTo(file: string | number | DocFile, target: string, opts: { fileName?: string } = {}): Promise<DownloadResult & { path: string }> {
    const result = await this.download(file, opts);
    let out = assertAllowedPath(target);
    if (target.endsWith("/") || target.endsWith(path.sep) || (fs.existsSync(out) && fs.statSync(out).isDirectory())) out = path.join(out, path.basename(result.fileName));
    assertAllowedPath(out);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, result.data);
    return { ...result, path: out };
  }

  /** Знайти файл за id у списку запису (щоб знати його ім'я). */
  async find(docType: number, docId: number | string, fileId: string | number): Promise<DocFile | null> {
    return (await this.list(docType, docId)).find((f) => String(f.id) === String(fileId)) ?? null;
  }

  /** Тип документа товарообліку за його id (GET /invoices/update). */
  async documentType(docId: number | string): Promise<number> {
    const resp = await this.client.get<StatusResponse & { data?: { type?: number | string } }>("/invoices/update", { id: docId });
    expectSuccess(resp, `files.documentType ${docId}`);
    const t = Number(resp.data?.type);
    if (!Number.isFinite(t) || t <= 0) throw new DntradeError(`files.documentType: не вдалося визначити тип документа ${docId}`);
    return t;
  }
  /** docType, якщо передано, інакше тип документа товарообліку за id. */
  async resolveType(docId: number | string, docType?: number): Promise<number> { return docType ?? this.documentType(docId); }

  /** Файли документа товарообліку (тип визначається автоматично). */
  async listForDocument(docId: number | string): Promise<DocFile[]> { return this.list(await this.documentType(docId), docId); }
  /** Прикріпити файли до документа товарообліку (тип визначається автоматично), напр. до замовлення клієнта. */
  async uploadToDocument(docId: number | string, files: FileInput[]): Promise<UploadResult> { return this.upload(await this.documentType(docId), docId, files); }

  /** Видалити файл (незворотно). */
  async delete(fileId: string | number) {
    return expectSuccess(await this.client.post<StatusResponse>("/docfiles/delete", { id: fileId }), `files.delete ${fileId}`);
  }
}
