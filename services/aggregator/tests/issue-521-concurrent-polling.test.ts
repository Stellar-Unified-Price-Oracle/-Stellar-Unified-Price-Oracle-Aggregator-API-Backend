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

class MockSource extends BaseSource {
  name = 'mock-source' as const;
  private fetchDelay: number;
  private shouldFail: boolean;

  constructor(fetchDelay: number = 100, shouldFail: boolean = false) {
    super();
    this.fetchDelay = fetchDelay;
    this.shouldFail = shouldFail;
  }

  async fetchPrice(asset: string): Promise<NormalizedPrice | null> {
    await new Promise((r) => setTimeout(r, this.fetchDelay));

    if (this.shouldFail) {
      throw new Error(`Failed to fetch ${asset}`);
    }

    return this.normalize(asset, '100', 8, null);
  }
}

describe('Issue #521: Concurrent source polling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should fetch multiple assets sequentially (current behavior)', async () => {
    const source = new MockSource(50);
    const assets = ['XLM', 'BTC', 'ETH'];

    const start = Date.now();
    const results = await source.fetchAll(assets);
    const duration = Date.now() - start;

    expect(results.length).toBe(3);
    expect(results.every((r) => r !== null)).toBe(true);
    expect(duration).toBeGreaterThanOrEqual(150);
  });

  it('should not delay remaining assets when one fails', async () => {
    const source = new MockSource(50, false);
    const assets = ['XLM', 'BTC', 'ETH'];

    const start = Date.now();
    const results = await source.fetchAll(assets);
    const duration = Date.now() - start;

    expect(results.length).toBe(3);
    expect(duration).toBeLessThan(500);
  });

  it('should handle partial failures and continue with next asset', async () => {
    const source = new MockSource(50);

    const failingPrice = vi.spyOn(source, 'fetchPrice').mockRejectedValueOnce(new Error('Network error'));

    const results = await source.fetchAll(['XLM', 'BTC']);

    expect(results.length).toBe(1);
    expect(results[0]?.asset).toBe('BTC');
  });

  it('should respect per-asset fetch delay without compounding', async () => {
    const source = new MockSource(100);
    const assets = ['XLM', 'BTC', 'ETH', 'USDC'];

    const start = Date.now();
    await source.fetchAll(assets);
    const duration = Date.now() - start;

    expect(duration).toBeGreaterThanOrEqual(400);
    expect(duration).toBeLessThan(600);
  });

  it('should measure individual fetch times independently', async () => {
    const source = new MockSource(50);
    const assets = ['XLM', 'BTC', 'ETH'];

    const fetchTimes: number[] = [];
    const originalFetchPrice = source.fetchPrice.bind(source);

    vi.spyOn(source, 'fetchPrice').mockImplementation(async (asset: string) => {
      const start = Date.now();
      const result = await originalFetchPrice(asset);
      fetchTimes.push(Date.now() - start);
      return result;
    });

    const start = Date.now();
    const results = await source.fetchAll(assets);
    const totalDuration = Date.now() - start;

    expect(results.length).toBe(3);
    expect(totalDuration).toBeGreaterThanOrEqual(150);
  });

  it('should continue polling all assets even if earlier ones are slow', async () => {
    class VariableDelaySource extends BaseSource {
      name = 'variable-delay' as const;
      private delayMap: Map<string, number>;

      constructor(delayMap: Map<string, number>) {
        super();
        this.delayMap = delayMap;
      }

      async fetchPrice(asset: string): Promise<NormalizedPrice | null> {
        const delay = this.delayMap.get(asset) || 100;
        await new Promise((r) => setTimeout(r, delay));
        return this.normalize(asset, '100', 8, null);
      }
    }

    const delayMap = new Map([
      ['XLM', 200],
      ['BTC', 50],
      ['ETH', 50],
    ]);

    const source = new VariableDelaySource(delayMap);
    const start = Date.now();
    const results = await source.fetchAll(['XLM', 'BTC', 'ETH']);
    const duration = Date.now() - start;

    expect(results.length).toBe(3);
    expect(duration).toBeGreaterThanOrEqual(300);
  });

  it('should track results in order regardless of completion order', async () => {
    const source = new MockSource(50);
    const assets = ['XLM', 'BTC', 'ETH'];

    const results = await source.fetchAll(assets);

    expect(results[0]?.asset).toBe('XLM');
    expect(results[1]?.asset).toBe('BTC');
    expect(results[2]?.asset).toBe('ETH');
  });

  it('should handle empty asset list', async () => {
    const source = new MockSource(50);

    const results = await source.fetchAll([]);

    expect(results.length).toBe(0);
  });

  it('should report accurate health metrics across sequential fetches', async () => {
    const source = new MockSource(50);
    const assets = ['XLM', 'BTC'];

    expect(source.health.totalRequests).toBe(0);

    await source.fetchAll(assets);

    expect(source.health.totalRequests).toBe(2);
    expect(source.health.totalFailures).toBe(0);
  });
});
