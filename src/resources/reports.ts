/** Звіти (/reports/*): тіло запиту береться з підтверджених прикладів, період задається dateFrom/dateTo. */
import { DntradeClient, operationExample, getOperation } from "../client.js";
import { DntradeError } from "../session.js";
import { deepMerge } from "../form.js";

export const REPORT_KINDS = {
  sell: { op: "reportsGetsellreport", title: "Аналіз продаж" },
  balance: { op: "reportsGetbalancereport", title: "Залишки на складі" },
  gross_profit: { op: "reportsGetgrossprofit", title: "Валовий прибуток" },
  profit_and_loss: { op: "reportsGetprofitandloss", title: "Прибутки та витрати (P&L)" },
  cashflow: { op: "reportsGetcashflowreport", title: "Рух коштів" },
  cash: { op: "reportsGetcashreport", title: "Звіт по касі" },
  partners: { op: "reportsGetpartnersreport", title: "Взаєморозрахунки з контрагентами" },
  payments: { op: "reportsGetpaymentsreport", title: "Звіт по рахункам" },
  costs: { op: "reportsCostsreport", title: "Звіт по витратам" },
  oldest: { op: "reportsGetoldest", title: "Залежаний товар" },
  relize: { op: "reportsGetrelize", title: "Аналіз товарів по постачальнику" },
  structural_unit: { op: "reportsGetstructuralunitreport", title: "Звіт по змінам" },
} as const;
export type ReportKind = keyof typeof REPORT_KINDS;

const toStart = (d: string) => (d.length === 10 ? `${d} 00:00:00` : d);
const toEnd = (d: string) => (d.length === 10 ? `${d} 23:59:59` : d);

export class Reports {
  constructor(private readonly client: DntradeClient) {}
  /** dateFrom/dateTo у форматі DD-MM-YYYY (або з часом). search — довільні перевизначення фільтра. */
  async run(kind: ReportKind, opts: { dateFrom?: string; dateTo?: string; search?: Record<string, unknown>; body?: Record<string, unknown> } = {}) {
    const def = REPORT_KINDS[kind];
    if (!def) throw new DntradeError(`Невідомий звіт ${kind}. Доступні: ${Object.keys(REPORT_KINDS).join(", ")}`);
    const op = getOperation(def.op);
    const body = operationExample<Record<string, unknown>>(def.op) || { search: {} };
    const search: Record<string, unknown> = { ...(opts.search || {}) };
    if (opts.dateFrom || opts.dateTo) {
      const cur = ((body.search as Record<string, unknown>)?.date as Record<string, string>) || {};
      search.date = { start: opts.dateFrom ? toStart(opts.dateFrom) : cur.start, end: opts.dateTo ? toEnd(opts.dateTo) : cur.end };
      if ("date_from" in ((body.search as Record<string, unknown>) || {})) { search.date_from = opts.dateFrom ?? ""; search.date_to = opts.dateTo ?? ""; }
    }
    deepMerge(body, { search, ...(opts.body || {}) });
    return this.client.session.request<unknown>(op.method, op.path, { body });
  }
}
