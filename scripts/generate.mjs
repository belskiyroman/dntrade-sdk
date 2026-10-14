#!/usr/bin/env node
/**
 * Генерує з openapi/dntrade.openapi.yaml:
 *   src/generated/types.ts        — типи шляхів (openapi-typescript)
 *   src/generated/operations.json — індекс операцій для універсального виклику й пошуку (operationId -> метод, шлях, параметри)
 *   src/generated/invoice-defaults.json — форми Invoices за типами документів (з прикладів x-verified операцій або статичних схем)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import yaml from "js-yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SPEC = path.join(ROOT, "openapi", "dntrade.openapi.yaml");
const OUT = path.join(ROOT, "src", "generated");
fs.mkdirSync(OUT, { recursive: true });

// 1) типи
execFileSync(process.execPath, [path.join(ROOT, "node_modules", "openapi-typescript", "bin", "cli.js"), SPEC, "-o", path.join(OUT, "types.ts")], { stdio: "inherit" });

// 2) індекс операцій
const spec = yaml.load(fs.readFileSync(SPEC, "utf8"));
const ops = [];
for (const [p, methods] of Object.entries(spec.paths)) {
  for (const [m, op] of Object.entries(methods)) {
    if (!["get", "post", "put", "patch", "delete"].includes(m)) continue;
    const query = (op.parameters || []).filter((x) => x.in === "query").map((x) => ({ name: x.name, required: !!x.required, type: x.schema?.type || "string" }));
    const pathParams = (op.parameters || []).filter((x) => x.in === "path").map((x) => x.name);
    const body = op.requestBody?.content?.["application/json"]?.schema || op.requestBody?.content?.["application/x-www-form-urlencoded"]?.schema || null;
    const example = op.requestBody?.content?.["application/json"]?.example ?? null;
    const responseProps = Object.keys(op.responses?.["200"]?.content?.["application/json"]?.schema?.properties || {});
    ops.push({
      operationId: op.operationId, method: m.toUpperCase(), path: p, server: op.servers?.[0]?.url || null,
      tag: op.tags?.[0] || null, summary: op.summary || "", verified: !!op["x-verified"], sections: op["x-ui-sections"] || [],
      query, pathParams, bodyKeys: body?.properties ? Object.keys(body.properties) : [], bodyRequired: !!op.requestBody?.required && !!body,
      bodyExample: example, responseProps,
    });
  }
}
fs.writeFileSync(path.join(OUT, "operations.json"), JSON.stringify(ops, null, 1));

// 3) форми Invoices за типами документів: з прикладів (x-verified) у спеці береться структура першого прикладу;
//    статичні дефолти по розділах лежать у ../openapi/work/static (якщо є) — беремо звідти type-специфічні значення.
const defaults = {};
const staticDir = path.resolve(ROOT, "..", "openapi", "work", "static");
if (fs.existsSync(staticDir)) {
  const shapeDefaults = (shape, d = 0) => {
    if (!shape || d > 10) return null;
    if (shape.t === "object") return Object.fromEntries(Object.entries(shape.props).filter(([k]) => k !== "...").map(([k, v]) => [k, shapeDefaults(v, d + 1)]));
    if (shape.t === "array") return [];
    if (shape.t === "scalar") return "default" in shape ? shape.default : ({ integer: 0, number: 0, boolean: false }[shape.types[0]] ?? "");
    if (shape.t === "union") return shapeDefaults(shape.options[0], d + 1);
    return null;
  };
  for (const f of fs.readdirSync(staticDir).filter((x) => x.startsWith("invoices_") && x.endsWith(".json"))) {
    const page = JSON.parse(fs.readFileSync(path.join(staticDir, f), "utf8"));
    const call = page.calls.find((c) => c.method === "POST" && c.path === "/invoices/create" && c.body?.props?.Invoices);
    if (!call) continue;
    const inv = shapeDefaults(call.body.props.Invoices);
    if (inv && inv.type !== undefined && inv.type !== "") defaults[String(inv.type)] = { section: page.path, title: page.title, invoice: inv };
  }
}
const defaultsFile = path.join(OUT, "invoice-defaults.json");
if (Object.keys(defaults).length) fs.writeFileSync(defaultsFile, JSON.stringify(defaults, null, 1));
else if (!fs.existsSync(defaultsFile)) throw new Error("Немає ../openapi/work/static і немає збереженого invoice-defaults.json");
else console.log("invoice-defaults.json: залишено збережену версію (статичні дані пайплайну недоступні)");
console.log(JSON.stringify({ operations: ops.length, verified: ops.filter((o) => o.verified).length, invoiceTypes: Object.keys(defaults).map(Number).sort((a, b) => a - b) }));
