import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { httpClient } from '../src/utils/http-client';
import { ChainlinkSource } from '../src/sources/chainlink';
import { RedstoneSource } from '../src/sources/redstone';
import { BandSource } from '../src/sources/band';
import { ReflectorSource } from '../src/sources/reflector';
import { PriceAggregator } from '../src/aggregator';
import { appendHistoricalPrice, getHistoricalPrices, ensureDataDir } from '../src/utils/history';
import { HealthServer } from '../src/health-server';
import { BaseSource } from '../src/sources/base';
import { WebSocketServer } from '../src/ws-server';
import * as path from 'path';

vi.mock('fs', () => {
  const mockFiles = new Map<string, string>();
  return {
    default: {
      existsSync: vi.fn((p: string) => mockFiles.has(p)),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn((p: string, data: string) => { mockFiles.set(p, data); }),
      readFileSync: vi.fn((p: string) => mockFiles.get(p) || '[]'),
    },
    existsSync: vi.fn((p: string) => mockFiles.has(p)),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn((p: string, data: string) => { mockFiles.set(p, data); }),
    readFileSync: vi.fn((p: string) => mockFiles.get(p) || '[]'),
  };
});

vi.mock('../src/utils/http-client', () => ({
  httpClient: {
    get: vi.fn(),
  },
}));

vi.mock('../src/source-circuit-breaker', () => ({
  sourceCircuitBreaker: {
    isAllowed: vi.fn(() => true),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
  },
}));

const mockedHttpClient = vi.mocked(httpClient);

function mockGet(_url: string, data: unknown) {
  mockedHttpClient.get.mockResolvedValue({ data } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
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
    mockedHttpClient.get.mockRejectedValue(new Error('Network error'));
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

  it('marks critical degradation when all sources stale', () => {
    const aggregator = new PriceAggregator();
    const stale = Math.floor(Date.now() / 1000) - 300;

    aggregator.updateSourcePrice({ asset: 'XLM', price: 100n, decimals: 7, source: 'chainlink', timestamp: stale });

    const result = aggregator.getLatestForAsset('XLM');
    expect(result).not.toBeNull();
    expect(result!.degradationLevel).toBe('critical');
    expect(result!.stale).toBe(true);
  });

  it('returns degraded when fewer than all sources available', () => {
    const aggregator = new PriceAggregator();
    const ts = Math.floor(Date.now() / 1000);

    aggregator.updateSourcePrice({ asset: 'XLM', price: 100n, decimals: 7, source: 'chainlink', timestamp: ts });

    const result = aggregator.getLatestForAsset('XLM');
    expect(result).not.toBeNull();
    expect(result!.degradationLevel).toBe('healthy');
  });

  it('computes correct source count', () => {
    const aggregator = new PriceAggregator();
    const ts = Math.floor(Date.now() / 1000);
    aggregator.updateSourcePrice({ asset: 'XLM', price: 100n, decimals: 7, source: 'chainlink', timestamp: ts });
    aggregator.updateSourcePrice({ asset: 'XLM', price: 101n, decimals: 7, source: 'redstone', timestamp: ts });
    aggregator.updateSourcePrice({ asset: 'XLM', price: 102n, decimals: 7, source: 'band', timestamp: ts });
    expect(aggregator.getSourceCount()).toBe(3);
  });

  it('handles even-numbered price sets for median', () => {
    const aggregator = new PriceAggregator();
    const ts = Math.floor(Date.now() / 1000);

    aggregator.updateSourcePrice({ asset: 'XLM', price: 100n, decimals: 7, source: 'chainlink', timestamp: ts });
    aggregator.updateSourcePrice({ asset: 'XLM', price: 110n, decimals: 7, source: 'redstone', timestamp: ts });

    const result = aggregator.getLatestForAsset('XLM');
    expect(result).not.toBeNull();
    expect(result!.price).toBe('105');
  });

  it('provides circuit breaker metrics', () => {
    const aggregator = new PriceAggregator();
    const metrics = aggregator.getCircuitBreakerMetrics();
    expect(metrics).toBeDefined();
    expect(metrics).toHaveProperty('totalSources');
    expect(metrics).toHaveProperty('suspiciousSources');
    expect(metrics).toHaveProperty('suspiciousSourcesList');
  });

  it('returns empty suspicious sources list initially', () => {
    const aggregator = new PriceAggregator();
    expect(aggregator.getSuspiciousSources()).toEqual([]);
  });

  it('resets circuit breaker', () => {
    const aggregator = new PriceAggregator();
    expect(() => aggregator.resetCircuitBreaker()).not.toThrow();
    expect(() => aggregator.resetCircuitBreaker('chainlink:XLM')).not.toThrow();
  });
});

