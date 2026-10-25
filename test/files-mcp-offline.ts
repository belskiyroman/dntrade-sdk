/** Офлайн-перевірка MCP-інструментів файлів через stdio-клієнта на мок-сервері; автологін вимкнено. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startMock } from "./mock-docfiles.js";

const { server, port, store } = await startMock();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dntrade-mcp-files-"));
const sessionFile = path.join(tmp, "session.json");
fs.writeFileSync(sessionFile, JSON.stringify({ api_base: `http://127.0.0.1:${port}`, token: "test-token", tenant_url: "http://tenant", bearer: null, cookies: [] }));
const here = path.dirname(new URL(import.meta.url).pathname);
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(DNTRADE_|NAVKOLO_)/.test(k)) env[k] = v;
Object.assign(env, { DNTRADE_SESSION_FILE: sessionFile, DNTRADE_ENV_FILE: path.join(tmp, "no.env"), DNTRADE_FILES_ROOT: tmp });
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(here, "..", "node_modules", "tsx", "dist", "cli.mjs"), path.join(here, "..", "src", "mcp", "server.ts")], env, cwd: tmp });
const client = new Client({ name: "files-mcp-offline", version: "0.1.0" });
const textOf = (r: unknown) => (((r as { content?: unknown }).content ?? []) as Array<{ type: string; text?: string }>).filter((c) => c.type === "text").map((c) => c.text).join("\n");
try {
  await client.connect(transport);
  const names = (await client.listTools()).tools.map((t) => t.name);
  for (const t of ["dntrade_file_doc_types", "dntrade_list_files", "dntrade_upload_files", "dntrade_download_file", "dntrade_delete_file"]) assert.ok(names.includes(t), t);
  console.log("ok tools:", names.length, "(файлові інструменти присутні)");

  const localPath = path.join(tmp, "договір.txt");
  fs.writeFileSync(localPath, "текст договору");
  const up = await client.callTool({ name: "dntrade_upload_files", arguments: { docId: 77, files: [{ path: localPath }, { name: "a.json", text: "{\"a\":1}" }, { name: "b.png", contentBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" }] } });
  assert.ok(!up.isError, textOf(up));
  assert.equal(JSON.parse(textOf(up)).uploaded.length, 3);
  assert.deepEqual(store.map((f) => [f.doc_id, f.doc_type]), [["77", "18"], ["77", "18"], ["77", "18"]]);
  console.log("ok dntrade_upload_files: path + text + base64, docType визначено автоматично (18)");

  const list = JSON.parse(textOf(await client.callTool({ name: "dntrade_list_files", arguments: { docId: 77 } })));
  assert.equal(list.files.length, 3);
  const pngId = list.files.find((f: { title: string }) => f.title === "b.png").id;
  const txtId = list.files.find((f: { title: string }) => f.title === "договір.txt").id;
  console.log("ok dntrade_list_files:", list.files.map((f: { title: string }) => f.title).join(", "));

  const dlTxt = await client.callTool({ name: "dntrade_download_file", arguments: { fileId: txtId, docId: 77, inline: true } });
  const dlTxtText = textOf(dlTxt);
  assert.ok(dlTxtText.includes("текст договору"), dlTxtText);
  const meta = JSON.parse(dlTxtText.split("\n}")[0] + "\n}");
  assert.ok(fs.existsSync(meta.path) && meta.path.startsWith(tmp));
  assert.equal(path.basename(meta.path), "договір.txt");
  const dlPng = await client.callTool({ name: "dntrade_download_file", arguments: { fileId: pngId, docId: 77, inline: true } });
  assert.ok((dlPng.content as Array<{ type: string }>).some((c) => c.type === "image"));
  console.log("ok dntrade_download_file: збережено в DNTRADE_FILES_ROOT, текст і зображення повернуто inline");

  const del = await client.callTool({ name: "dntrade_delete_file", arguments: { fileId: pngId } });
  assert.ok(!del.isError, textOf(del));
  assert.equal(store.length, 2);
  const outside = await client.callTool({ name: "dntrade_upload_files", arguments: { docId: 77, files: [{ path: "/etc/hosts" }] } });
  assert.ok(outside.isError && /DNTRADE_FILES_ROOT/.test(textOf(outside)));
  console.log("ok dntrade_delete_file; шлях поза DNTRADE_FILES_ROOT відхилено");
  console.log("ALL OK");
} finally {
  await client.close().catch(() => undefined);
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
