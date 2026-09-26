import client from 'prom-client';

export const MAX_API_CURATED_ASSETS = 50;

export const apiCardinalityViolationsTotal = new client.Counter({
  name: 'api_cardinality_violations_total',
  help: 'Total times an unapproved label value was sanitized in API metrics',
  labelNames: ['metric', 'label', 'rejected_value'],
});

const defaultAllowedAssets = new Set([
  'XLM', 'USDC', 'EURC', 'BTC', 'ETH', 'AQUA', 'yXLM', 'yUSDC'
]);

let activeApiAllowedAssets: Set<string> = defaultAllowedAssets;

export function setApiAllowedAssets(assets: string[]): void {
  activeApiAllowedAssets = new Set(assets.map((a) => a.toUpperCase()));
}

export function sanitizeApiAssetLabel(asset: string, allowed?: Set<string>): string {
  if (!asset) return 'other';
  const norm = asset.trim().toUpperCase();
  const set = allowed || activeApiAllowedAssets;

  if (!set.has(norm)) {
    apiCardinalityViolationsTotal.inc({
      metric: 'price_queries_total',
      label: 'asset',
      rejected_value: norm.slice(0, 32),
    });
    return 'other';
  }
  return norm;
}

export function validateApiCardinalityConfig(configuredAssets: string[]): { valid: boolean; error?: string } {
  if (configuredAssets.length > MAX_API_CURATED_ASSETS) {
    return {
      valid: false,
      error: `Configured API assets count (${configuredAssets.length}) exceeds maximum limit (${MAX_API_CURATED_ASSETS})`,
    };
  }
  return { valid: true };
}
