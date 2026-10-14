/**
 * Параметри акаунта, які потрібні документам і довідникам (організація, склад, каса, рахунок, типи цін, валюта,
 * користувач, одиниця виміру, категорії). SDK не прив'язаний до конкретного акаунта: значення беруться з оточення
 * (DNTRADE_*), інакше визначаються через API (`discoverDefaults`), інакше використовуються типові для нового
 * кабінету DNTrade (усі id = 1, роздрібний тип цін 2, одиниця «шт» 33).
 */
import { loadDotenv } from "./session.js";

export interface DntradeConfig {
  organizationId: number; storeId: number; cashboxId: number; accountId: number;
  priceId: number; purchasePriceId: number; currencyId: number; userId: number; unitId: number;
  partnerCategoryId: number; productCategoryId: number;
}

export const ENV_KEYS: Record<keyof DntradeConfig, string> = {
  organizationId: "DNTRADE_ORGANIZATION_ID", storeId: "DNTRADE_STORE_ID", cashboxId: "DNTRADE_CASHBOX_ID", accountId: "DNTRADE_ACCOUNT_ID",
  priceId: "DNTRADE_PRICE_ID", purchasePriceId: "DNTRADE_PURCHASE_PRICE_ID", currencyId: "DNTRADE_CURRENCY_ID", userId: "DNTRADE_USER_ID",
  unitId: "DNTRADE_UNIT_ID", partnerCategoryId: "DNTRADE_PARTNER_CATEGORY_ID", productCategoryId: "DNTRADE_PRODUCT_CATEGORY_ID",
};

export const BUILTIN_DEFAULTS: DntradeConfig = {
  organizationId: 1, storeId: 1, cashboxId: 1, accountId: 1, priceId: 2, purchasePriceId: 1, currencyId: 1, userId: 1, unitId: 33,
  partnerCategoryId: 1, productCategoryId: 1,
};

/** Конфіг з оточення/.env поверх вбудованих значень (і переданих перевизначень). */
export function configFromEnv(overrides: Partial<DntradeConfig> = {}): DntradeConfig {
  loadDotenv();
  const cfg: DntradeConfig = { ...BUILTIN_DEFAULTS };
  for (const key of Object.keys(ENV_KEYS) as Array<keyof DntradeConfig>) {
    const raw = process.env[ENV_KEYS[key]];
    if (raw !== undefined && raw !== "" && Number.isFinite(Number(raw))) cfg[key] = Number(raw);
  }
  return { ...cfg, ...overrides };
}

/** Які ключі задані явно в оточенні (їх не перекриває автовизначення). */
export function envDefinedKeys(): Array<keyof DntradeConfig> {
  loadDotenv();
  return (Object.keys(ENV_KEYS) as Array<keyof DntradeConfig>).filter((k) => process.env[ENV_KEYS[k]] !== undefined && process.env[ENV_KEYS[k]] !== "");
}
