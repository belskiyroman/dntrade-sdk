/**
 * Перевірка автологіну: псує Token і JWT у копії файлу сесії, виконує запит читання —
 * SDK має сам увійти за DNTRADE_LOGIN/DNTRADE_PASSWORD з .env і зберегти нову сесію у копію.
 * Оригінальний файл сесії не чіпає. Запускати людині (вхід з паролем).
 */
import fs from "node:fs";
import path from "node:path";
import { Dntrade, DntradeSession, resolveSessionFile, credentialsFromEnv, loadDotenv } from "../src/index.js";

const envFile = loadDotenv();
if (!credentialsFromEnv()) { console.error("Немає DNTRADE_LOGIN/DNTRADE_PASSWORD (оточення або .env)"); process.exit(2); }
console.log(".env:", envFile || "(змінні з оточення)");
const original = resolveSessionFile();
const copy = path.join(path.dirname(original), ".dntrade-session.autologin-check.json");

// 1) сесії немає взагалі -> вхід при першому запиті
if (fs.existsSync(copy)) fs.unlinkSync(copy);
const dn1 = new Dntrade(DntradeSession.load(copy));
const stores1 = (await dn1.references.get("stores")) as Array<{ id: number }>;
console.log("1) без файлу сесії -> вхід -> склади:", stores1.length, "| збережено:", fs.existsSync(copy));

// 2) Token і JWT зіпсовані -> resso неможливий -> повний вхід
const data = JSON.parse(fs.readFileSync(copy, "utf8"));
data.token = "x".repeat(32); data.bearer = "a.b.c"; data.cookies = [];
fs.writeFileSync(copy, JSON.stringify(data), { mode: 0o600 });
const dn2 = new Dntrade(DntradeSession.load(copy));
const stores2 = (await dn2.references.get("stores")) as Array<{ id: number }>;
console.log("2) зіпсовані Token+JWT -> вхід -> склади:", stores2.length, "| status:", JSON.stringify(dn2.session.status()));
fs.unlinkSync(copy);
console.log("OK: автологін працює; тестова копія сесії видалена. Увага: нові SSO-входи анулювали Token у основному файлі сесії, виконайте dntrade resso або login.");
