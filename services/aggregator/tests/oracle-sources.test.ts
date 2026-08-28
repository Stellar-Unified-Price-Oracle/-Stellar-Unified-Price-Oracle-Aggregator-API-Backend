import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { httpClient } from '../src/infrastructure/http-client';
import { ChainlinkSource } from '../src/oracle-sources/chainlink';
import { RedstoneSource } from '../src/oracle-sources/redstone';
import { BandSource } from '../src/oracle-sources/band';
import { ReflectorSource } from '../src/oracle-sources/reflector';

vi.mock('../src/infrastructure/http-client', () => ({
  httpClient: {
    get: vi.fn(),
  },
}));

vi.mock('../src/price-aggregation/source-circuit-breaker', () => ({
  sourceCircuitBreaker: {
    isAllowed: vi.fn(() => true),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
  },
}));

vi.mock('../src/observability/metrics', () => {
  const mockGauge = { set: vi.fn(), inc: vi.fn() };
  const mockCounter = { inc: vi.fn() };
  const mockHistogram = {
    startTimer: vi.fn(() => (labels?: Record<string, string>) => 0),
  };
  return {
    oracleSourceLatency: mockHistogram,
    oracleSourceRequestsTotal: mockCounter,
    oracleSourceSlaBreaches: mockCounter,
    oracleApiCallsTotal: mockCounter,
    oracleApiCostTotal: mockCounter,
    oracleApiBudgetUtilization: mockGauge,
  };
});

