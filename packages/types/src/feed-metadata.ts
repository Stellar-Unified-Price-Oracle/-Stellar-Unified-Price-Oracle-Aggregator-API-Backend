export const FRESHNESS_PROFILES = {
  realtime: { warnSeconds: 10, maxAgeSeconds: 30 },
  standard: { warnSeconds: 60, maxAgeSeconds: 120 },
  delayed: { warnSeconds: 300, maxAgeSeconds: 600 },
} as const;

export type FreshnessProfileName = keyof typeof FRESHNESS_PROFILES;
export const QUOTE_CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD'] as const;
export type QuoteCurrency = (typeof QUOTE_CURRENCIES)[number];
export type QuoteRounding = 'half-up' | 'half-even' | 'down';
export interface QuoteUnit {
  currency: QuoteCurrency;
  denomination: `${QuoteCurrency}_PER_ASSET_UNIT`;
  scaleDecimals: number;
  displayDecimals: number;
  rounding: QuoteRounding;
}
export const DEFAULT_QUOTE_UNIT: QuoteUnit = {
  currency: 'USD', denomination: 'USD_PER_ASSET_UNIT', scaleDecimals: 8, displayDecimals: 4, rounding: 'half-even',
};

export function validateQuoteUnit(unit: Partial<QuoteUnit>): string[] {
  const errors: string[] = [];
  if (unit.currency !== undefined && !QUOTE_CURRENCIES.includes(unit.currency)) errors.push('currency is not supported');
  if (unit.currency !== undefined && unit.denomination !== `${unit.currency}_PER_ASSET_UNIT`) errors.push('denomination must match currency per asset unit');
  if (unit.scaleDecimals !== undefined && (!Number.isInteger(unit.scaleDecimals) || unit.scaleDecimals < 0 || unit.scaleDecimals > 18)) errors.push('scaleDecimals must be an integer between 0 and 18');
  if (unit.displayDecimals !== undefined && (!Number.isInteger(unit.displayDecimals) || unit.displayDecimals < 0 || unit.displayDecimals > 12 || unit.scaleDecimals !== undefined && unit.displayDecimals > unit.scaleDecimals)) errors.push('displayDecimals must be between 0 and 12 and no greater than scaleDecimals');
  if (unit.rounding !== undefined && !(['half-up', 'half-even', 'down'] as string[]).includes(unit.rounding)) errors.push('rounding mode is unsupported');
  return errors;
}

/** Shared fallback assignments used by the aggregator, API, and monitors. */
export const FEED_FRESHNESS_ASSIGNMENTS: Readonly<Record<string, FreshnessProfileName>> = {
  XLM: 'standard',
  USDC: 'standard',
  BTC: 'standard',
  ETH: 'standard',
  USDT: 'standard',
};

export function freshnessThresholdSeconds(asset: string, fallbackSeconds = 120): number {
  const profile = FEED_FRESHNESS_ASSIGNMENTS[asset.trim().toUpperCase()];
  return profile ? FRESHNESS_PROFILES[profile].maxAgeSeconds : fallbackSeconds;
}

export function freshnessWarningSeconds(asset: string, fallbackSeconds = 60): number {
  const profile = FEED_FRESHNESS_ASSIGNMENTS[asset.trim().toUpperCase()];
  return profile ? FRESHNESS_PROFILES[profile].warnSeconds : fallbackSeconds;
}

export function isFeedStale(asset: string, ageSeconds: number, fallbackSeconds = 120): boolean {
  return ageSeconds > freshnessThresholdSeconds(asset, fallbackSeconds);
}
