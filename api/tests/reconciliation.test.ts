import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ReconciliationJob, CacheAccessor } from '../src/infrastructure/reconciliation';

vi.mock('../src/observability/metrics', () => {
  const makeCounter = () => ({ inc: vi.fn() });
  const makeGauge = () => ({ set: vi.fn() });
  return {
    register: { registerMetric: vi.fn() },
    httpRequestDuration: makeCounter(),
    httpRequestsTotal: makeCounter(),
  };
});

vi.mock('prom-client', () => {
  const Counter = vi.fn(() => ({ inc: vi.fn() }));
  const Gauge = vi.fn(() => ({ set: vi.fn() }));
  const Histogram = vi.fn(() => ({ observe: vi.fn(), startTimer: vi.fn(() => vi.fn()) }));
  const Registry = vi.fn(() => ({ registerMetric: vi.fn() }));
  return { default: { Counter, Gauge, Histogram, Registry, collectDefaultMetrics: vi.fn() } };
});

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as any;
}

function makeDb(prices: { asset: string; price: string; timestamp: number; decimals: number; source: string }[] = []) {
  return {
    getAllLatestPrices: vi.fn().mockResolvedValue(prices),
  } as any;
}

function makeCache(entries: Record<string, unknown> = {}): CacheAccessor {
  return {
    get: vi.fn((key: string) => {
      const asset = key.replace(/^price:/, '');
      return Promise.resolve(entries[asset] ?? entries[key] ?? null);
    }),
  };
}

function mockFetch(responses: Record<string, { ok: boolean; body: unknown }>) {
  return vi.fn((url: string) => {
    const asset = decodeURIComponent(url.split('/').pop() ?? '');
    const resp = responses[asset];
    if (!resp) return Promise.resolve({ ok: false, json: async () => ({}) });
    return Promise.resolve({
      ok: resp.ok,
      json: async () => resp.body,
    });
  }) as any;
}

