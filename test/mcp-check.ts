/** Перевірка MCP-сервера через stdio-клієнта: список інструментів і два виклики лише на читання. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(here, "..", "node_modules", "tsx", "dist", "cli.mjs"), path.join(here, "..", "src", "mcp", "server.ts")], env: { ...process.env } as Record<string, string> });
const client = new Client({ name: "mcp-check", version: "0.1.0" });
await client.connect(transport);
const tools = await client.listTools();
console.log("tools:", tools.tools.length, tools.tools.map((t) => t.name).join(", "));
for (const [name, args] of [["dntrade_session_status", {}], ["dntrade_references", { kind: "stores" }], ["dntrade_find_operations", { query: "invoices fullsearch", limit: 3 }], ["dntrade_document_types", {}]] as const) {
  const r = await client.callTool({ name, arguments: args as Record<string, unknown> });
  const first = (r.content as Array<{ type: string; text?: string }>)[0];
  console.log(`${name} -> ${r.isError ? "ERROR " : ""}${(first.text || "").replace(/\s+/g, " ").slice(0, 160)}`);
}
await client.close();
