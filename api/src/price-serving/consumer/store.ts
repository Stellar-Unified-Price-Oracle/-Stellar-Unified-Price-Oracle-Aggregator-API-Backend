import type {
  LatencySample,
  FeedLatencyFreshnessStats,
  PercentileSummary,
} from '@stellar-oracle/types';
import { usageAnalytics, type UsageEvent } from '../../services/usage-analytics';
import { logger } from '../../observability/logger';

const MAX_LATENCY_SAMPLES = 50_000;
const STALE_THRESHOLD_MS = 120_000;

const latencySamples: LatencySample[] = [];

export function recordLatencySample(sample: LatencySample): void {
  latencySamples.push({ ...sample, region: sample.region.toLowerCase() });
  if (latencySamples.length > MAX_LATENCY_SAMPLES) {
    latencySamples.splice(0, latencySamples.length - MAX_LATENCY_SAMPLES);
  }
}

export function consumerRegion(header: string | undefined, query: string | undefined): string {
  const region = header ?? query ?? 'global';
  return region.toLowerCase();
}

function querySamples(
  asset?: string,
  region?: string,
  from?: number,
  to?: number,
): LatencySample[] {
  const fromMs = from !== undefined ? from * 1000 : 0;
  const toMs = to !== undefined ? to * 1000 : Number.MAX_SAFE_INTEGER;
  const upperAsset = asset ? asset.toUpperCase() : undefined;
  const upperRegion = region ? region.toLowerCase() : undefined;

  return latencySamples.filter((s) => {
    if (upperAsset && s.asset.toUpperCase() !== upperAsset) return false;
    if (upperRegion && s.region !== upperRegion) return false;
    if (s.deliveredAt * 1000 < fromMs) return false;
    if (s.deliveredAt * 1000 > toMs) return false;
    return true;
  });
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower];
  const frac = rank - lower;
  return sorted[lower] * (1 - frac) + sorted[upper] * frac;
}

function summarize(values: number[]): PercentileSummary {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    mean: values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0,
    max: sorted.length > 0 ? sorted[sorted.length - 1] : 0,
    count: values.length,
  };
}

export function computeFeedStats(
  asset?: string,
  region?: string,
  from?: number,
  to?: number,
): FeedLatencyFreshnessStats[] {
  const samples = querySamples(asset, region, from, to);
  const now = Math.floor(Date.now() / 1000);
  const windowStart = from ?? Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
  const windowEnd = to ?? now;

  const grouped = new Map<string, LatencySample[]>();
  for (const s of samples) {
    const key = `${s.asset.toUpperCase()}|${s.region}`;
    const bucket = grouped.get(key) ?? [];
    bucket.push(s);
    grouped.set(key, bucket);
  }

  const stats: FeedLatencyFreshnessStats[] = [];
  for (const [key, bucket] of grouped.entries()) {
    const [assetName, regionName] = key.split('|');
    const latencyValues = bucket.map((s) => s.latencyMs);
    const freshnessValues = bucket.map((s) => s.freshnessMs);
    const staleCount = bucket.filter((s) => s.freshnessMs > STALE_THRESHOLD_MS).length;

    stats.push({
      asset: assetName,
      region: regionName,
      windowStart,
      windowEnd,
      sampleCount: bucket.length,
      latency: summarize(latencyValues),
      freshness: { ...summarize(freshnessValues), staleCount },
      methodology:
        'latencyMs = deliveredAt - observedAt (end-to-end, observer-reported when available); ' +
        'freshnessMs = deliveredAt - price.timestamp (data age at serve time); ' +
        'stale when freshnessMs > 120000ms; percentiles computed over the sample window',
    });
  }

  stats.sort((a, b) => a.asset.localeCompare(b.asset) || a.region.localeCompare(b.region));
  return stats;
}

export function recordUsageEvent(event: UsageEvent): void {
  usageAnalytics.record(event);
}

/** Test-only: clear all retained samples and usage events. */
export function resetForTesting(): void {
  latencySamples.length = 0;
  usageAnalytics['events'].length = 0;
}

export function exportUsage(
  keyPrefix: string,
  from?: number,
  to?: number,
): {
  totalRequests: number;
  byEndpoint: Record<string, number>;
  byAsset: Record<string, number>;
  byStatus: Record<string, number>;
  records: { endpoint: string; method: string; asset?: string; status: number; timestamp: number }[];
} {
  const fromMs = from !== undefined ? from * 1000 : 0;
  const toMs = to !== undefined ? to * 1000 : Number.MAX_SAFE_INTEGER;

  const events = usageAnalytics['events'] as unknown as UsageEvent[];
  const filtered = events.filter(
    (e) => e.apiKeyPrefix === keyPrefix && e.timestamp >= fromMs && e.timestamp <= toMs,
  );

  const byEndpoint: Record<string, number> = {};
  const byAsset: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const records: { endpoint: string; method: string; asset?: string; status: number; timestamp: number }[] = [];

  for (const e of filtered) {
    byEndpoint[`${e.method} ${e.endpoint}`] = (byEndpoint[`${e.method} ${e.endpoint}`] ?? 0) + 1;
    if (e.asset) byAsset[e.asset] = (byAsset[e.asset] ?? 0) + 1;
    byStatus[String(e.status)] = (byStatus[String(e.status)] ?? 0) + 1;
    records.push({
      endpoint: e.endpoint,
      method: e.method,
      asset: e.asset,
      status: e.status,
      timestamp: Math.floor(e.timestamp / 1000),
    });
  }

  records.sort((a, b) => b.timestamp - a.timestamp);

  return { totalRequests: records.length, byEndpoint, byAsset, byStatus, records };
}

logger.debug('Consumer data store initialized', {
  maxLatencySamples: MAX_LATENCY_SAMPLES,
  staleThresholdMs: STALE_THRESHOLD_MS,
});