describe('ReconciliationJob', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('checkChainVsDb', () => {
    it('detects price divergence above tolerance', async () => {
      const dbPrices = [{ asset: 'XLM', price: '0.100000', timestamp: 1000, decimals: 7, source: 'aggregator' }];
      const db = makeDb(dbPrices);
      const cache = makeCache();
      const logger = makeLogger();

      vi.stubGlobal('fetch', mockFetch({
        XLM: { ok: true, body: { price: '0.200000', timestamp: 1000 } },
      }));

      const job = new ReconciliationJob(db, cache, 'http://rpc.example.com', logger);
      const result = await job.checkChainVsDb();

      expect(result.layer).toBe('chain→db');
      expect(result.status).toBe('violation');
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].asset).toBe('XLM');
      expect(result.violations[0].diff).toMatch(/price divergence/);
      expect(logger.warn).toHaveBeenCalledOnce();
    });

    it('passes when price is within tolerance', async () => {
      const dbPrices = [{ asset: 'XLM', price: '0.100000', timestamp: 1000, decimals: 7, source: 'aggregator' }];
      const db = makeDb(dbPrices);
      const cache = makeCache();
      const logger = makeLogger();

      vi.stubGlobal('fetch', mockFetch({
        XLM: { ok: true, body: { price: '0.100500', timestamp: 1000 } },
      }));

      const job = new ReconciliationJob(db, cache, 'http://rpc.example.com', logger, { priceTolerance: 0.01 });
      const result = await job.checkChainVsDb();

      expect(result.status).toBe('ok');
      expect(result.violations).toHaveLength(0);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('flags timestamp drift above tolerance', async () => {
      const dbPrices = [{ asset: 'BTC', price: '50000.00', timestamp: 1000, decimals: 8, source: 'aggregator' }];
      const db = makeDb(dbPrices);
      const cache = makeCache();
      const logger = makeLogger();

      vi.stubGlobal('fetch', mockFetch({
        BTC: { ok: true, body: { price: '50000.00', timestamp: 1500 } },
      }));

      const job = new ReconciliationJob(db, cache, 'http://rpc.example.com', logger, { timestampToleranceSec: 300 });
      const result = await job.checkChainVsDb();

      expect(result.status).toBe('violation');
      expect(result.violations[0].diff).toMatch(/timestamp drift/);
    });

    it('skips assets where chain RPC returns non-ok response', async () => {
      const dbPrices = [{ asset: 'ETH', price: '3000.00', timestamp: 1000, decimals: 8, source: 'aggregator' }];
      const db = makeDb(dbPrices);
      const cache = makeCache();
      const logger = makeLogger();

      vi.stubGlobal('fetch', mockFetch({
        ETH: { ok: false, body: {} },
      }));

      const job = new ReconciliationJob(db, cache, 'http://rpc.example.com', logger);
      const result = await job.checkChainVsDb();

      expect(result.status).toBe('ok');
      expect(result.violations).toHaveLength(0);
    });

    it('returns ok with skipped detail when DB has no prices', async () => {
      const db = makeDb([]);
      const cache = makeCache();
      const logger = makeLogger();

      const job = new ReconciliationJob(db, cache, 'http://rpc.example.com', logger);
      const result = await job.checkChainVsDb();

      expect(result.status).toBe('ok');
      expect(result.details).toMatch(/no DB prices/);
    });
  });

  describe('checkCacheVsDb', () => {
    it('detects stale cache entry (price divergence)', async () => {
      const dbPrices = [{ asset: 'XLM', price: '0.100000', timestamp: 1000, decimals: 7, source: 'aggregator' }];
      const db = makeDb(dbPrices);
      const cache = makeCache({ XLM: { price: '0.200000', timestamp: 1000 } });
      const logger = makeLogger();

      const job = new ReconciliationJob(db, cache, 'http://rpc.example.com', logger);
      const result = await job.checkCacheVsDb();

      expect(result.layer).toBe('cache→db');
      expect(result.status).toBe('violation');
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].asset).toBe('XLM');
      expect(result.violations[0].diff).toMatch(/cache price divergence/);
      expect(logger.warn).toHaveBeenCalledOnce();
    });

    it('detects stale cache entry (timestamp drift)', async () => {
      const dbPrices = [{ asset: 'XLM', price: '0.100000', timestamp: 1000, decimals: 7, source: 'aggregator' }];
      const db = makeDb(dbPrices);
      const cache = makeCache({ XLM: { price: '0.100000', timestamp: 400 } });
      const logger = makeLogger();

      const job = new ReconciliationJob(db, cache, 'http://rpc.example.com', logger, { timestampToleranceSec: 300 });
      const result = await job.checkCacheVsDb();

      expect(result.status).toBe('violation');
      expect(result.violations.some((v) => v.diff.includes('cache timestamp drift'))).toBe(true);
    });

    it('passes when cache is within tolerance', async () => {
      const dbPrices = [{ asset: 'XLM', price: '0.100000', timestamp: 1000, decimals: 7, source: 'aggregator' }];
      const db = makeDb(dbPrices);
      const cache = makeCache({ XLM: { price: '0.100500', timestamp: 1050 } });
      const logger = makeLogger();

      const job = new ReconciliationJob(db, cache, 'http://rpc.example.com', logger, { priceTolerance: 0.01, timestampToleranceSec: 300 });
      const result = await job.checkCacheVsDb();

      expect(result.status).toBe('ok');
      expect(result.violations).toHaveLength(0);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('skips assets not present in cache', async () => {
      const dbPrices = [{ asset: 'XLM', price: '0.100000', timestamp: 1000, decimals: 7, source: 'aggregator' }];
      const db = makeDb(dbPrices);
      const cache = makeCache({});
      const logger = makeLogger();

      const job = new ReconciliationJob(db, cache, 'http://rpc.example.com', logger);
      const result = await job.checkCacheVsDb();

      expect(result.status).toBe('ok');
      expect(result.violations).toHaveLength(0);
    });

    it('returns ok with skipped detail when DB has no prices', async () => {
      const db = makeDb([]);
      const cache = makeCache({});
      const logger = makeLogger();

      const job = new ReconciliationJob(db, cache, 'http://rpc.example.com', logger);
      const result = await job.checkCacheVsDb();

      expect(result.status).toBe('ok');
      expect(result.details).toMatch(/no DB prices/);
    });
  });

  describe('checkAllLayers', () => {
    it('aggregates results from chain and cache layers', async () => {
      const dbPrices = [{ asset: 'XLM', price: '0.100000', timestamp: 1000, decimals: 7, source: 'aggregator' }];
      const db = makeDb(dbPrices);
      const cache = makeCache({ XLM: { price: '0.100000', timestamp: 1000 } });
      const logger = makeLogger();

      vi.stubGlobal('fetch', mockFetch({
        XLM: { ok: true, body: { price: '0.100000', timestamp: 1000 } },
      }));

      const job = new ReconciliationJob(db, cache, 'http://rpc.example.com', logger);
      const results = await job.checkAllLayers();

      expect(results).toHaveLength(2);
      const layers = results.map((r) => r.layer);
      expect(layers).toContain('chain→db');
      expect(layers).toContain('cache→db');
    });

    it('reports violations in any layer that has divergence', async () => {
      const dbPrices = [{ asset: 'XLM', price: '0.100000', timestamp: 1000, decimals: 7, source: 'aggregator' }];
      const db = makeDb(dbPrices);
      const cache = makeCache({ XLM: { price: '0.300000', timestamp: 1000 } });
      const logger = makeLogger();

      vi.stubGlobal('fetch', mockFetch({
        XLM: { ok: true, body: { price: '0.100000', timestamp: 1000 } },
      }));

      const job = new ReconciliationJob(db, cache, 'http://rpc.example.com', logger);
      const results = await job.checkAllLayers();

      const cacheResult = results.find((r) => r.layer === 'cache→db');
      expect(cacheResult?.status).toBe('violation');

      const chainResult = results.find((r) => r.layer === 'chain→db');
      expect(chainResult?.status).toBe('ok');
    });

    it('returns all ok when everything is consistent', async () => {
      const dbPrices = [{ asset: 'BTC', price: '50000.00', timestamp: 1000, decimals: 8, source: 'aggregator' }];
      const db = makeDb(dbPrices);
      const cache = makeCache({ BTC: { price: '50000.00', timestamp: 1000 } });
      const logger = makeLogger();

      vi.stubGlobal('fetch', mockFetch({
        BTC: { ok: true, body: { price: '50000.00', timestamp: 1000 } },
      }));

      const job = new ReconciliationJob(db, cache, 'http://rpc.example.com', logger);
      const results = await job.checkAllLayers();

      expect(results.every((r) => r.status === 'ok')).toBe(true);
    });

    it('handles multiple assets across layers', async () => {
      const dbPrices = [
        { asset: 'XLM', price: '0.100000', timestamp: 1000, decimals: 7, source: 'aggregator' },
        { asset: 'BTC', price: '50000.00', timestamp: 1000, decimals: 8, source: 'aggregator' },
      ];
      const db = makeDb(dbPrices);
      const cache = makeCache({
        XLM: { price: '0.100000', timestamp: 1000 },
        BTC: { price: '50000.00', timestamp: 1000 },
      });
      const logger = makeLogger();

      vi.stubGlobal('fetch', mockFetch({
        XLM: { ok: true, body: { price: '0.100000', timestamp: 1000 } },
        BTC: { ok: true, body: { price: '50000.00', timestamp: 1000 } },
      }));

      const job = new ReconciliationJob(db, cache, 'http://rpc.example.com', logger);
      const results = await job.checkAllLayers();

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.status === 'ok')).toBe(true);
    });
  });

  describe('tolerance configuration', () => {
    it('uses custom priceTolerance from constructor', async () => {
      const dbPrices = [{ asset: 'XLM', price: '0.100000', timestamp: 1000, decimals: 7, source: 'aggregator' }];
      const db = makeDb(dbPrices);
      const cache = makeCache({ XLM: { price: '0.105000', timestamp: 1000 } });
      const logger = makeLogger();

      const strictJob = new ReconciliationJob(db, cache, 'http://rpc.example.com', logger, { priceTolerance: 0.01 });
      const strictResult = await strictJob.checkCacheVsDb();
      expect(strictResult.status).toBe('violation');

      const lenientDb = makeDb(dbPrices);
      const lenientCache = makeCache({ XLM: { price: '0.105000', timestamp: 1000 } });
      const lenientJob = new ReconciliationJob(lenientDb, lenientCache, 'http://rpc.example.com', makeLogger(), { priceTolerance: 0.1 });
      const lenientResult = await lenientJob.checkCacheVsDb();
      expect(lenientResult.status).toBe('ok');
    });
  });
});
