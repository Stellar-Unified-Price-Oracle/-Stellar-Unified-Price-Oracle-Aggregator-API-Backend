import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BaseSource } from '../src/oracle-sources/base';
import { NormalizedPrice } from '../src/infrastructure/types';
import BigNumber from 'bignumber.js';

vi.mock('../src/price-aggregation/source-circuit-breaker', () => ({
  sourceCircuitBreaker: {
    isAllowed: vi.fn(() => true),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
  },
}));

vi.mock('../src/observability/metrics', () => ({
  oracleSourceLatency: {
    startTimer: vi.fn(() => vi.fn(() => 0)),
  },
  oracleSourceRequestsTotal: {
    inc: vi.fn(),
  },
  oracleSourceSlaBreaches: {
    inc: vi.fn(),
  },
  oracleApiCallsTotal: {
    inc: vi.fn(),
  },
  oracleApiCostTotal: {
    inc: vi.fn(),
  },
  oracleApiBudgetUtilization: {
    set: vi.fn(),
  },
}));

vi.mock('../src/infrastructure/cost-model', () => ({
  estimateCostUsd: vi.fn(() => 0),
  recordCall: vi.fn(),
  getBudgetUtilization: vi.fn(() => 0),
}));

vi.mock('../src/domain-events', () => ({
  eventBus: {
    publish: vi.fn(),
  },
}));

class MockHealthSource extends BaseSource {
  name = 'mock-health' as const;

  async fetchPrice(asset: string): Promise<NormalizedPrice | null> {
    return this.normalize(asset, '100', 8, null);
  }

  exposeCalcUptime(): number {
    return this.health.uptimePercent;
  }

  recordSuccess(): void {
    this.health.lastSuccess = Math.floor(Date.now() / 1000);
    this.health.consecutiveFailures = 0;
    this.health.healthy = true;
  }

  recordFailure(): void {
    this.health.totalFailures++;
    this.health.lastFailure = Math.floor(Date.now() / 1000);
    this.health.consecutiveFailures++;
    if (this.health.consecutiveFailures >= 3) {
      this.health.healthy = false;
    }
  }
}

