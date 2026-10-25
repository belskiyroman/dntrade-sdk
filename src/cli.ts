#!/usr/bin/env node
/**
 * CLI: dntrade login [файл-з-логіном-і-паролем] | status | resso | find <текст> | call <operationId> [--query '{...}'] [--body '{...}'] | types
 */
import { loginAndSave, DntradeSession, readCredentials, resolveSessionFile, credentialsFromEnv, loadDotenv, DntradeError } from "./session.js";
import { findOperations, getOperation } from "./client.js";
import { Dntrade } from "./index.js";
import { DOCUMENT_TYPES } from "./resources/invoices.js";
import { DOC_FILE_TYPES } from "./resources/files.js";

function arg(name: string): string | undefined { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; }

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  const file = resolveSessionFile();
  switch (cmd) {
    case "login": {
      const creds = readCredentials(rest[0] && !rest[0].startsWith("--") ? rest[0] : undefined);
      const s = await loginAndSave(creds, file);
      console.log("Сесію збережено:", file, "| кабінет:", s.tenantUrl, "| API:", s.apiBase);
      return 0;
    }
    case "status": console.log(JSON.stringify({ ...DntradeSession.load(file, { relogin: false }).status(), envFile: loadDotenv() || process.env.DNTRADE_ENV_FILE || null, autoLogin: !!credentialsFromEnv() }, null, 2)); return 0;
    case "resso": { const s = DntradeSession.load(file, { relogin: false }); await s.resso(); console.log(JSON.stringify(s.status(), null, 2)); return 0; }
    case "find": {
      for (const o of findOperations(rest.join(" "), { limit: Number(arg("--limit") || 20) })) console.log(`${o.verified ? "+" : "-"} ${o.operationId.padEnd(36)} ${o.method} ${o.path}  — ${o.summary}`);
      return 0;
    }
    case "call": {
      const op = getOperation(rest[0]);
      const dn = Dntrade.load(file);
      const query = arg("--query") ? JSON.parse(arg("--query")!) : undefined;
      const body = arg("--body") ? JSON.parse(arg("--body")!) : (op.bodyRequired ? {} : undefined);
      console.log(JSON.stringify(await dn.call(rest[0], { query, body }), null, 2));
      return 0;
    }
    case "types": for (const [k, v] of Object.entries(DOCUMENT_TYPES)) console.log(k.padStart(4), v); return 0;
    case "files": {
      const sub = rest[0];
      const dn = Dntrade.load(file);
      const typeArg = arg("--type") ? Number(arg("--type")) : undefined;
      const positional = rest.slice(1).filter((x, i, all) => !x.startsWith("--") && !(i > 0 && all[i - 1].startsWith("--")));
      if (sub === "types") { for (const [k, v] of Object.entries(DOC_FILE_TYPES)) console.log(k.padStart(5), v); return 0; }
      if (sub === "list") { const t = await dn.files.resolveType(positional[0], typeArg); console.log(JSON.stringify({ docType: t, files: await dn.files.list(t, positional[0]) }, null, 2)); return 0; }
      if (sub === "upload") { const t = await dn.files.resolveType(positional[0], typeArg); const r = await dn.files.upload(t, positional[0], positional.slice(1)); console.log(JSON.stringify({ docType: t, uploaded: r.uploaded, messageError: r.messageError }, null, 2)); return 0; }
      if (sub === "download") {
        let target: string | { id: string; title: string } = positional[0];
        if (arg("--doc")) { const t = await dn.files.resolveType(arg("--doc")!, typeArg); target = (await dn.files.find(t, arg("--doc")!, positional[0])) || target; }
        const r = await dn.files.downloadTo(target, arg("--out") || "./", { fileName: arg("--name") });
        console.log(JSON.stringify({ path: r.path, size: r.size, contentType: r.contentType }, null, 2)); return 0;
      }
      if (sub === "delete") { console.log(JSON.stringify(await dn.files.delete(positional[0]), null, 2)); return 0; }
      console.log("dntrade files list <docId> [--type N] | upload <docId> <шлях...> [--type N] | download <fileId> [--doc docId [--type N]] [--name імʼя] [--out шлях] | delete <fileId> | types");
      return 2;
    }
    case "defaults": { const dn = Dntrade.load(file); console.log(JSON.stringify({ fromEnv: Dntrade.load(file).config, discovered: await dn.discoverDefaults() }, null, 2)); return 0; }
    default:
      console.log("dntrade login [файл] (або DNTRADE_LOGIN/DNTRADE_PASSWORD у .env) | status | resso | find <текст> | call <operationId> [--query json] [--body json] | types | defaults | files list|upload|download|delete|types");
      return cmd ? 2 : 0;
  }
}
main().then((code) => process.exit(code)).catch((e: unknown) => { console.error(e instanceof DntradeError ? `Помилка: ${e.message}` : e); process.exit(1); });
