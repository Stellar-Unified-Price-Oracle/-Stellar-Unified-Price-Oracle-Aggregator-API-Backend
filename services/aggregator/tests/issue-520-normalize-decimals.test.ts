import { describe, it, expect } from 'vitest';
import BigNumber from 'bignumber.js';
import { medianOnCommonScale, toScale } from '../src/price-aggregation/median';
import { NormalizedPrice } from '../src/infrastructure/types';

describe('Issue #520: Normalize decimals before taking the median', () => {
  it('should compute median correctly with mixed decimal scales (8 vs 18)', () => {
    const prices: NormalizedPrice[] = [
      {
        asset: 'XLM',
        price: BigInt('12000000'), // 1.20 with 8 decimals
        decimals: 8,
        source: 'chainlink',
        timestamp: Math.floor(Date.now() / 1000),
        observedAt: null,
        fetchedAt: Math.floor(Date.now() / 1000),
      },
      {
        asset: 'XLM',
        price: BigInt('1200000000000000000'), // 1.20 with 18 decimals
        decimals: 18,
        source: 'redstone',
        timestamp: Math.floor(Date.now() / 1000),
        observedAt: null,
        fetchedAt: Math.floor(Date.now() / 1000),
      },
      {
        asset: 'XLM',
        price: BigInt('12000000'), // 1.20 with 8 decimals
        decimals: 8,
        source: 'band',
        timestamp: Math.floor(Date.now() / 1000),
        observedAt: null,
        fetchedAt: Math.floor(Date.now() / 1000),
      },
    ];

    const result = medianOnCommonScale(prices);

    expect(result.decimals).toBe(18);
    expect(result.value.toString()).toBe('1200000000000000000');
  });

  it('should scale smaller decimals up to the largest present', () => {
    const price8 = {
      asset: 'ETH',
      price: BigInt('3500000000'), // 35.00 with 8 decimals
      decimals: 8,
      source: 'chainlink',
      timestamp: Math.floor(Date.now() / 1000),
      observedAt: null,
      fetchedAt: Math.floor(Date.now() / 1000),
    };

    const scaled = toScale(price8, 18);

    expect(scaled.toString()).toBe('3500000000000000000');
  });

  it('should handle odd number of prices', () => {
    const prices: NormalizedPrice[] = [
      {
        asset: 'BTC',
        price: BigInt('6500000'), // 0.065 with 8 decimals
        decimals: 8,
        source: 'chainlink',
        timestamp: Math.floor(Date.now() / 1000),
        observedAt: null,
        fetchedAt: Math.floor(Date.now() / 1000),
      },
      {
        asset: 'BTC',
        price: BigInt('7000000'), // 0.07 with 8 decimals
        decimals: 8,
        source: 'redstone',
        timestamp: Math.floor(Date.now() / 1000),
        observedAt: null,
        fetchedAt: Math.floor(Date.now() / 1000),
      },
      {
        asset: 'BTC',
        price: BigInt('7500000'), // 0.075 with 8 decimals
        decimals: 8,
        source: 'band',
        timestamp: Math.floor(Date.now() / 1000),
        observedAt: null,
        fetchedAt: Math.floor(Date.now() / 1000),
      },
    ];

    const result = medianOnCommonScale(prices);

    expect(result.decimals).toBe(8);
    expect(result.value.toString()).toBe('7000000');
  });

  it('should handle even number of prices without precision loss', () => {
    const prices: NormalizedPrice[] = [
      {
        asset: 'USDC',
        price: BigInt('100000000'), // 1.00 with 8 decimals
        decimals: 8,
        source: 'chainlink',
        timestamp: Math.floor(Date.now() / 1000),
        observedAt: null,
        fetchedAt: Math.floor(Date.now() / 1000),
      },
      {
        asset: 'USDC',
        price: BigInt('101000000'), // 1.01 with 8 decimals
        decimals: 8,
        source: 'redstone',
        timestamp: Math.floor(Date.now() / 1000),
        observedAt: null,
        fetchedAt: Math.floor(Date.now() / 1000),
      },
    ];

    const result = medianOnCommonScale(prices);

    expect(result.decimals).toBe(8);
    const expectedMedian = new BigNumber('100500000');
    expect(result.value.toString()).toBe(expectedMedian.toString());
  });

  it('should return correct decimals even with single price', () => {
    const prices: NormalizedPrice[] = [
      {
        asset: 'XLM',
        price: BigInt('1200000000000000000'),
        decimals: 18,
        source: 'redstone',
        timestamp: Math.floor(Date.now() / 1000),
        observedAt: null,
        fetchedAt: Math.floor(Date.now() / 1000),
      },
    ];

    const result = medianOnCommonScale(prices);

    expect(result.decimals).toBe(18);
    expect(result.value.toString()).toBe('1200000000000000000');
  });

  it('should preserve the highest precision across all sources', () => {
    const prices: NormalizedPrice[] = [
      {
        asset: 'ETH',
        price: BigInt('350000000'), // 3.5 with 8 decimals
        decimals: 8,
        source: 'chainlink',
        timestamp: Math.floor(Date.now() / 1000),
        observedAt: null,
        fetchedAt: Math.floor(Date.now() / 1000),
      },
      {
        asset: 'ETH',
        price: BigInt('3500000000000000000'), // 3.5 with 18 decimals
        decimals: 18,
        source: 'redstone',
        timestamp: Math.floor(Date.now() / 1000),
        observedAt: null,
        fetchedAt: Math.floor(Date.now() / 1000),
      },
      {
        asset: 'ETH',
        price: BigInt('35000000000'), // 3.5 with 10 decimals
        decimals: 10,
        source: 'band',
        timestamp: Math.floor(Date.now() / 1000),
        observedAt: null,
        fetchedAt: Math.floor(Date.now() / 1000),
      },
    ];

    const result = medianOnCommonScale(prices);

    expect(result.decimals).toBe(18);
    expect(result.value.toString()).toBe('3500000000000000000');
  });

  it('should compute median that results in an integer on the common scale', () => {
    const prices: NormalizedPrice[] = [
      {
        asset: 'TEST',
        price: BigInt('100'), // 0.000001 with 8 decimals
        decimals: 8,
        source: 'source1',
        timestamp: Math.floor(Date.now() / 1000),
        observedAt: null,
        fetchedAt: Math.floor(Date.now() / 1000),
      },
      {
        asset: 'TEST',
        price: BigInt('100000000000'), // 0.0001 with 18 decimals
        decimals: 18,
        source: 'source2',
        timestamp: Math.floor(Date.now() / 1000),
        observedAt: null,
        fetchedAt: Math.floor(Date.now() / 1000),
      },
    ];

    const result = medianOnCommonScale(prices);

    expect(result.decimals).toBe(18);
    expect(result.value.isInteger()).toBe(true);
  });

  it('should not return 0 decimals when processing non-zero prices', () => {
    const prices: NormalizedPrice[] = [
      {
        asset: 'XLM',
        price: BigInt('12000000'),
        decimals: 8,
        source: 'chainlink',
        timestamp: Math.floor(Date.now() / 1000),
        observedAt: null,
        fetchedAt: Math.floor(Date.now() / 1000),
      },
    ];

    const result = medianOnCommonScale(prices);

    expect(result.decimals).toBeGreaterThanOrEqual(8);
  });
});
