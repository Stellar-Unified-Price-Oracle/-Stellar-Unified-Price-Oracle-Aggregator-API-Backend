import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock auth so importing delivery-objectives (which uses authMiddleware) does not
// construct the ApiKeyManager singleton at module load time.
vi.mock('../src/governance/auth', () => ({
  authMiddleware: (_req: any, _res: any, next: any) => next(),
}));

import { resetForTesting, recordLatencySample, computeFeedStats } from '../src/price-serving/consumer/store';
import { CONTRACTED_OBJECTIVES } from '../src/price-serving/consumer/delivery-objectives';

describe('consumer delivery objectives (#717)', () => {
  beforeEach(() => {
    resetForTesting();
  });

  it('defines contracted objectives covering latency, freshness, uptime, availability', () => {
    expect(CONTRACTED_OBJECTIVES).toHaveLength(4);
    const ids = CONTRACTED_OBJECTIVES.map((o) => o.id);
    expect(ids).toContain('latency-p95-24h');
    expect(ids).toContain('freshness-p95-24h');
    expect(ids).toContain('uptime-24h');
    expect(ids).toContain('availability-30d');

    const latency = CONTRACTED_OBJECTIVES.find((o) => o.id === 'latency-p95-24h')!;
    expect(latency.metric).toBe('latency');
    expect(latency.unit).toBe('ms');
    expect(latency.window).toBe('24h');
    expect(latency.target).toBe(5000);

    const freshness = CONTRACTED_OBJECTIVES.find((o) => o.id === 'freshness-p95-24h')!;
    expect(freshness.metric).toBe('freshness');
    expect(freshness.unit).toBe('ms');
    expect(freshness.target).toBe(60000);
  });

  it('computes actual latency p95 from feed samples', () => {
    const base = Math.floor(Date.now() / 1000) - 100;
    recordLatencySample({ asset: 'XLM', region: 'global', observedAt: base, deliveredAt: base, latencyMs: 1000, freshnessMs: 100 });
    recordLatencySample({ asset: 'XLM', region: 'global', observedAt: base, deliveredAt: base, latencyMs: 3000, freshnessMs: 200 });
    recordLatencySample({ asset: 'BTC', region: 'global', observedAt: base, deliveredAt: base, latencyMs: 2000, freshnessMs: 150 });

    const stats = computeFeedStats();
    expect(stats).toHaveLength(2);
    const xlm = stats.find((s) => s.asset === 'XLM')!;
    expect(xlm.latency.p95).toBeGreaterThan(1000);
    expect(xlm.latency.p95).toBeLessThanOrEqual(3000);
  });

  it('determines attainment: within target is attained, above target is not', () => {
    const base = Math.floor(Date.now() / 1000) - 100;
    // Fast deliveries -> latency objective attained
    recordLatencySample({ asset: 'XLM', region: 'global', observedAt: base, deliveredAt: base, latencyMs: 100, freshnessMs: 50 });
    recordLatencySample({ asset: 'BTC', region: 'global', observedAt: base, deliveredAt: base, latencyMs: 200, freshnessMs: 60 });

    const stats = computeFeedStats();
    const latencyP95 = Math.max(...stats.map((s) => s.latency.p95));
    expect(latencyP95).toBeLessThanOrEqual(5000); // target

    // Fresh deliveries -> freshness objective attained
    const freshnessP95 = Math.max(...stats.map((s) => s.freshness.p95));
    expect(freshnessP95).toBeLessThanOrEqual(60000); // target
  });

  it('detects SLA breach when latency exceeds target', () => {
    const base = Math.floor(Date.now() / 1000) - 100;
    recordLatencySample({ asset: 'XLM', region: 'global', observedAt: base, deliveredAt: base, latencyMs: 9000, freshnessMs: 50 });

    const stats = computeFeedStats();
    const latencyP95 = stats[0].latency.p95;
    expect(latencyP95).toBeGreaterThan(5000); // breached
  });
});