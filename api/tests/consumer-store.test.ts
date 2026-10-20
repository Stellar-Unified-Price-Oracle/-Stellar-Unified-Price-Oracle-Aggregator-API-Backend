import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  recordLatencySample,
  consumerRegion,
  computeFeedStats,
  exportUsage,
  recordUsageEvent,
  resetForTesting,
} from '../src/price-serving/consumer/store';

const nowSec = () => Math.floor(Date.now() / 1000);

describe('consumer store — latency samples', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetForTesting();
  });

  it('records and computes feed stats for one (asset, region)', () => {
    const base = nowSec() - 100;
    recordLatencySample({
      asset: 'XLM', region: 'us-east', observedAt: base, deliveredAt: base + 1,
      latencyMs: 1000, freshnessMs: 500, source: 'chainlink',
    });
    recordLatencySample({
      asset: 'XLM', region: 'us-east', observedAt: base, deliveredAt: base + 1,
      latencyMs: 2000, freshnessMs: 1000, source: 'redstone',
    });

    const stats = computeFeedStats('XLM', 'us-east');
    expect(stats).toHaveLength(1);
    expect(stats[0].asset).toBe('XLM');
    expect(stats[0].region).toBe('us-east');
    expect(stats[0].sampleCount).toBe(2);
    expect(stats[0].latency.p50).toBe(1500);
    expect(stats[0].latency.p95).toBe(1950);
    expect(stats[0].latency.p99).toBe(1990);
    expect(stats[0].freshness.staleCount).toBe(0);
    expect(stats[0].methodology).toContain('latencyMs');
    expect(stats[0].methodology).toContain('freshnessMs');
  });

  it('groups by asset and region separately', () => {
    const base = nowSec();
    recordLatencySample({ asset: 'XLM', region: 'us-east', observedAt: base, deliveredAt: base, latencyMs: 100, freshnessMs: 50 });
    recordLatencySample({ asset: 'XLM', region: 'eu-west', observedAt: base, deliveredAt: base, latencyMs: 200, freshnessMs: 60 });
    recordLatencySample({ asset: 'BTC', region: 'us-east', observedAt: base, deliveredAt: base, latencyMs: 300, freshnessMs: 70 });

    const stats = computeFeedStats();
    expect(stats).toHaveLength(3);
    const byKey = new Map(stats.map((s) => [`${s.asset}|${s.region}`, s]));
    expect(byKey.get('XLM|us-east')!.sampleCount).toBe(1);
    expect(byKey.get('XLM|eu-west')!.sampleCount).toBe(1);
    expect(byKey.get('BTC|us-east')!.sampleCount).toBe(1);
  });

  it('filters by time window', () => {
    const old = nowSec() - 100_000;
    const recent = nowSec();
    recordLatencySample({ asset: 'XLM', region: 'global', observedAt: old, deliveredAt: old, latencyMs: 100, freshnessMs: 50 });
    recordLatencySample({ asset: 'XLM', region: 'global', observedAt: recent, deliveredAt: recent, latencyMs: 200, freshnessMs: 60 });

    const stats = computeFeedStats('XLM', 'global', recent - 60, recent + 60);
    expect(stats[0].sampleCount).toBe(1);
    expect(stats[0].latency.p50).toBe(200);
  });

  it('returns empty array when no samples match', () => {
    const stats = computeFeedStats('NOPE', 'global');
    expect(stats).toHaveLength(0);
  });

  it('marks stale samples when freshness exceeds threshold', () => {
    const base = nowSec();
    recordLatencySample({ asset: 'XLM', region: 'global', observedAt: base, deliveredAt: base, latencyMs: 100, freshnessMs: 200_000 });
    recordLatencySample({ asset: 'XLM', region: 'global', observedAt: base, deliveredAt: base, latencyMs: 100, freshnessMs: 50 });
    const stats = computeFeedStats('XLM', 'global');
    expect(stats[0].freshness.staleCount).toBe(1);
  });

  it('normalizes asset case and region case', () => {
    const base = nowSec();
    recordLatencySample({ asset: 'xlm', region: 'US-East', observedAt: base, deliveredAt: base, latencyMs: 100, freshnessMs: 50 });
    const stats = computeFeedStats('XLM', 'us-east');
    expect(stats[0].sampleCount).toBe(1);
    expect(stats[0].asset).toBe('XLM');
    expect(stats[0].region).toBe('us-east');
  });
});

describe('consumer store — consumerRegion', () => {
  it('uses header when present', () => {
    expect(consumerRegion('eu-west', undefined)).toBe('eu-west');
  });
  it('falls back to global', () => {
    expect(consumerRegion(undefined, undefined)).toBe('global');
  });
  it('lowercases region', () => {
    expect(consumerRegion('US-East', undefined)).toBe('us-east');
  });
});

describe('consumer store — usage export', () => {
  beforeEach(() => {
    resetForTesting();
  });
  it('exports only the calling tenant key prefix', () => {
    recordUsageEvent({ endpoint: '/api/v1/prices/XLM', method: 'GET', apiKeyPrefix: 'tenant-a', asset: 'XLM', status: 200, timestamp: Date.now() });
    recordUsageEvent({ endpoint: '/api/v1/prices/BTC', method: 'GET', apiKeyPrefix: 'tenant-b', asset: 'BTC', status: 200, timestamp: Date.now() });

    const exported = exportUsage('tenant-a');
    expect(exported.totalRequests).toBe(1);
    expect(exported.records[0].endpoint).toBe('/api/v1/prices/XLM');
    expect(exported.byAsset.XLM).toBe(1);
    expect(exported.byStatus['200']).toBe(1);

    const exportedB = exportUsage('tenant-b');
    expect(exportedB.totalRequests).toBe(1);
    expect(exportedB.records[0].asset).toBe('BTC');
  });

  it('filters by time window', () => {
    const old = Date.now() - 200_000;
    const recent = Date.now();
    recordUsageEvent({ endpoint: '/x', method: 'GET', apiKeyPrefix: 't', asset: 'XLM', status: 200, timestamp: old });
    recordUsageEvent({ endpoint: '/x', method: 'GET', apiKeyPrefix: 't', asset: 'XLM', status: 200, timestamp: recent });

    const n = Math.floor(Date.now() / 1000);
    const exported = exportUsage('t', n - 60, n + 60);
    expect(exported.totalRequests).toBe(1);
  });

  it('returns empty when no usage for tenant', () => {
    const exported = exportUsage('nonexistent');
    expect(exported.totalRequests).toBe(0);
    expect(exported.records).toEqual([]);
  });
});

describe('consumer store — recordUsageEvent', () => {
  it('delegates to usageAnalytics without throwing', () => {
    recordUsageEvent({ endpoint: '/api/v1/prices', method: 'GET', apiKeyPrefix: 't', status: 200, timestamp: Date.now() });
    expect(true).toBe(true);
  });
});