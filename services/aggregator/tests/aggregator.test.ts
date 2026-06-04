import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { ChainlinkSource } from '../src/sources/chainlink';
import { RedstoneSource } from '../src/sources/redstone';
import { BandSource } from '../src/sources/band';
import { ReflectorSource } from '../src/sources/reflector';
import { PriceAggregator } from '../src/aggregator';

vi.mock('axios');
const mockedAxios = vi.mocked(axios, true);

function mockGet(url: string, data: any) {
  (mockedAxios.get as any).mockResolvedValue({ data });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ChainlinkSource', () => {
  it('fetches and normalizes XLM price', async () => {
    mockGet('https://min-api.cryptocompare.com/data/price', {
      USD: { PRICE: 0.12 },
    });

    const source = new ChainlinkSource();
    const price = await source.fetchPrice('XLM');

    expect(price).not.toBeNull();
    expect(price!.asset).toBe('XLM');
    expect(price!.decimals).toBe(8);
    expect(price!.source).toBe('chainlink');
    expect(price!.price).toBeGreaterThan(0n);
  });

  it('returns null on API failure', async () => {
    (mockedAxios.get as any).mockRejectedValue(new Error('Network error'));
    const source = new ChainlinkSource();
    const price = await source.fetchWithBackoff('XLM');
    expect(price).toBeNull();
  });
});

describe('RedstoneSource', () => {
  it('fetches and normalizes BTC price', async () => {
    mockGet('https://api.redstone.finance/prices', {
      BTC: { value: '65000', decimals: 8 },
    });

    const source = new RedstoneSource();
    const price = await source.fetchPrice('BTC');

    expect(price).not.toBeNull();
    expect(price!.asset).toBe('BTC');
    expect(price!.source).toBe('redstone');
  });
});

describe('BandSource', () => {
  it('fetches and normalizes ETH price', async () => {
    mockGet('https://laozi1.bandchain.org/api/oracle/v1/feeds/ETH-USD', {
      data: { price: '3500000000000000000000', decimals: 18, updated_at: 1719000000 },
    });

    const source = new BandSource();
    const price = await source.fetchPrice('ETH');

    expect(price).not.toBeNull();
    expect(price!.asset).toBe('ETH');
    expect(price!.source).toBe('band');
  });
});

describe('ReflectorSource', () => {
  it('fetches and normalizes USDC price', async () => {
    mockGet('https://api.reflector.xyz/v1/prices', {
      prices: { 'Crypto.USDC/USD': { price: '1.00', decimals: 8, timestamp: 1719000000 } },
    });

    const source = new ReflectorSource();
    const price = await source.fetchPrice('USDC');

    expect(price).not.toBeNull();
    expect(price!.asset).toBe('USDC');
    expect(price!.source).toBe('reflector');
  });
});

describe('PriceAggregator', () => {
  it('computes median from multiple sources', () => {
    const aggregator = new PriceAggregator();
    const ts = Math.floor(Date.now() / 1000);

    aggregator.updateSourcePrice({ asset: 'XLM', price: 100n, decimals: 7, source: 'chainlink', timestamp: ts });
    aggregator.updateSourcePrice({ asset: 'XLM', price: 102n, decimals: 7, source: 'redstone', timestamp: ts });
    aggregator.updateSourcePrice({ asset: 'XLM', price: 101n, decimals: 7, source: 'band', timestamp: ts });

    const result = aggregator.getLatestForAsset('XLM');
    expect(result).not.toBeNull();
    expect(result!.price).toBe('101');
    expect(result!.sources).toHaveLength(3);
    expect(result!.confidence).toBe(1);
  });

  it('returns null if no prices for asset', () => {
    const aggregator = new PriceAggregator();
    expect(aggregator.getLatestForAsset('DOGE')).toBeNull();
  });

  it('filters stale prices', () => {
    const aggregator = new PriceAggregator();
    const stale = Math.floor(Date.now() / 1000) - 300;

    aggregator.updateSourcePrice({ asset: 'XLM', price: 100n, decimals: 7, source: 'chainlink', timestamp: stale });
    aggregator.updateSourcePrice({ asset: 'XLM', price: 102n, decimals: 7, source: 'redstone', timestamp: Math.floor(Date.now() / 1000) });

    const result = aggregator.getLatestForAsset('XLM');
    expect(result).not.toBeNull();
    expect(result!.sources).toHaveLength(1);
  });

  it('returns all tracked assets', () => {
    const aggregator = new PriceAggregator();
    const ts = Math.floor(Date.now() / 1000);

    aggregator.updateSourcePrice({ asset: 'XLM', price: 100n, decimals: 7, source: 'chainlink', timestamp: ts });
    aggregator.updateSourcePrice({ asset: 'BTC', price: 100n, decimals: 8, source: 'chainlink', timestamp: ts });

    const all = aggregator.getAllPrices();
    expect(all).toHaveLength(2);
  });
});

describe('Exponential Backoff', () => {
  it('retries on failure', async () => {
    (mockedAxios.get as any)
      .mockRejectedValueOnce(new Error('Fail 1'))
      .mockRejectedValueOnce(new Error('Fail 2'))
      .mockResolvedValueOnce({ data: { USD: { PRICE: 0.12 } } });

    const source = new ChainlinkSource();
    const price = await source.fetchWithBackoff('XLM', 1);

    expect(price).not.toBeNull();
    expect(mockedAxios.get).toHaveBeenCalledTimes(3);
  });

  it('gives up after max retries', async () => {
    (mockedAxios.get as any).mockRejectedValue(new Error('Persistent failure'));

    const source = new ChainlinkSource();
    const price = await source.fetchWithBackoff('XLM', 1);

    expect(price).toBeNull();
    expect(mockedAxios.get).toHaveBeenCalledTimes(3);
  });

  it('tracks health metrics', async () => {
    (mockedAxios.get as any)
      .mockRejectedValueOnce(new Error('Fail'))
      .mockResolvedValueOnce({ data: { USD: { PRICE: 0.12 } } });

    const source = new ChainlinkSource();
    await source.fetchWithBackoff('XLM', 1);

    await source.fetchWithBackoff('XLM', 1);

    expect(source.health.totalRequests).toBeGreaterThanOrEqual(2);
    expect(source.health.totalFailures).toBeGreaterThanOrEqual(1);
    expect(source.health.uptimePercent).toBeLessThan(100);
  });
});
