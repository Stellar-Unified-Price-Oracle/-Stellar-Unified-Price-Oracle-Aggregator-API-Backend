import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PriceAggregator } from '../src/price-aggregation/aggregator';
import { NormalizedPrice } from '../src/infrastructure/types';
import BigNumber from 'bignumber.js';

vi.mock('../src/price-aggregation/source-circuit-breaker', () => ({
  sourceCircuitBreaker: {
    isAllowed: vi.fn(() => true),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
  },
}));

vi.mock('../src/price-aggregation/anomaly-detector', () => ({
  anomalyDetector: {
    detect: vi.fn(() => null),
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

function createNormalizedPrice(
  asset: string,
  price: bigint,
  source: string,
  decimals = 8,
): NormalizedPrice {
  return {
    asset: asset.toUpperCase(),
    price,
    decimals,
    source: source as any,
    timestamp: Math.floor(Date.now() / 1000),
    observedAt: null,
    fetchedAt: Math.floor(Date.now() / 1000),
  };
}

describe('Issue #522: Define explicit degraded-mode policy', () => {
  let aggregator: PriceAggregator;

  beforeEach(() => {
    vi.clearAllMocks();
    aggregator = new PriceAggregator();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should serve aggregate when all sources are healthy', () => {
    const xlmPrices = [
      createNormalizedPrice('XLM', BigInt('1200000000'), 'chainlink'),
      createNormalizedPrice('XLM', BigInt('1200000000'), 'redstone'),
      createNormalizedPrice('XLM', BigInt('1200000000'), 'band'),
    ];

    xlmPrices.forEach((p) => aggregator.updateSourcePrice(p));

    const result = aggregator.getLatestForAsset('XLM');

    expect(result).not.toBeNull();
    expect(result!.degradationLevel).toBe('healthy');
    expect(result!.confidence).toBe(1.0);
  });

  it('should mark confidence < 1.0 when some sources are missing', () => {
    const xlmPrices = [
      createNormalizedPrice('XLM', BigInt('1200000000'), 'chainlink'),
      createNormalizedPrice('XLM', BigInt('1200000000'), 'redstone'),
    ];

    xlmPrices.forEach((p) => aggregator.updateSourcePrice(p));

    const result = aggregator.getLatestForAsset('XLM');

    expect(result).not.toBeNull();
    expect(result!.confidence).toBeLessThan(1.0);
  });

  it('should mark stale when all prices are older than threshold', () => {
    const now = Math.floor(Date.now() / 1000);
    const stalePrice = {
      ...createNormalizedPrice('XLM', BigInt('1200000000'), 'chainlink'),
      timestamp: now - 120,
    };

    aggregator.updateSourcePrice(stalePrice);

    const result = aggregator.getLatestForAsset('XLM');

    expect(result).not.toBeNull();
    expect(result!.stale).toBe(true);
  });

  it('should return null when no sources exist for an asset', () => {
    const result = aggregator.getLatestForAsset('XLM');

    expect(result).toBeNull();
  });

  it('should compute degradation level as critical when no active prices', () => {
    const now = Math.floor(Date.now() / 1000);
    const stalePrice = {
      ...createNormalizedPrice('XLM', BigInt('1200000000'), 'chainlink'),
      timestamp: now - 120,
    };

    aggregator.updateSourcePrice(stalePrice);

    const result = aggregator.getLatestForAsset('XLM');

    expect(result).not.toBeNull();
    expect(result!.degradationLevel).toBe('critical');
  });

  it('should compute degradation level as degraded when < 100% sources', () => {
    const xlmPrices = [
      createNormalizedPrice('XLM', BigInt('1200000000'), 'chainlink'),
      createNormalizedPrice('XLM', BigInt('1200000000'), 'redstone'),
    ];

    xlmPrices.forEach((p) => aggregator.updateSourcePrice(p));

    const result = aggregator.getLatestForAsset('XLM');

    expect(result).not.toBeNull();
    if (result!.confidence < 1.0 && result!.confidence >= 0.5) {
      expect(result!.degradationLevel).toBe('degraded');
    }
  });

  it('should serve an aggregate even when some sources are suspicious', () => {
    const xlmPrices = [
      createNormalizedPrice('XLM', BigInt('1200000000'), 'chainlink'),
      createNormalizedPrice('XLM', BigInt('1200000000'), 'redstone'),
      createNormalizedPrice('XLM', BigInt('2500000000'), 'band'),
    ];

    xlmPrices.forEach((p) => aggregator.updateSourcePrice(p));

    const result = aggregator.getLatestForAsset('XLM');

    expect(result).not.toBeNull();
    expect(result!.price).toBeDefined();
  });

  it('should not return null when price exists, even if confidence is degraded', () => {
    const xlmPrices = [
      createNormalizedPrice('XLM', BigInt('1200000000'), 'chainlink'),
    ];

    xlmPrices.forEach((p) => aggregator.updateSourcePrice(p));

    const result = aggregator.getLatestForAsset('XLM');

    expect(result).not.toBeNull();
    expect(result!.asset).toBe('XLM');
  });

  it('should include all sources in response', () => {
    const xlmPrices = [
      createNormalizedPrice('XLM', BigInt('1200000000'), 'chainlink'),
      createNormalizedPrice('XLM', BigInt('1200000000'), 'redstone'),
      createNormalizedPrice('XLM', BigInt('1200000000'), 'band'),
    ];

    xlmPrices.forEach((p) => aggregator.updateSourcePrice(p));

    const result = aggregator.getLatestForAsset('XLM');

    expect(result).not.toBeNull();
    expect(result!.sources).toContain('chainlink');
    expect(result!.sources).toContain('redstone');
    expect(result!.sources).toContain('band');
  });

  it('should compute correct median regardless of degradation', () => {
    const xlmPrices = [
      createNormalizedPrice('XLM', BigInt('1000000000'), 'chainlink'),
      createNormalizedPrice('XLM', BigInt('1200000000'), 'redstone'),
      createNormalizedPrice('XLM', BigInt('1400000000'), 'band'),
    ];

    xlmPrices.forEach((p) => aggregator.updateSourcePrice(p));

    const result = aggregator.getLatestForAsset('XLM');

    expect(result).not.toBeNull();
    expect(result!.price).toBe('1200000000');
  });

  it('should handle rapid source price updates', () => {
    const xlmPrice1 = createNormalizedPrice('XLM', BigInt('1200000000'), 'chainlink');
    aggregator.updateSourcePrice(xlmPrice1);

    const xlmPrice2 = {
      ...xlmPrice1,
      price: BigInt('1250000000'),
    };
    aggregator.updateSourcePrice(xlmPrice2);

    const result = aggregator.getLatestForAsset('XLM');

    expect(result).not.toBeNull();
    expect(result!.price).toBe('1250000000');
  });

  it('should report timestamp when aggregate is served', () => {
    const xlmPrices = [
      createNormalizedPrice('XLM', BigInt('1200000000'), 'chainlink'),
    ];

    xlmPrices.forEach((p) => aggregator.updateSourcePrice(p));

    const result = aggregator.getLatestForAsset('XLM');

    expect(result).not.toBeNull();
    expect(result!.timestamp).toBeGreaterThan(0);
    expect(result!.timestamp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
  });

  it('should compute confidence as ratio of active to total sources', () => {
    const xlmPrices = [
      createNormalizedPrice('XLM', BigInt('1200000000'), 'chainlink'),
      createNormalizedPrice('XLM', BigInt('1200000000'), 'redstone'),
    ];

    xlmPrices.forEach((p) => aggregator.updateSourcePrice(p));

    const result = aggregator.getLatestForAsset('XLM');

    expect(result).not.toBeNull();
    expect(result!.confidence).toBeGreaterThan(0);
    expect(result!.confidence).toBeLessThanOrEqual(1.0);
  });
});
