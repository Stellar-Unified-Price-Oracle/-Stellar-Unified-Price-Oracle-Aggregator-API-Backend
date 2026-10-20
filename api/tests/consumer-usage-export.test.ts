import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock auth so importing usage-export (which uses authMiddleware) does not
// construct the ApiKeyManager singleton at module load time. Authentication is
// simulated: a request is authenticated only when it carries an X-Api-Key header.
vi.mock('../src/governance/auth', () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    const key = req.headers['x-api-key'];
    if (!key) {
      res.status(401).json({ success: false, error: { code: 'MISSING_API_KEY' } });
      return;
    }
    req.apiKey = String(key);
    next();
  },
}));

import usageExportRoutes from '../src/price-serving/consumer/usage-export';
import { resetForTesting, recordUsageEvent } from '../src/price-serving/consumer/store';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/consumer/usage/export', usageExportRoutes);
  return app;
}

const AUTH_KEY = 'test-key-abc123456'; // first 8 chars = 'test-key'

describe('privacy-safe usage export route (#716)', () => {
  beforeEach(() => {
    resetForTesting();
    vi.clearAllMocks();
  });

  it('requires authentication (401 without API key)', async () => {
    // Build an app WITHOUT the auth mock bypass — simulate no api key by
    // overriding req.apiKey to undefined.
    const app = express();
    app.use((req, _res, next) => {
      (req as any).apiKey = undefined;
      next();
    });
    app.use('/consumer/usage/export', usageExportRoutes);

    const res = await request(app).get('/consumer/usage/export');
    expect(res.status).toBe(401);
  });

  it('exports only the calling tenant usage', async () => {
    recordUsageEvent({ endpoint: '/api/v1/prices/XLM', method: 'GET', apiKeyPrefix: 'test-key', asset: 'XLM', status: 200, timestamp: Date.now() });
    recordUsageEvent({ endpoint: '/api/v1/prices/BTC', method: 'GET', apiKeyPrefix: 'other-ten', asset: 'BTC', status: 200, timestamp: Date.now() });

    const app = makeApp();
    const res = await request(app).get('/consumer/usage/export').set('X-Api-Key', AUTH_KEY);
    expect(res.status).toBe(200);
    expect(res.body.meta.success).toBe(true);
    expect(res.body.data.keyPrefix).toBe('test-key');
    expect(res.body.data.totalRequests).toBe(1);
    expect(res.body.data.records).toHaveLength(1);
    expect(res.body.data.records[0].endpoint).toBe('/api/v1/prices/XLM');
    expect(res.body.data.byAsset.XLM).toBe(1);
    expect(res.body.data.privacyNote).toContain('cross-tenant');
  });

  it('supports CSV format', async () => {
    recordUsageEvent({ endpoint: '/api/v1/prices/XLM', method: 'GET', apiKeyPrefix: 'test-key', asset: 'XLM', status: 200, timestamp: Date.now() });

    const app = makeApp();
    const res = await request(app).get('/consumer/usage/export?format=csv').set('X-Api-Key', AUTH_KEY);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.text).toContain('endpoint,method,asset,status,timestamp');
    expect(res.text).toContain('/api/v1/prices/XLM');
  });

  it('validates format parameter', async () => {
    const app = makeApp();
    const res = await request(app).get('/consumer/usage/export?format=xml').set('X-Api-Key', AUTH_KEY);
    expect(res.status).toBe(400);
  });

  it('returns empty export when tenant has no usage', async () => {
    const app = makeApp();
    const res = await request(app).get('/consumer/usage/export').set('X-Api-Key', AUTH_KEY);
    expect(res.status).toBe(200);
    expect(res.body.data.totalRequests).toBe(0);
    expect(res.body.data.records).toEqual([]);
  });

  it('applies stable billing dimensions: endpoint, method, asset, status, timestamp', async () => {
    recordUsageEvent({ endpoint: '/api/v1/prices', method: 'GET', apiKeyPrefix: 'test-key', asset: 'XLM', status: 200, timestamp: Date.now() });

    const app = makeApp();
    const res = await request(app).get('/consumer/usage/export').set('X-Api-Key', AUTH_KEY);
    const record = res.body.data.records[0];
    expect(record).toHaveProperty('endpoint');
    expect(record).toHaveProperty('method');
    expect(record).toHaveProperty('asset');
    expect(record).toHaveProperty('status');
    expect(record).toHaveProperty('timestamp');
  });
});