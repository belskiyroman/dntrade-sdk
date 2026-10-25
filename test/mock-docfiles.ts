/** Мок API /docfiles/* та /invoices/update для офлайн-тестів (Token: test-token). */
import http from "node:http";

export type Stored = { id: string; doc_id: string; doc_type: string; title: string; type: string; data: Buffer };
export const store: Stored[] = [];
let nextId = 500;
const uuid = () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`;
export const seen: Array<{ path: string; token: string | undefined; contentType: string | undefined }> = [];

export function createMockServer() {
const server = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks);
  const url = new URL(req.url || "/", "http://x");
  seen.push({ path: url.pathname, token: req.headers.token as string | undefined, contentType: req.headers["content-type"] });
  const json = (o: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
  if (req.headers.token !== "test-token") return json({ message: "Unauthorized" }, 401);
  const form = async () => new Request("http://x", { method: "POST", headers: { "content-type": req.headers["content-type"] || "" }, body: raw }).formData();
  const urlencoded = () => new URLSearchParams(raw.toString("utf8"));
  switch (url.pathname) {
    case "/invoices/update": return json({ status: "success", data: { id: Number(url.searchParams.get("id")), type: 18 }, products: [] });
    case "/docfiles/getlist": {
      const items = store.filter((f) => f.doc_id === url.searchParams.get("doc_id") && f.doc_type === url.searchParams.get("doc_type"));
      return json({ status: "success", data: items.map((f) => ({ id: f.id, title: f.title, size: `${f.data.length} B`, date: "25-10-2026 10:00", user: "Тест", preview: f.type.startsWith("image/") ? f.type : null })) });
    }
    case "/docfiles/upload": {
      const fd = await form();
      const files = fd.getAll("files[]") as File[];
      for (const f of files) store.push({ id: uuid(), doc_id: String(fd.get("doc_id")), doc_type: String(fd.get("doc_type")), title: f.name, type: f.type, data: Buffer.from(await f.arrayBuffer()) });
      return json({ status: "success", title: "Успіх", message_success: `Завантажено файлів: ${files.length}`, message_error: "" });
    }
    case "/docfiles/download": {
      const f = store.find((x) => String(x.id) === urlencoded().get("id"));
      if (!f) return json({ status: "error", title: "Помилка", message: "Файл не знайдено" }, 404);
      // як справжній сервер: лише розширення в імені і загальний тип
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${f.title.slice(f.title.lastIndexOf("."))}"` });
      return res.end(f.data);
    }
    case "/docfiles/delete": {
      const i = store.findIndex((x) => String(x.id) === urlencoded().get("id"));
      if (i < 0) return json({ status: "error", title: "Помилка", message: "Файл не знайдено" });
      store.splice(i, 1);
      return json({ status: "success", title: "Успіх", message: "Файл видалено" });
    }
  }
  return json({ status: "error", message: "unknown" }, 404);
});
return server;
}

export async function startMock(): Promise<{ server: http.Server; port: number; store: typeof store; seen: typeof seen }> {
  const server = createMockServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as { port: number }).port, store, seen };
}