const mockedHttpClient = vi.mocked(httpClient);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────
// ChainlinkSource
// ─────────────────────────────────────────────────────────────
describe('ChainlinkSource', () => {
  it('fetches and normalizes XLM price successfully', async () => {
    mockedHttpClient.get.mockResolvedValue({
      data: { USD: { PRICE: 0.12 } },
    } as never);

    const source = new ChainlinkSource();
    const price = await source.fetchPrice('XLM');

    expect(price).not.toBeNull();
    expect(price!.asset).toBe('XLM');
    expect(price!.decimals).toBe(8);
    expect(price!.source).toBe('chainlink');
    expect(price!.price).toBe(12000000n);
    expect(mockedHttpClient.get).toHaveBeenCalledWith(
      expect.stringContaining('/price'),
      expect.objectContaining({
        params: expect.objectContaining({ fsym: 'XLM' }),
      }),
    );
  });

  it('fetches and normalizes BTC price successfully', async () => {
    mockedHttpClient.get.mockResolvedValue({
      data: { USD: { PRICE: 65000.50 } },
    } as never);

    const source = new ChainlinkSource();
    const price = await source.fetchPrice('BTC');

    expect(price).not.toBeNull();
    expect(price!.asset).toBe('BTC');
    expect(price!.source).toBe('chainlink');
    expect(price!.price).toBe(6500050000000n);
  });

  it('returns null when API response has no USD.PRICE', async () => {
    mockedHttpClient.get.mockResolvedValue({
      data: { USD: {} },
    } as never);

    const source = new ChainlinkSource();
    const price = await source.fetchPrice('XLM');

    expect(price).toBeNull();
  });

  it('returns null when API response has no USD at all', async () => {
    mockedHttpClient.get.mockResolvedValue({
      data: {},
    } as never);

    const source = new ChainlinkSource();
    const price = await source.fetchPrice('XLM');

    expect(price).toBeNull();
  });

  it('returns null when API response data is null', async () => {
    mockedHttpClient.get.mockResolvedValue({
      data: null,
    } as never);

    const source = new ChainlinkSource();
    const price = await source.fetchPrice('XLM');

    expect(price).toBeNull();
  });

  it('returns null on network error (via fetchWithBackoff)', async () => {
    mockedHttpClient.get.mockRejectedValue(new Error('Network error'));

    const source = new ChainlinkSource();
    const price = await source.fetchWithBackoff('XLM');

    expect(price).toBeNull();
  });

  it('returns null on timeout error (via fetchWithBackoff)', async () => {
    mockedHttpClient.get.mockRejectedValue(new Error('timeout of 5000ms exceeded'));

    const source = new ChainlinkSource();
    const price = await source.fetchWithBackoff('XLM');

    expect(price).toBeNull();
  });

  it('handles malformed response — PRICE is null', async () => {
    mockedHttpClient.get.mockResolvedValue({
      data: { USD: { PRICE: null } },
    } as never);

    const source = new ChainlinkSource();
    const price = await source.fetchPrice('XLM');

    expect(price).toBeNull();
  });

  it('maps USDC symbol correctly', async () => {
    mockedHttpClient.get.mockResolvedValue({
      data: { USD: { PRICE: 1.0 } },
    } as never);

    const source = new ChainlinkSource();
    const price = await source.fetchPrice('USDC');

    expect(price).not.toBeNull();
    expect(price!.asset).toBe('USDC');
    expect(mockedHttpClient.get).toHaveBeenCalledWith(
      expect.stringContaining('/price'),
      expect.objectContaining({
        params: expect.objectContaining({ fsym: 'USDC' }),
      }),
    );
  });

  it('maps USDT symbol correctly', async () => {
    mockedHttpClient.get.mockResolvedValue({
      data: { USD: { PRICE: 1.0 } },
    } as never);

    const source = new ChainlinkSource();
    await source.fetchPrice('USDT');

    expect(mockedHttpClient.get).toHaveBeenCalledWith(
      expect.stringContaining('/price'),
      expect.objectContaining({
        params: expect.objectContaining({ fsym: 'USDT' }),
      }),
    );
  });

  it('falls back to original asset for unmapped symbol', async () => {
    mockedHttpClient.get.mockResolvedValue({
      data: { USD: { PRICE: 100 } },
    } as never);

    const source = new ChainlinkSource();
    await source.fetchPrice('unknown');

    expect(mockedHttpClient.get).toHaveBeenCalledWith(
      expect.stringContaining('/price'),
      expect.objectContaining({
        params: expect.objectContaining({ fsym: 'unknown' }),
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────
// RedstoneSource
// ─────────────────────────────────────────────────────────────
describe('RedstoneSource', () => {
  it('fetches and normalizes BTC price successfully', async () => {
    mockedHttpClient.get.mockResolvedValue({
      data: { BTC: { value: '65000', decimals: 8 } },
    } as never);

    const source = new RedstoneSource();
    const price = await source.fetchPrice('BTC');

    expect(price).not.toBeNull();
    expect(price!.asset).toBe('BTC');
    expect(price!.source).toBe('redstone');
    expect(price!.decimals).toBe(8);
    expect(price!.price).toBe(6500000000000n);
  });

  it('fetches and normalizes ETH price with default decimals=8', async () => {
    mockedHttpClient.get.mockResolvedValue({
      data: { ETH: { value: '3500' } },
    } as never);

    const source = new RedstoneSource();
    const price = await source.fetchPrice('ETH');

    expect(price).not.toBeNull();
    expect(price!.decimals).toBe(8);
    expect(price!.price).toBe(350000000000n);
  });

  it('returns null when asset not in response data', async () => {
    mockedHttpClient.get.mockResolvedValue({
      data: {},
    } as never);

    const source = new RedstoneSource();
    const price = await source.fetchPrice('XLM');

    expect(price).toBeNull();
  });

  it('returns null when value is missing', async () => {
    mockedHttpClient.get.mockResolvedValue({
      data: { XLM: { decimals: 8 } },
    } as never);

    const source = new RedstoneSource();
    const price = await source.fetchPrice('XLM');

    expect(price).toBeNull();
  });

  it('returns null when data is null', async () => {
    mockedHttpClient.get.mockResolvedValue({
      data: null,
    } as never);

    const source = new RedstoneSource();
    const price = await source.fetchPrice('XLM');

    expect(price).toBeNull();
  });

  it('returns null on network error (via fetchWithBackoff)', async () => {
    mockedHttpClient.get.mockRejectedValue(new Error('Network error'));

    const source = new RedstoneSource();
    const price = await source.fetchWithBackoff('XLM');

    expect(price).toBeNull();
  });

  it('returns null on ECONNREFUSED error (via fetchWithBackoff)', async () => {
    mockedHttpClient.get.mockRejectedValue(new Error('ECONNREFUSED'));

    const source = new RedstoneSource();
    const price = await source.fetchWithBackoff('XLM');

    expect(price).toBeNull();
  });

  it('returns null on timeout error (via fetchWithBackoff)', async () => {
    mockedHttpClient.get.mockRejectedValue(new Error('timeout of 5000ms exceeded'));

    const source = new RedstoneSource();
    const price = await source.fetchWithBackoff('XLM');

    expect(price).toBeNull();
  });

  it('handles malformed response — value is empty string', async () => {
    mockedHttpClient.get.mockResolvedValue({
      data: { XLM: { value: '' } },
    } as never);

    const source = new RedstoneSource();
    const price = await source.fetchPrice('XLM');

    expect(price).toBeNull();
  });

  it('uppercases asset symbol in request params', async () => {
    mockedHttpClient.get.mockResolvedValue({
      data: { XLM: { value: '0.12', decimals: 8 } },
    } as never);

    const source = new RedstoneSource();
    await source.fetchPrice('xlm');

    expect(mockedHttpClient.get).toHaveBeenCalledWith(
      expect.stringContaining('/prices'),
      expect.objectContaining({
        params: expect.objectContaining({ symbols: 'XLM' }),
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────
// BandSource
// ─────────────────────────────────────────────────────────────
describe('BandSource', () => {
  it('fetches and normalizes ETH price successfully', async () => {
    mockedHttpClient.get.mockResolvedValue({
      data: {
        data: { price: '3500000000000000000000', decimals: 18, updated_at: 1719000000 },
      },
    } as never);

    const source = new BandSource();
    const price = await source.fetchPrice('ETH');

    expect(price).not.toBeNull();
    expect(price!.asset).toBe('ETH');
    expect(price!.source).toBe('band');
    expect(price!.decimals).toBe(18);
    expect(price!.price).toBe(3500000000000000000000000000000000000000n);
    expect(price!.timestamp).toBe(1719000000);
  });

  it('fetches and normalizes XLM price with default decimals=9', async () => {
    mockedHttpClient.get.mockResolvedValue({
      data: {
        data: { price: '12000000', updated_at: 1719000000 },
      },
    } as never);

    const source = new BandSource();
    const price = await source.fetchPrice('XLM');

    expect(price).not.toBeNull();
    expect(price!.decimals).toBe(9);
    expect(price!.price).toBe(12000000000000000n);
  });

  it('uses current time when updated_at is missing', async () => {
    const now = Math.floor(Date.now() / 1000);
    mockedHttpClient.get.mockResolvedValue({
      data: { data: { price: '12000000' } },
    } as never);

    const source = new BandSource();
    const price = await source.fetchPrice('XLM');

    expect(price).not.toBeNull();
    expect(price!.timestamp).toBe(now);
  });

  it('returns null when data.data.price is missing', async () => {
    mockedHttpClient.get.mockResolvedValue({
      data: { data: {} },
    } as never);

    const source = new BandSource();
    const price = await source.fetchPrice('XLM');

    expect(price).toBeNull();
  });

  it('returns null when data.data is null', async () => {
    mockedHttpClient.get.mockResolvedValue({
      data: { data: null },
    } as never);

    const source = new BandSource();
    const price = await source.fetchPrice('XLM');

    expect(price).toBeNull();
  });

  it('returns null when data is null', async () => {
    mockedHttpClient.get.mockResolvedValue({
      data: null,
    } as never);

    const source = new BandSource();
    const price = await source.fetchPrice('XLM');

    expect(price).toBeNull();
  });

  it('returns null on network error (via fetchWithBackoff)', async () => {
    mockedHttpClient.get.mockRejectedValue(new Error('Network error'));

    const source = new BandSource();
    const price = await source.fetchWithBackoff('XLM');

    expect(price).toBeNull();
  });

  it('returns null on timeout error (via fetchWithBackoff)', async () => {
    mockedHttpClient.get.mockRejectedValue(new Error('ETIMEDOUT'));

    const source = new BandSource();
    const price = await source.fetchWithBackoff('XLM');

    expect(price).toBeNull();
  });

  it('maps USDC to USDC-USD', async () => {
    mockedHttpClient.get.mockResolvedValue({
      data: { data: { price: '100000000', decimals: 8 } },
    } as never);

    const source = new BandSource();
    await source.fetchPrice('USDC');

    expect(mockedHttpClient.get).toHaveBeenCalledWith(
      expect.stringContaining('/oracle/v1/feeds/USDC-USD'),
    );
  });

  it('maps BTC to BTC-USD', async () => {
    mockedHttpClient.get.mockResolvedValue({
      data: { data: { price: '6500000000000', decimals: 8 } },
    } as never);

    const source = new BandSource();
    await source.fetchPrice('BTC');

    expect(mockedHttpClient.get).toHaveBeenCalledWith(
      expect.stringContaining('/oracle/v1/feeds/BTC-USD'),
    );
  });

  it('falls back to {symbol}-USD for unknown assets', async () => {
    mockedHttpClient.get.mockResolvedValue({
      data: { data: { price: '100' } },
    } as never);

    const source = new BandSource();
    await source.fetchPrice('DOGE');

    expect(mockedHttpClient.get).toHaveBeenCalledWith(
      expect.stringContaining('/oracle/v1/feeds/DOGE-USD'),
    );
  });

  it('rejects on malformed non-numeric price', async () => {
    mockedHttpClient.get.mockResolvedValue({
      data: { data: { price: 'not-a-number' } },
    } as never);

    const source = new BandSource();
    await expect(source.fetchPrice('XLM')).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// ReflectorSource
// ─────────────────────────────────────────────────────────────
describe('ReflectorSource', () => {
  it('fetches and normalizes USDC price successfully', async () => {
    mockedHttpClient.get.mockResolvedValue({
      data: {
        prices: { 'Crypto.USDC/USD': { price: '1.00', decimals: 8, timestamp: 1719000000 } },
      },
    } as never);

    const source = new ReflectorSource();
    const price = await source.fetchPrice('USDC');

    expect(price).not.toBeNull();
    expect(price!.asset).toBe('USDC');
    expect(price!.source).toBe('reflector');
    expect(price!.decimals).toBe(8);
    expect(price!.price).toBe(100000000n);
    expect(price!.timestamp).toBe(1719000000);
  });

  it('fetches and normalizes XLM price with default decimals=8', async () => {
    mockedHttpClient.get.mockResolvedValue({
      data: {
        prices: { 'Crypto.XLM/USD': { price: '0.12' } },
      },
    } as never);

    const source = new ReflectorSource();
    const price = await source.fetchPrice('XLM');

    expect(price).not.toBeNull();
    expect(price!.decimals).toBe(8);
    expect(price!.price).toBe(12000000n);
  });

  it('uses current time when timestamp is missing', async () => {
    const now = Math.floor(Date.now() / 1000);
    mockedHttpClient.get.mockResolvedValue({
      data: { prices: { 'Crypto.XLM/USD': { price: '0.12', decimals: 8 } } },
    } as never);

    const source = new ReflectorSource();
    const price = await source.fetchPrice('XLM');

    expect(price).not.toBeNull();
    expect(price!.timestamp).toBe(now);
  });

  it('returns null when prices object is missing', async () => {
    mockedHttpClient.get.mockResolvedValue({
      data: {},
    } as never);

    const source = new ReflectorSource();
    const price = await source.fetchPrice('XLM');

    expect(price).toBeNull();
  });

  it('returns null when asset symbol not in prices', async () => {
    mockedHttpClient.get.mockResolvedValue({
      data: { prices: {} },
    } as never);

    const source = new ReflectorSource();
    const price = await source.fetchPrice('XLM');

    expect(price).toBeNull();
  });

  it('returns null when price field is missing', async () => {
    mockedHttpClient.get.mockResolvedValue({
      data: { prices: { 'Crypto.XLM/USD': { decimals: 8 } } },
    } as never);

    const source = new ReflectorSource();
    const price = await source.fetchPrice('XLM');

    expect(price).toBeNull();
  });

  it('returns null when data is null', async () => {
    mockedHttpClient.get.mockResolvedValue({
      data: null,
    } as never);

    const source = new ReflectorSource();
    const price = await source.fetchPrice('XLM');

    expect(price).toBeNull();
  });

  it('returns null on network error (via fetchWithBackoff)', async () => {
    mockedHttpClient.get.mockRejectedValue(new Error('Network error'));

    const source = new ReflectorSource();
    const price = await source.fetchWithBackoff('XLM');

    expect(price).toBeNull();
  });

  it('returns null on ETIMEDOUT error (via fetchWithBackoff)', async () => {
    mockedHttpClient.get.mockRejectedValue(new Error('ETIMEDOUT'));

    const source = new ReflectorSource();
    const price = await source.fetchWithBackoff('XLM');

    expect(price).toBeNull();
  });

  it('constructs correct symbol format', async () => {
    mockedHttpClient.get.mockResolvedValue({
      data: { prices: { 'Crypto.BTC/USD': { price: '65000', decimals: 8 } } },
    } as never);

    const source = new ReflectorSource();
    await source.fetchPrice('BTC');

    expect(mockedHttpClient.get).toHaveBeenCalledWith(
      expect.stringContaining('/v1/prices'),
      expect.objectContaining({
        params: expect.objectContaining({ asset: 'Crypto.BTC/USD' }),
      }),
    );
  });

  it('handles malformed response — price is empty string', async () => {
    mockedHttpClient.get.mockResolvedValue({
      data: { prices: { 'Crypto.XLM/USD': { price: '' } } },
    } as never);

    const source = new ReflectorSource();
    const price = await source.fetchPrice('XLM');

    expect(price).toBeNull();
  });

  it('handles malformed response — price is null', async () => {
    mockedHttpClient.get.mockResolvedValue({
      data: { prices: { 'Crypto.XLM/USD': { price: null } } },
    } as never);

    const source = new ReflectorSource();
    const price = await source.fetchPrice('XLM');

    expect(price).toBeNull();
  });
});
