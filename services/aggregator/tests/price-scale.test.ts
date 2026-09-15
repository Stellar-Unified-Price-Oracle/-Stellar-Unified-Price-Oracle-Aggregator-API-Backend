import { describe, it, expect, vi, beforeEach } from 'vitest';
import { httpClient } from '../src/infrastructure/http-client';
import { ChainlinkSource } from '../src/oracle-sources/chainlink';
import { BandSource } from '../src/oracle-sources/band';
import { BaseSource } from '../src/oracle-sources/base';
import { PriceAggregator } from '../src/price-aggregation/aggregator';
import { CircuitBreaker } from '../src/price-aggregation/circuit-breaker';
import { medianOnCommonScale, toScale } from '../src/price-aggregation/median';
import type { NormalizedPrice } from '../src/infrastructure/types';

vi.mock('../src/infrastructure/http-client', () => ({
  httpClient: { get: vi.fn() },
}));

vi.mock('../src/price-aggregation/source-circuit-breaker', () => ({
  sourceCircuitBreaker: {
    isAllowed: vi.fn(() => true),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
  },
}));

const mockedHttpClient = vi.mocked(httpClient);

function mockGet(data: unknown) {
  mockedHttpClient.get.mockResolvedValue({ data } as never);
}

const now = () => Math.floor(Date.now() / 1000);

