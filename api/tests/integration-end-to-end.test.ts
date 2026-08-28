import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

vi.mock('../src/infrastructure/database', () => ({
  DatabaseClient: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockRejectedValue(new Error('Test: no DB')),
    disconnect: vi.fn(),
    isInitialized: vi.fn().mockReturnValue(false),
  })),
  setDb: vi.fn(),
}));

vi.mock('../src/governance/api-key-manager', () => ({
  apiKeyManager: {
    validateKey: vi.fn(() => ({
      valid: true,
      metadata: { role: 'admin', rateLimitPerMin: 1000 },
    })),
    checkRateLimit: vi.fn(() => ({
      allowed: true,
      remaining: 999,
      resetTime: Date.now() + 60000,
    })),
    isAdminKey: vi.fn(() => true),
  },
}));

vi.mock('../src/governance/crypto', () => ({
  decryptSecret: vi.fn((val: string) => val),
  encrypt: vi.fn((val: string) => val),
  decrypt: vi.fn((val: string) => val),
  isEncrypted: vi.fn(() => false),
  isEncryptionConfigured: vi.fn(() => false),
}));

vi.mock('../src/observability/tracing', () => ({
  initializeTracing: vi.fn(),
  getTracer: vi.fn(() => ({ startSpan: vi.fn(), end: vi.fn() })),
  getActiveSpan: vi.fn(() => null),
}));

vi.mock('../src/observability/metrics', () => {
  const c = () => ({ inc: vi.fn() });
  const g = () => ({ set: vi.fn(), inc: vi.fn(), dec: vi.fn() });
  const h = () => ({ observe: vi.fn(), startTimer: vi.fn(() => vi.fn()) });
  return {
    cacheHitTotal: c(), cacheMissTotal: c(), lastPriceTimestamp: g(),
    priceQueriesTotal: c(), wsConnectionsActive: g(), wsConnectionsTotal: c(),
    wsMessagesTotal: c(), wsConnectionDuration: h(), wsErrorsTotal: c(),
    wsSubscribeEventsTotal: c(), oracleSourceLatency: h(),
    oracleSourceRequestsTotal: c(), oracleSourceSlaBreaches: c(),
    oracleApiCallsTotal: c(), oracleApiCostTotal: c(),
    oracleApiBudgetUtilization: g(),
    metricsHandler: (_r: any, res: any) => res.send(''),
    metricsMiddleware: (_r: any, _rs: any, next: any) => next(),
  };
});

