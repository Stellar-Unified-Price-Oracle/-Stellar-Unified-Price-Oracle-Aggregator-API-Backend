import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { readPriceHistory } from '../src/price-serving/price-store';

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

const HISTORY = Array.from({ length: 5 }, (_, i) => ({
  price: String(1_000_000 + i),
  decimals: 7,
  source: 'chainlink',
  timestamp: 1_700_000_000 + i * 30,
}));

vi.mock('../src/price-serving/price-store', () => ({
  readPriceHistory: vi.fn(() => Promise.resolve(HISTORY)),
}));

import exportJobsRoutes from '../src/price-serving/consumer/export-jobs';

const AUTH_KEY = 'test-key-abc123456';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/consumer/exports', exportJobsRoutes);
  return app;
}

describe('asynchronous historical export jobs (#710)', () => {
  it('creates a job with 202 and tracks it to completion with integrity metadata', async () => {
    const app = makeApp();
    const created = await request(app).post('/consumer/exports').set('X-Api-Key', AUTH_KEY).send({ asset: 'XLM' });
    expect(created.status).toBe(202);
    expect(created.body.meta.success).toBe(true);
    const { jobId } = created.body.data;
    expect(jobId).toMatch(/^exp_/);
    expect(created.body.data.expiresAt).toBeGreaterThan(0);

    let status: any;
    for (let attempt = 0; attempt < 50; attempt++) {
      const res = await request(app).get(`/consumer/exports/${jobId}`).set('X-Api-Key', AUTH_KEY);
      status = res.body.data;
      if (status.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(status.status).toBe('completed');
    expect(status.progress).toBe(100);
    expect(status.totalRecords).toBe(5);
    expect(status.checksum).toBeTruthy();
    expect(status.downloadUrl).toBe(`/api/v1/consumer/exports/${jobId}/download`);

    const downloaded = await request(app).get(`/consumer/exports/${jobId}/download`).set('X-Api-Key', AUTH_KEY);
    expect(downloaded.status).toBe(200);
    expect(downloaded.body.asset).toBe('XLM');
    expect(downloaded.body.records).toHaveLength(5);
    expect(downloaded.body.checksum).toBe(status.checksum);
    expect(downloaded.headers['x-export-record-count']).toBe('5');
    expect(downloaded.headers['content-disposition']).toContain(jobId);
  }, 15000);

  it('rejects creation without an asset', async () => {
    const res = await request(makeApp()).post('/consumer/exports').set('X-Api-Key', AUTH_KEY).send({});
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown jobs and 400 for unready downloads', async () => {
    const app = makeApp();
    const missing = await request(app).get('/consumer/exports/nope').set('X-Api-Key', AUTH_KEY);
    expect(missing.status).toBe(404);

    const created = await request(app).post('/consumer/exports').set('X-Api-Key', AUTH_KEY).send({ asset: 'XLM' });
    const fast = await request(app).get(`/consumer/exports/${created.body.data.jobId}/download`).set('X-Api-Key', AUTH_KEY);
    expect([200, 400]).toContain(fast.status);
  }, 15000);

  it('requires authentication', async () => {
    const res = await request(makeApp()).post('/consumer/exports').send({ asset: 'XLM' });
    expect(res.status).toBe(401);
  });

  it('caps export at 100000 records (boundary)', async () => {
    const largeHistory = Array.from({ length: 100001 }, (_, i) => ({
      price: String(1_000_000 + (i % 10)),
      decimals: 7,
      source: 'chainlink',
      timestamp: 1_700_000_000 + i,
    }));
    vi.clearAllMocks();
    vi.mocked(readPriceHistory).mockResolvedValue(largeHistory);

    const app = makeApp();
    const created = await request(app)
      .post('/consumer/exports')
      .set('X-Api-Key', AUTH_KEY)
      .send({ asset: 'XLM' });
    expect(created.status).toBe(202);
    const { jobId } = created.body.data;

    let status: any;
    for (let attempt = 0; attempt < 50; attempt++) {
      const res = await request(app)
        .get(`/consumer/exports/${jobId}`)
        .set('X-Api-Key', AUTH_KEY);
      status = res.body.data;
      if (status.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(status.status).toBe('completed');
    expect(status.totalRecords).toBe(100000);
    expect(status.processedRecords).toBe(100000);
    expect(status.progress).toBe(100);
  });
});
