/**
 * Офлайн-перевірка файлів документів на локальному мок-сервері (без мережі й без акаунта):
 * формат multipart (files[], doc_id, doc_type, Token), список, завантаження з Content-Disposition,
 * видалення, ліміт 10 МБ, обмеження DNTRADE_FILES_ROOT, визначення типу документа.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { Dntrade, DntradeSession, DntradeError } from "../src/index.js";

import { startMock } from "./mock-docfiles.js";

const { server, port, store, seen } = await startMock();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dntrade-files-test-"));
try {
  const session = new DntradeSession({ api_base: `http://127.0.0.1:${port}`, token: "test-token", tenant_url: "http://tenant" }, { file: null, relogin: false });
  const dn = new Dntrade(session);
  const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

  // 1) завантаження: шлях на диску + текст + base64-зображення, кирилиця в імені
  const pdfPath = path.join(tmp, "Рахунок №1.pdf");
  const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), crypto.randomBytes(4096)]);
  fs.writeFileSync(pdfPath, pdf);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const up = await dn.files.upload(18, 41, [pdfPath, { name: "нотатка.txt", data: "Привіт, замовлення 41", encoding: "utf8" }, { name: "photo.png", data: png.toString("base64"), encoding: "base64" }]);
  assert.equal(up.uploaded.length, 3);
  const uploadReq = seen.find((x) => x.path === "/docfiles/upload")!;
  assert.match(uploadReq.contentType || "", /^multipart\/form-data; boundary=/);
  assert.equal(uploadReq.token, "test-token");
  assert.deepEqual(store.map((f) => [f.doc_id, f.doc_type, f.title, f.type]), [["41", "18", "Рахунок №1.pdf", "application/pdf"], ["41", "18", "нотатка.txt", "text/plain"], ["41", "18", "photo.png", "image/png"]]);
  console.log("ok upload: multipart files[] + doc_id + doc_type, 3 файли, імена і MIME збережено");

  // 2) список і автоматичне визначення типу документа
  const listed = await dn.files.listForDocument(41);
  assert.equal(listed.length, 3);
  console.log("ok listForDocument: тип 18 визначено за id, файлів", listed.length);

  // 3) завантаження з диска: байти збігаються, ім'я з Content-Disposition
  const pdfFile = listed.find((f) => f.title === "Рахунок №1.pdf")!;
  const pdfId = pdfFile.id;
  assert.match(String(pdfId), /^[0-9a-f-]{36}$/);
  const saved = await dn.files.downloadTo(pdfFile, tmp + path.sep + "out" + path.sep);
  assert.equal(sha(fs.readFileSync(saved.path)), sha(pdf));
  assert.equal(path.basename(saved.path), "Рахунок №1.pdf");
  assert.equal(saved.contentType, "application/pdf");
  const byIdOnly = await dn.files.download(pdfId);
  assert.equal(byIdOnly.fileName, `file-${pdfId}.pdf`);
  assert.equal(byIdOnly.id, pdfId);
  const txt = await dn.files.download(listed.find((f) => f.title === "нотатка.txt")!);
  assert.equal(txt.data.toString("utf8"), "Привіт, замовлення 41");
  assert.equal(txt.contentType, "text/plain");
  console.log("ok download: UUID-id, sha256 збігається, ім'я з title (сервер дає лише розширення), тип за розширенням");

  // 4) видалення і помилка на неіснуючий файл
  await dn.files.delete(pdfId);
  assert.equal((await dn.files.list(18, 41)).length, 2);
  await assert.rejects(dn.files.download(pdfId), (e: unknown) => e instanceof DntradeError && /Файл не знайдено/.test((e as Error).message));
  await assert.rejects(dn.files.delete(pdfId), DntradeError);
  console.log("ok delete: файл видалено, повторне видалення і завантаження дають DntradeError");

  // 5) ліміт 10 МБ — відхиляється до відправки
  const before = seen.length;
  await assert.rejects(dn.files.upload(18, 41, [{ name: "big.bin", data: new Uint8Array(10 * 1024 * 1024 + 1) }]), /10 МБ/);
  assert.equal(seen.filter((x, i) => i >= before && x.path === "/docfiles/upload").length, 0);
  console.log("ok ліміт 10 МБ: великий файл відхилено без запиту");

  // 6) DNTRADE_FILES_ROOT обмежує читання і запис
  process.env.DNTRADE_FILES_ROOT = path.join(tmp, "allowed");
  fs.mkdirSync(process.env.DNTRADE_FILES_ROOT, { recursive: true });
  await assert.rejects(dn.files.upload(18, 41, [pdfPath]), /DNTRADE_FILES_ROOT/);
  await assert.rejects(dn.files.downloadTo(listed[1], path.join(tmp, "elsewhere.txt")), /DNTRADE_FILES_ROOT/);
  const inside = await dn.files.downloadTo(listed[1], process.env.DNTRADE_FILES_ROOT + path.sep);
  assert.ok(inside.path.startsWith(process.env.DNTRADE_FILES_ROOT));
  delete process.env.DNTRADE_FILES_ROOT;
  console.log("ok DNTRADE_FILES_ROOT: шляхи поза текою відхилено");

  // 7) непідтримуваний docType -> зрозуміла помилка зі списком підтримуваних
  await assert.rejects(dn.files.list(1008, 1), (e: unknown) => e instanceof DntradeError && /не підтримуються для docType 1008/.test((e as Error).message) && /18 Замовлення клієнта/.test((e as Error).message));
  console.log("ok непідтримуваний docType: зрозуміла помилка");

  // 8) недійсний Token без автологіну -> DntradeAuthError
  const bad = new Dntrade(new DntradeSession({ api_base: `http://127.0.0.1:${port}`, token: "wrong", tenant_url: "http://tenant" }, { file: null, relogin: false }));
  await assert.rejects(bad.files.list(18, 41), (e: unknown) => (e as Error).name === "DntradeAuthError");
  console.log("ok недійсний Token: DntradeAuthError");
  console.log("ALL OK");
} finally {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
