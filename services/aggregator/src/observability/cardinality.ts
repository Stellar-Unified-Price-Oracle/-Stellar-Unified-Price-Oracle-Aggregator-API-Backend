import client from 'prom-client';
import { register } from './metrics';

export const MAX_APPROVED_SOURCES = 10;
export const MAX_CURATED_ASSETS = 50;
export const MAX_SERIES_BUDGET = 6775;

export const KNOWN_SOURCES = new Set(['chainlink', 'redstone', 'band', 'reflector']);

export const cardinalityViolationsTotal = new client.Counter({
  name: 'cardinality_violations_total',
  help: 'Total times an unapproved label value was sanitized to prevent cardinality explosion',
  labelNames: ['metric', 'label', 'rejected_value'],
  registers: [register],
});

export const metricCardinalityEstimate = new client.Gauge({
  name: 'metric_cardinality_estimated_total',
  help: 'Estimated total series count for active configuration',
  registers: [register],
});

export interface CardinalityValidationResult {
  valid: boolean;
  estimatedTotalSeries: number;
  breakdown: Record<string, number>;
  errors: string[];
}

export function validateCardinalityBudget(
  sources: string[],
  assets: string[],
): CardinalityValidationResult {
  const errors: string[] = [];

  const sourceCount = sources.length;
  const assetCount = assets.length;

  if (sourceCount > MAX_APPROVED_SOURCES) {
    errors.push(
      `Source count (${sourceCount}) exceeds maximum allowed approved sources (${MAX_APPROVED_SOURCES})`,
    );
  }

  if (assetCount > MAX_CURATED_ASSETS) {
    errors.push(
      `Asset count (${assetCount}) exceeds maximum allowed curated assets (${MAX_CURATED_ASSETS})`,
    );
  }

  // Derive per-metric estimated series
  const bucketsLatency = 10;
  const statuses = 4;
  const contractFunctions = 4;

  const breakdown: Record<string, number> = {
    oracle_source_request_duration_seconds: sourceCount * assetCount * statuses * bucketsLatency,
    oracle_source_requests_total: sourceCount * statuses,
    oracle_source_sla_breaches_total: sourceCount,
    oracle_api_calls_total: sourceCount,
    oracle_api_cost_estimated_usd_total: sourceCount,
    oracle_api_budget_utilization_ratio: sourceCount,
    oracle_source_uptime_percent: sourceCount,
    onchain_price_staleness_seconds: assetCount,
    circuit_breaker_triggered_total: sourceCount * (assetCount + 1),
    contract_submission_gas: contractFunctions * assetCount * statuses * bucketsLatency,
    system_metrics_baseline: 350,
  };

  const estimatedTotalSeries = Object.values(breakdown).reduce((sum, v) => sum + v, 0);

  if (estimatedTotalSeries > MAX_SERIES_BUDGET) {
    errors.push(
      `Estimated series count (${estimatedTotalSeries}) exceeds maximum budget (${MAX_SERIES_BUDGET})`,
    );
  }

  return {
    valid: errors.length === 0,
    estimatedTotalSeries,
    breakdown,
    errors,
  };
}

export function enforceStartupCardinalityBudget(sources: string[], assets: string[]): void {
  const result = validateCardinalityBudget(sources, assets);
  metricCardinalityEstimate.set(result.estimatedTotalSeries);

  if (!result.valid) {
    const errorMsg = `[Startup Cardinality Admission Check FAILED]:\n${result.errors.map((e) => `  - ${e}`).join('\n')}`;
    throw new Error(errorMsg);
  }
}

let activeAllowedAssets: Set<string> | null = null;
let activeAllowedSources: Set<string> = KNOWN_SOURCES;

export function setAllowedAssets(assets: string[]): void {
  activeAllowedAssets = new Set(assets.map((a) => a.toUpperCase()));
}

export function setAllowedSources(sources: string[]): void {
  activeAllowedSources = new Set(sources.map((s) => s.toLowerCase()));
}

export function sanitizeAssetLabel(asset: string, allowedAssets?: string[]): string {
  if (!asset) return 'other';
  const norm = asset.trim().toUpperCase();
  const set = allowedAssets ? new Set(allowedAssets.map((a) => a.toUpperCase())) : activeAllowedAssets;

  if (set && !set.has(norm)) {
    cardinalityViolationsTotal.inc({
      metric: 'oracle_source_request_duration_seconds',
      label: 'asset',
      rejected_value: norm.slice(0, 32),
    });
    return 'other';
  }
  return norm;
}

export function sanitizeSourceLabel(source: string, allowedSources?: string[]): string {
  if (!source) return 'other';
  const norm = source.trim().toLowerCase();
  const set = allowedSources ? new Set(allowedSources.map((s) => s.toLowerCase())) : activeAllowedSources;

  if (set && !set.has(norm)) {
    cardinalityViolationsTotal.inc({
      metric: 'oracle_source_requests_total',
      label: 'source',
      rejected_value: norm.slice(0, 32),
    });
    return 'other';
  }
  return norm;
}