function price(
  over: Partial<NormalizedPrice> & Pick<NormalizedPrice, 'price' | 'decimals' | 'source'>,
): NormalizedPrice {
  return { asset: 'XLM', timestamp: now(), observedAt: now(), fetchedAt: now(), ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── The bug: medians taken across sources with different decimals ────────────

describe('median across mixed decimal scales', () => {
  it('reduces to a common scale before comparing', () => {
    // Same real price ($0.12) expressed at 8 and 9 decimals. Medianing the raw
    // integers gave (12_000_000 + 120_000_000) / 2 = 66_000_000, which is not
    // any asset's price.
    const { value, decimals } = medianOnCommonScale([
      price({ price: 12_000_000n, decimals: 8, source: 'chainlink' }),
      price({ price: 120_000_000n, decimals: 9, source: 'band' }),
    ]);

    expect(decimals).toBe(9);
    expect(value.toString()).toBe('120000000');
  });

  it('picks the true median when sources disagree on price and scale', () => {
    const { value, decimals } = medianOnCommonScale([
      price({ price: 10_000_000n, decimals: 8, source: 'chainlink' }), // 0.10
      price({ price: 120_000_000n, decimals: 9, source: 'band' }), // 0.12
      price({ price: 14_000_000n, decimals: 8, source: 'redstone' }), // 0.14
    ]);

    expect(decimals).toBe(9);
    expect(value.toString()).toBe('120000000');
  });

  it('leaves uniformly scaled sources untouched', () => {
    const { value, decimals } = medianOnCommonScale([
      price({ price: 100n, decimals: 7, source: 'chainlink' }),
      price({ price: 102n, decimals: 7, source: 'redstone' }),
      price({ price: 101n, decimals: 7, source: 'band' }),
    ]);

    expect(decimals).toBe(7);
    expect(value.toString()).toBe('101');
  });

  it('rounds an even-count median back to an integer at that scale', () => {
    const { value } = medianOnCommonScale([
      price({ price: 100n, decimals: 7, source: 'chainlink' }),
      price({ price: 101n, decimals: 7, source: 'redstone' }),
    ]);

    // 100.5 rounds up rather than leaking a fractional scaled integer.
    expect(value.toString()).toBe('101');
    expect(value.isInteger()).toBe(true);
  });

  it('toScale re-expresses a price without changing its value', () => {
    expect(toScale(price({ price: 12_000_000n, decimals: 8, source: 'chainlink' }), 9).toString())
      .toBe('120000000');
    expect(toScale(price({ price: 120_000_000n, decimals: 9, source: 'band' }), 8).toString())
      .toBe('12000000');
  });
});

describe('PriceAggregator with mixed-decimal sources', () => {
  it('reports the price and decimals it actually computed on', () => {
    const aggregator = new PriceAggregator();

    aggregator.updateSourcePrice(
      price({ price: 12_000_000n, decimals: 8, source: 'chainlink' }),
    );
    aggregator.updateSourcePrice(price({ price: 120_000_000n, decimals: 9, source: 'band' }));

    const result = aggregator.getLatestForAsset('XLM')!;

    expect(result.decimals).toBe(9);
    // 120_000_000 / 10^9 — one $0.12, not the 0.66 the old code produced.
    expect(parseFloat(result.price) / Math.pow(10, result.decimals)).toBeCloseTo(0.12, 8);
  });

  it('does not flag a consistent source as suspicious over a scale difference', () => {
    const aggregator = new PriceAggregator();

    aggregator.updateSourcePrice(
      price({ price: 12_000_000n, decimals: 8, source: 'chainlink' }),
    );
    aggregator.updateSourcePrice(price({ price: 120_000_000n, decimals: 9, source: 'band' }));

    const result = aggregator.getLatestForAsset('XLM')!;
    expect(result.sources).toHaveLength(2);
    expect(aggregator.getSuspiciousSources()).toEqual([]);
  });
});

describe('CircuitBreaker deviation across mixed decimal scales', () => {
  it('measures deviation on a common scale', () => {
    const breaker = new CircuitBreaker({
      deviationThreshold: 20,
      recoveryRequiredSuccesses: 3,
    });

    const chainlink = price({ price: 12_000_000n, decimals: 8, source: 'chainlink' });
    const band = price({ price: 120_000_000n, decimals: 9, source: 'band' });

    // Against a raw median of 66_000_000 this source looked ~82% off its own
    // price and got marked suspicious, removing it from aggregation.
    const evaluation = breaker.evaluatePrice(chainlink, [chainlink, band]);

    expect(evaluation.deviation).toBeCloseTo(0, 6);
    expect(evaluation.isSuspicious).toBe(false);
  });
});

// ── The bug: `timestamp` meant two different things per source ───────────────

describe('normalize timestamp semantics', () => {
  class TestSource extends BaseSource {
    name = 'chainlink' as const;
    async fetchPrice() {
      return null;
    }
  }

  it('records a provider observation time separately from local fetch time', () => {
    const result = new TestSource()['normalize']('XLM', '0.12', 8, 1_719_000_000);

    expect(result.observedAt).toBe(1_719_000_000);
    expect(result.timestamp).toBe(1_719_000_000);
    expect(result.fetchedAt).toBeGreaterThan(1_719_000_000);
  });

  it('leaves observedAt null when the provider reports no time', () => {
    const result = new TestSource()['normalize']('XLM', '0.12', 8, null);

    expect(result.observedAt).toBeNull();
    expect(result.fetchedAt).toBe(result.timestamp);
  });
});

describe('source timestamp reporting', () => {
  it('chainlink reports no provider observation time', async () => {
    mockGet({ USD: { PRICE: 0.12 } });

    const result = (await new ChainlinkSource().fetchPrice('XLM'))!;

    // Previously this was `Date.now()`, which made the staleness check vacuous.
    expect(result.observedAt).toBeNull();
    expect(result.timestamp).toBe(result.fetchedAt);
  });

  it('band reports the provider update time as observedAt', async () => {
    mockGet({ data: { price: '0.12', decimals: 9, updated_at: 1_719_000_000 } });

    const result = (await new BandSource().fetchPrice('XLM'))!;

    expect(result.observedAt).toBe(1_719_000_000);
    expect(result.timestamp).toBe(1_719_000_000);
    expect(result.fetchedAt).toBeGreaterThan(1_719_000_000);
  });

  it('band leaves observedAt null when updated_at is absent', async () => {
    mockGet({ data: { price: '0.12', decimals: 9 } });

    const result = (await new BandSource().fetchPrice('XLM'))!;

    expect(result.observedAt).toBeNull();
  });
});

describe('aggregate age verification', () => {
  it('is verified only when every source reported an observation time', () => {
    const aggregator = new PriceAggregator();
    const ts = now();

    aggregator.updateSourcePrice(
      price({ price: 12_000_000n, decimals: 8, source: 'chainlink', observedAt: ts, timestamp: ts }),
    );
    aggregator.updateSourcePrice(
      price({ price: 120_000_000n, decimals: 9, source: 'band', observedAt: ts, timestamp: ts }),
    );

    expect(aggregator.getLatestForAsset('XLM')!.ageVerified).toBe(true);
  });

  it('is not verified when any contributing source lacks an observation time', () => {
    const aggregator = new PriceAggregator();
    const ts = now();

    aggregator.updateSourcePrice(
      price({
        price: 12_000_000n,
        decimals: 8,
        source: 'chainlink',
        observedAt: null,
        fetchedAt: ts,
        timestamp: ts,
      }),
    );
    aggregator.updateSourcePrice(
      price({ price: 120_000_000n, decimals: 9, source: 'band', observedAt: ts, timestamp: ts }),
    );

    const result = aggregator.getLatestForAsset('XLM')!;
    expect(result.ageVerified).toBe(false);
    // Still aggregated — an unverifiable age is a signal, not a reason to drop
    // the data.
    expect(result.sources).toHaveLength(2);
  });

  it('still treats a stale provider observation time as stale', () => {
    const aggregator = new PriceAggregator();
    const old = now() - 300;

    aggregator.updateSourcePrice(
      price({ price: 12_000_000n, decimals: 8, source: 'chainlink', observedAt: old, timestamp: old }),
    );

    const result = aggregator.getLatestForAsset('XLM')!;
    expect(result.stale).toBe(true);
    expect(result.degradationLevel).toBe('critical');
  });
});