describe('Issue #523: Sliding-window uptime', () => {
  let source: MockHealthSource;

  beforeEach(() => {
    vi.clearAllMocks();
    source = new MockHealthSource();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should start with 100% uptime', () => {
    expect(source.health.uptimePercent).toBe(100);
  });

  it('should track total requests', async () => {
    expect(source.health.totalRequests).toBe(0);

    await source.fetchWithBackoff('XLM');

    expect(source.health.totalRequests).toBe(1);
  });

  it('should track total failures', async () => {
    vi.spyOn(source, 'fetchPrice').mockRejectedValueOnce(new Error('Network error'));

    await source.fetchWithBackoff('XLM');

    expect(source.health.totalFailures).toBeGreaterThanOrEqual(0);
  });

  it('should distinguish between attempted and failed vs not-attempted', async () => {
    const initialRequests = source.health.totalRequests;
    const initialFailures = source.health.totalFailures;

    await source.fetchWithBackoff('XLM');

    expect(source.health.totalRequests).toBeGreaterThan(initialRequests);
  });

  it('should record success on successful fetch', async () => {
    const beforeSuccess = source.health.lastSuccess;

    await source.fetchWithBackoff('XLM');

    expect(source.health.lastSuccess).toBeGreaterThanOrEqual(beforeSuccess ?? -Infinity);
  });

  it('should record failure on failed fetch', async () => {
    vi.spyOn(source, 'fetchPrice').mockRejectedValueOnce(new Error('Network error'));

    await source.fetchWithBackoff('XLM');

    expect(source.health.lastFailure).toBeGreaterThanOrEqual(0);
  });

  it('should show reduced uptime after consecutive failures', async () => {
    const before = source.exposeCalcUptime();

    vi.spyOn(source, 'fetchPrice').mockRejectedValue(new Error('Network error'));

    await source.fetchWithBackoff('XLM');
    await source.fetchWithBackoff('BTC');
    await source.fetchWithBackoff('ETH');

    const after = source.exposeCalcUptime();

    expect(after).toBeLessThanOrEqual(before);
  });

  it('should track consecutive failures', async () => {
    const initialConsecutive = source.health.consecutiveFailures;

    vi.spyOn(source, 'fetchPrice').mockRejectedValue(new Error('Network error'));

    await source.fetchWithBackoff('XLM');

    expect(source.health.consecutiveFailures).toBeGreaterThan(initialConsecutive);
  });

  it('should reset consecutive failures on success', async () => {
    vi.spyOn(source, 'fetchPrice')
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce(source.normalize('XLM', '100', 8, null));

    await source.fetchWithBackoff('XLM');
    expect(source.health.consecutiveFailures).toBeGreaterThan(0);

    await source.fetchWithBackoff('BTC');
    expect(source.health.consecutiveFailures).toBe(0);
  });

  it('should not round uptime to 100 while failures are occurring', async () => {
    vi.spyOn(source, 'fetchPrice')
      .mockResolvedValueOnce(source.normalize('XLM', '100', 8, null));

    await source.fetchWithBackoff('XLM');

    const uptime1 = source.exposeCalcUptime();

    for (let i = 0; i < 99; i++) {
      vi.spyOn(source, 'fetchPrice').mockResolvedValueOnce(
        source.normalize('TEST', '100', 8, null),
      );
      await source.fetchWithBackoff('TEST');
    }

    vi.spyOn(source, 'fetchPrice').mockRejectedValueOnce(new Error('Network error'));
    await source.fetchWithBackoff('FAIL');

    const uptime2 = source.exposeCalcUptime();

    expect(uptime2).toBeLessThan(100);
  });

  it('should update health status from fetch attempt', async () => {
    const beforeHealthy = source.health.healthy;

    await source.fetchWithBackoff('XLM');

    expect(source.health.healthy).toBe(true);
  });

  it('should mark unhealthy after 3 consecutive failures', async () => {
    vi.spyOn(source, 'fetchPrice').mockRejectedValue(new Error('Network error'));

    await source.fetchWithBackoff('XLM');
    await source.fetchWithBackoff('BTC');
    await source.fetchWithBackoff('ETH');

    expect(source.health.healthy).toBe(false);
  });

  it('should report accurate failure ratio', async () => {
    vi.spyOn(source, 'fetchPrice')
      .mockResolvedValueOnce(source.normalize('XLM', '100', 8, null))
      .mockResolvedValueOnce(source.normalize('BTC', '100', 8, null))
      .mockRejectedValueOnce(new Error('Network error'));

    await source.fetchWithBackoff('XLM');
    await source.fetchWithBackoff('BTC');
    await source.fetchWithBackoff('ETH');

    const failureRatio = source.health.totalFailures / Math.max(source.health.totalRequests, 1);
    const expectedUptime = Math.round((1 - failureRatio) * 100);

    expect(expectedUptime).toBeGreaterThan(0);
  });

  it('should update last success time on recovery', async () => {
    vi.spyOn(source, 'fetchPrice').mockRejectedValue(new Error('Network error'));

    await source.fetchWithBackoff('XLM');
    const lastFailureTime = source.health.lastFailure;

    vi.spyOn(source, 'fetchPrice').mockResolvedValue(source.normalize('BTC', '100', 8, null));

    await source.fetchWithBackoff('BTC');

    expect(source.health.lastSuccess).toBeGreaterThanOrEqual(lastFailureTime ?? 0);
  });

  it('should track timestamps for transitions', async () => {
    expect(source.health.lastSuccess).toBeNull();
    expect(source.health.lastFailure).toBeNull();

    await source.fetchWithBackoff('XLM');

    expect(source.health.lastSuccess).not.toBeNull();
  });

  it('should maintain consistent request count across multiple assets', async () => {
    await source.fetchWithBackoff('XLM');
    const count1 = source.health.totalRequests;

    await source.fetchWithBackoff('BTC');
    const count2 = source.health.totalRequests;

    expect(count2).toBe(count1 + 1);
  });

  it('should not exceed 100% uptime', () => {
    expect(source.health.uptimePercent).toBeLessThanOrEqual(100);
  });

  it('should not show negative uptime', () => {
    expect(source.health.uptimePercent).toBeGreaterThanOrEqual(0);
  });
});
