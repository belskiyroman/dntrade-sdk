#!/usr/bin/env node
/**
 * CLI: dntrade login [файл-з-логіном-і-паролем] | status | resso | find <текст> | call <operationId> [--query '{...}'] [--body '{...}'] | types
 */
import { loginAndSave, DntradeSession, readCredentials, resolveSessionFile, credentialsFromEnv, loadDotenv, DntradeError } from "./session.js";
import { findOperations, getOperation } from "./client.js";
import { Dntrade } from "./index.js";
import { DOCUMENT_TYPES } from "./resources/invoices.js";

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
    case "defaults": { const dn = Dntrade.load(file); console.log(JSON.stringify({ fromEnv: Dntrade.load(file).config, discovered: await dn.discoverDefaults() }, null, 2)); return 0; }
    default:
      console.log("dntrade login [файл] (або DNTRADE_LOGIN/DNTRADE_PASSWORD у .env) | status | resso | find <текст> | call <operationId> [--query json] [--body json] | types | defaults");
      return cmd ? 2 : 0;
  }
}
main().then((code) => process.exit(code)).catch((e: unknown) => { console.error(e instanceof DntradeError ? `Помилка: ${e.message}` : e); process.exit(1); });
