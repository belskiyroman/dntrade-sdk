/**
 * Серіалізація тіла у стилі vue-resource (emulateJSON) / PHP: a[b]=v, a[0][b]=v, a[]=v,
 * null -> "", boolean -> "true"/"false", порожні масиви й об'єкти пропускаються.
 * Сервер DNTrade приймає і application/json з тією самою структурою, тому form-варіант потрібен рідко.
 */
export function phpFormEncode(value: unknown): string {
  const pairs: string[] = [];
  const add = (key: string, v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(s)}`);
  };
  const walk = (v: unknown, scope: string) => {
    if (Array.isArray(v)) {
      v.forEach((item, i) => (item !== null && typeof item === "object" ? walk(item, `${scope}[${i}]`) : add(`${scope}[]`, item)));
    } else if (v !== null && typeof v === "object") {
      for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
        const key = scope ? `${scope}[${k}]` : k;
        if (item !== null && typeof item === "object") walk(item, key);
        else add(key, item);
      }
    } else {
      add(scope, v);
    }
  };
  walk(value, "");
  return pairs.join("&");
}

/** Формат дати документів DNTrade: DD-MM-YYYY HH:mm:ss (локальний час). */
export function formatDate(date: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(date.getDate())}-${p(date.getMonth() + 1)}-${date.getFullYear()} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

export function deepMerge<T extends Record<string, unknown>>(target: T, changes: Record<string, unknown>): T {
  for (const [k, v] of Object.entries(changes)) {
    const cur = (target as Record<string, unknown>)[k];
    if (v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur)) {
      deepMerge(cur as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      (target as Record<string, unknown>)[k] = v;
    }
  }
  return target;
}

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