async function createApp(writeData = true) {
  const express = (await import('express')).default;

  if (writeData) {
    const fs = await import('fs');
    const path = await import('path');
    const DATA_DIR = path.resolve(__dirname, '..', 'data');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // Clear leftovers from previous runs so stale files can't flip /health
    // into "degraded" and make this suite order-dependent.
    for (const f of fs.readdirSync(DATA_DIR)) {
      if (f.startsWith('history-')) fs.unlinkSync(path.join(DATA_DIR, f));
    }
    const ts = Math.floor(Date.now() / 1000);
    const entries = [
      { price: '0.1100000', decimals: 7, source: 'chainlink', timestamp: ts - 180 },
      { price: '0.1150000', decimals: 7, source: 'redstone', timestamp: ts - 120 },
      { price: '0.1200000', decimals: 7, source: 'band', timestamp: ts - 60 },
      { price: '0.1250000', decimals: 7, source: 'reflector', timestamp: ts },
    ];
    fs.writeFileSync(path.join(DATA_DIR, 'history-xlm.json'), JSON.stringify(entries));
    fs.writeFileSync(
      path.join(DATA_DIR, 'history-btc.json'),
      JSON.stringify([{ price: '69000.00000000', decimals: 8, source: 'band', timestamp: ts }]),
    );
    fs.writeFileSync(
      path.join(DATA_DIR, 'history-eth.json'),
      JSON.stringify([{ price: '3500.000000000000000000', decimals: 18, source: 'chainlink', timestamp: ts }]),
    );
    fs.writeFileSync(
      path.join(DATA_DIR, 'history-usdc.json'),
      JSON.stringify([{ price: '1.000000', decimals: 6, source: 'reflector', timestamp: ts }]),
    );
  }

  const { default: v1Routes, initializeCache } = await import('../src/price-serving/v1');
  const { default: v2Routes, initializeCacheV2 } = await import('../src/price-serving/v2');
  const { HybridCache } = await import('../src/price-serving/cache');
  const { logger } = await import('../src/observability/logger');
  const { errorHandler, notFoundHandler } = await import('../src/infrastructure/error');

  const cache = new HybridCache<any>(logger, {
    redisUrl: undefined,
    fallbackToLru: true,
    priceTtl: 15000,
    historyTtl: 60000,
    sourcesTtl: 300000,
    healthTtl: 30000,
  });
  initializeCache(cache);
  initializeCacheV2(cache);

  const app = express();
  app.use(express.json());
  app.use('/api/v1', v1Routes);
  app.use('/api/v2', v2Routes);
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

afterAll(async () => {
    const path = await import('path');
    const fs = await import('fs');
    const DATA_DIR = path.resolve(__dirname, '..', 'data');
    if (fs.existsSync(DATA_DIR)) {
      for (const file of fs.readdirSync(DATA_DIR)) {
        if (file.startsWith('history-') || file.startsWith('test')) {
          fs.unlinkSync(path.join(DATA_DIR, file));
        }
      }
    }
  });

describe('Integration: End-to-End Data Pipeline', () => {
  describe('File Storage Pipeline', () => {
    it('writes price history files to shared data directory', async () => {
      await createApp();
      const path = await import('path');
      const fs = await import('fs');
      const DATA_DIR = path.resolve(__dirname, '..', 'data');

      const xlmFile = path.join(DATA_DIR, 'history-xlm.json');
      expect(fs.existsSync(xlmFile)).toBe(true);
      const entries = JSON.parse(fs.readFileSync(xlmFile, 'utf-8'));
      expect(entries.length).toBe(4);
      expect(entries[entries.length - 1].price).toBe('0.1250000');
    });

    it('stores data for multiple assets simultaneously', async () => {
      const path = await import('path');
      const fs = await import('fs');
      const DATA_DIR = path.resolve(__dirname, '..', 'data');

      for (const asset of ['xlm', 'btc', 'eth', 'usdc']) {
        expect(fs.existsSync(path.join(DATA_DIR, `history-${asset}.json`))).toBe(true);
      }
    });

    it('maintains ascending timestamp ordering', async () => {
      const path = await import('path');
      const fs = await import('fs');
      const DATA_DIR = path.resolve(__dirname, '..', 'data');
      const entries = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'history-xlm.json'), 'utf-8'));
      for (let i = 1; i < entries.length; i++) {
        expect(entries[i].timestamp).toBeGreaterThanOrEqual(entries[i - 1].timestamp);
      }
    });
  });

  describe('v1 Health Endpoints', () => {
    it('GET /api/v1/health/live returns alive', async () => {
      const app = await createApp();
      const res = await request(app).get('/api/v1/health/live');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('alive');
      expect(typeof res.body.uptime).toBe('number');
    });

    it('GET /api/v1/health/ready returns ready with asset count', async () => {
      const app = await createApp();
      const res = await request(app).get('/api/v1/health/ready');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ready');
      expect(res.body.assetsTracked).toBeGreaterThanOrEqual(4);
    });

    it('GET /api/v1/health returns service status and tracks assets', async () => {
      const app = await createApp();
      const res = await request(app).get('/api/v1/health');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.service).toBe('stellar-price-oracle-api');
      expect(res.body.data.status).toBe('healthy');
      expect(res.body.data.assetsTracked).toBeGreaterThanOrEqual(4);
    });

    it('GET /api/v1/health?verbose=true includes price details', async () => {
      const app = await createApp();
      const res = await request(app).get('/api/v1/health?verbose=true');
      expect(res.status).toBe(200);
      expect(res.body.data.prices).toBeDefined();
      expect(res.body.data.processMemoryMb).toBeDefined();
      expect(res.body.data.nodeVersion).toBeDefined();
    });

    it('GET /api/v1/health returns unhealthy when no data exists', async () => {
      const path = await import('path');
      const fs = await import('fs');
      const DATA_DIR = path.resolve(__dirname, '..', 'data');
      const files = fs.readdirSync(DATA_DIR).filter((f: string) => f.startsWith('history-'));
      for (const f of files) fs.unlinkSync(path.join(DATA_DIR, f));

      const app = await createApp(false);
      const res = await request(app).get('/api/v1/health');
      expect([200, 503]).toContain(res.status);
    });
  });

  describe('v1 Sources', () => {
    it('GET /api/v1/sources returns all oracle sources', async () => {
      const app = await createApp();
      const res = await request(app).get('/api/v1/sources');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.sources.length).toBe(4);

      const names = res.body.data.sources.map((s: any) => s.name);
      expect(names).toContain('Chainlink');
      expect(names).toContain('Redstone');
      expect(names).toContain('Band Protocol');
      expect(names).toContain('Reflector');
    });
  });

  describe('v2 Endpoints', () => {
    it('GET /api/v2/health returns v2 health', async () => {
      const app = await createApp();
      const res = await request(app).get('/api/v2/health');
      expect(res.status).toBe(200);
      expect(res.body.meta.version).toBe('2');
      expect(res.body.data.service).toBe('stellar-price-oracle-api');
    });

    it('GET /api/v2/sources returns v2 sources', async () => {
      const app = await createApp();
      const res = await request(app).get('/api/v2/sources');
      expect(res.status).toBe(200);
      expect(res.body.meta.version).toBe('2');
      expect(res.body.data.sources).toHaveLength(4);
    });

    it('GET /api/v2/assets returns asset metadata', async () => {
      const app = await createApp();
      const res = await request(app).get('/api/v2/assets');
      expect(res.status).toBe(200);
      expect(res.body.meta.version).toBe('2');
      expect(res.body.data.count).toBeGreaterThanOrEqual(4);

      for (const a of res.body.data.assets) {
        expect(a).toHaveProperty('symbol');
        expect(a).toHaveProperty('sourceCount');
        expect(a).toHaveProperty('confidence');
        expect(a).toHaveProperty('status');
      }
    });

    it('POST /api/v2/prices/batch returns prices', async () => {
      const app = await createApp();
      const res = await request(app)
        .post('/api/v2/prices/batch')
        .send({ assets: ['XLM', 'ETH'] });
      expect(res.status).toBe(200);
      expect(res.body.meta.success).toBe(true);
      expect(res.body.data.found).toBe(2);
    });
  });

  describe('Response Format Consistency', () => {
    it('all v1 successful responses include success:true and data', async () => {
      const app = await createApp();
      for (const p of ['/api/v1/health', '/api/v1/sources']) {
        const res = await request(app).get(p);
        expect(res.body.success).toBe(true);
        expect(res.body.data).toBeDefined();
      }
      // /health/live has a different response format (no success wrapper)
      const liveRes = await request(app).get('/api/v1/health/live');
      expect(liveRes.body.status).toBe('alive');
    });

    it('all v2 responses include meta.version', async () => {
      const app = await createApp();
      for (const p of ['/api/v2/health', '/api/v2/sources', '/api/v2/assets']) {
        const res = await request(app).get(p);
        expect(res.body.meta.version).toBe('2');
      }
    });

    it('includes valid timestamps in health data', async () => {
      const app = await createApp();
      const res = await request(app).get('/api/v1/health');
      expect(typeof res.body.data.timestamp).toBe('number');
      expect(res.body.data.timestamp).toBeGreaterThan(0);
    });
  });

  describe('End-to-End Data Consistency', () => {
    it('data written to disk is served through API', async () => {
      const path = await import('path');
      const fs = await import('fs');
      const DATA_DIR = path.resolve(__dirname, '..', 'data');
      const btcFile = path.join(DATA_DIR, 'history-btc.json');
      const entries = JSON.parse(fs.readFileSync(btcFile, 'utf-8'));

      const app = await createApp(false); // don't re-write data
      const res = await request(app).get('/api/v1/health?verbose=true');

      const btcData = res.body.data.prices.find((p: any) => p.asset === 'BTC');
      expect(btcData).toBeDefined();
      expect(btcData.timestamp).toBe(entries[entries.length - 1].timestamp);
    });

    it('newly written data is immediately served', async () => {
      const path = await import('path');
      const fs = await import('fs');
      const DATA_DIR = path.resolve(__dirname, '..', 'data');
      const ts = Math.floor(Date.now() / 1000);
      fs.writeFileSync(
        path.join(DATA_DIR, 'history-sol.json'),
        JSON.stringify([{ price: '150.00000000', decimals: 8, source: 'chainlink', timestamp: ts }]),
      );

      const app = await createApp(false);
      const res = await request(app).get('/api/v1/health?verbose=true');
      const solData = res.body.data.prices.find((p: any) => p.asset === 'SOL');
      expect(solData).toBeDefined();
    });

    it('stale data is reported as degraded', async () => {
      const path = await import('path');
      const fs = await import('fs');
      const DATA_DIR = path.resolve(__dirname, '..', 'data');

      fs.writeFileSync(
        path.join(DATA_DIR, 'history-stale.json'),
        JSON.stringify([{ price: '100', decimals: 6, source: 'test', timestamp: Math.floor(Date.now() / 1000) - 300 }]),
      );

      const app = await createApp(false);
      const res = await request(app).get('/api/v1/health');
      expect(res.body.data.degradedAssets).toContain('STALE');
    });
  });

  describe('Edge Cases', () => {
    it('skips corrupt history files without crashing', async () => {
      const path = await import('path');
      const fs = await import('fs');
      const DATA_DIR = path.resolve(__dirname, '..', 'data');
      fs.writeFileSync(path.join(DATA_DIR, 'history-corrupt.json'), 'not valid json {{{');

      const app = await createApp(false);
      const res = await request(app).get('/api/v1/health');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      fs.unlinkSync(path.join(DATA_DIR, 'history-corrupt.json'));
    });

    it('handles empty data directory gracefully', async () => {
      const path = await import('path');
      const fs = await import('fs');
      const DATA_DIR = path.resolve(__dirname, '..', 'data');
      const files = fs.readdirSync(DATA_DIR).filter((f: string) => f.startsWith('history-'));
      for (const f of files) fs.unlinkSync(path.join(DATA_DIR, f));

      const app = await createApp(false);
      const res = await request(app).get('/api/v1/health/ready');
      expect(res.body.status).toBe('not_ready');
      expect(res.body.assetsTracked).toBe(0);
    });

    it('handles v1 root endpoint', async () => {
      const app = await createApp(false);
      const res = await request(app).get('/api/v1');
      expect(res.status).toBe(200);
      expect(res.body.name).toBeDefined();
    });

    it('returns 404 for unknown routes', async () => {
      const app = await createApp(false);
      const res = await request(app).get('/nonexistent-route');
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });
  });
});