describe('Exponential Backoff', () => {
  it('retries on failure', async () => {
    mockedHttpClient.get
      .mockRejectedValueOnce(new Error('Fail 1'))
      .mockRejectedValueOnce(new Error('Fail 2'))
      .mockResolvedValueOnce({ data: { USD: { PRICE: 0.12 } } } as never);

    const source = new ChainlinkSource();
    const price = await source.fetchWithBackoff('XLM', 1);

    expect(price).not.toBeNull();
    expect(mockedHttpClient.get).toHaveBeenCalledTimes(3);
  });

  it('gives up after max retries', async () => {
    mockedHttpClient.get.mockRejectedValue(new Error('Persistent failure'));

    const source = new ChainlinkSource();
    const price = await source.fetchWithBackoff('XLM', 1);

    expect(price).toBeNull();
    expect(mockedHttpClient.get).toHaveBeenCalledTimes(3);
  });

  it('tracks health metrics', async () => {
    mockedHttpClient.get
      .mockRejectedValueOnce(new Error('Fail'))
      .mockResolvedValueOnce({ data: { USD: { PRICE: 0.12 } } } as never);

    const source = new ChainlinkSource();
    await source.fetchWithBackoff('XLM', 1);

    await source.fetchWithBackoff('XLM', 1);

    expect(source.health.totalRequests).toBeGreaterThanOrEqual(2);
    expect(source.health.totalFailures).toBeGreaterThanOrEqual(1);
    expect(source.health.uptimePercent).toBeLessThan(100);
  });
});

describe('HistoryService', () => {
  const testAsset = 'TEST';

  it('creates data directory on ensureDataDir', () => {
    ensureDataDir();
  });

  it('appends historical price', () => {
    appendHistoricalPrice(testAsset, '100', 7, 'chainlink', 1719000000);
  });

  it('returns empty array when no history file exists', () => {
    const prices = getHistoricalPrices('NONEXISTENT');
    expect(prices).toEqual([]);
  });
});

describe('HealthServer', () => {
  it('starts and stops without error', () => {
    const snapshot = () => ({
      sourceHealth: { chainlink: { healthy: true, consecutiveFailures: 0, uptimePercent: 100 } },
      lastAggregated: [{ asset: 'XLM', price: '100' }],
      uptime: 100,
    });
    const server = new HealthServer(0, snapshot);
    expect(() => server.start()).not.toThrow();
    expect(() => server.stop()).not.toThrow();
  });

  it('handles empty snapshot', () => {
    const snapshot = () => ({
      sourceHealth: {},
      lastAggregated: [],
      uptime: 0,
    });
    const server = new HealthServer(0, snapshot);
    expect(() => server.start()).not.toThrow();
    expect(() => server.stop()).not.toThrow();
  });
});

describe('WebSocketServer', () => {
  it('starts and stops without error', () => {
    const server = new WebSocketServer(-1);
    expect(() => server.start()).not.toThrow();
    expect(() => server.stop()).not.toThrow();
  });

  it('broadcasts without crashing when no clients', () => {
    const server = new WebSocketServer(-1);
    server.start();
    expect(() => server.broadcast({ type: 'test', data: 'hello' })).not.toThrow();
    server.stop();
  });
});

describe('BaseSource normalize', () => {
  class TestSource extends BaseSource {
    name = 'chainlink' as const;
    async fetchPrice(_asset: string) {
      return null;
    }
  }

  it('normalizes integer prices correctly', () => {
    const source = new TestSource();
    const result = source['normalize']('XLM', '123', 7, 1719000000);
    expect(result.asset).toBe('XLM');
    expect(result.price).toBe(1230000000n);
    expect(result.decimals).toBe(7);
    expect(result.source).toBe('chainlink');
  });

  it('normalizes decimal prices correctly', () => {
    const source = new TestSource();
    const result = source['normalize']('btc', '65000.50', 8, 1719000000);
    expect(result.asset).toBe('BTC');
    expect(result.price).toBe(6500050000000n);
  });

  it('normalizes BigNumber prices', () => {
    const source = new TestSource();
    const { default: BigNumber } = require('bignumber.js');
    const result = source['normalize']('eth', new BigNumber('3500'), 18, 1719000000);
    expect(result.asset).toBe('ETH');
    expect(result.price).toBe(3500000000000000000000n);
  });

  it('fetchAll returns array of prices', async () => {
    const source = new TestSource();
    vi.spyOn(source, 'fetchWithBackoff').mockResolvedValue({
      asset: 'XLM', price: 100n, decimals: 7, source: 'chainlink', timestamp: 1719000000,
    });
    const prices = await source.fetchAll(['XLM', 'BTC']);
    expect(prices).toHaveLength(2);
  });
});
