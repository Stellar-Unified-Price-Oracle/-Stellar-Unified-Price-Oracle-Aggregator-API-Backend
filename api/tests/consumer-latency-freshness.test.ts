import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import latencyFreshnessRoutes, {
  latencyFreshnessMiddleware,
} from '../src/price-serving/consumer/latency-freshness';
import { resetForTesting } from '../src/price-serving/consumer/store';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/consumer/latency-freshness', latencyFreshnessRoutes);
  return app;
}

describe('latency-freshness explorer route (#715)', () => {
  beforeEach(() => {
    resetForTesting();
    vi.clearAllMocks();
  });

  it('returns empty feeds when no samples recorded', async () => {
    const app = makeApp();
    const res = await request(app).get('/consumer/latency-freshness?asset=XLM');
    expect(res.status).toBe(200);
    expect(res.body.meta.success).toBe(true);
    expect(res.body.data.feeds).toEqual([]);
    expect(res.body.data.window).toBeDefined();
    expect(res.body.data.sampleNote).toBeDefined();
  });

  it('returns feed stats after latency samples are recorded', async () => {
    const app = makeApp();
    const now = Math.floor(Date.now() / 1000);
    // Simulate samples having been recorded by price responses
    // The middleware records samples on res.json; here we call the store directly
    // to simulate what the middleware would have recorded.
    const { recordLatencySample } = await import('../src/price-serving/consumer/store');
    recordLatencySample({
      asset: 'XLM', region: 'us-east', observedAt: now - 60, deliveredAt: now,
      latencyMs: 500, freshnessMs: 200, source: 'chainlink',
    });
    recordLatencySample({
      asset: 'XLM', region: 'us-east', observedAt: now - 60, deliveredAt: now,
      latencyMs: 1500, freshnessMs: 400, source: 'redstone',
    });

    const res = await request(app).get('/consumer/latency-freshness?asset=XLM&region=us-east');
    expect(res.status).toBe(200);
    expect(res.body.meta.success).toBe(true);
    expect(res.body.data.feeds).toHaveLength(1);
    expect(res.body.data.feeds[0].asset).toBe('XLM');
    expect(res.body.data.feeds[0].region).toBe('us-east');
    expect(res.body.data.feeds[0].sampleCount).toBe(2);
    expect(res.body.data.feeds[0].latency.p50).toBe(1000);
    expect(res.body.data.feeds[0].methodology).toContain('latencyMs');
  });

  it('filters by time window via from/to', async () => {
    const { recordLatencySample } = await import('../src/price-serving/consumer/store');
    const now = Math.floor(Date.now() / 1000);
    recordLatencySample({
      asset: 'XLM', region: 'global', observedAt: now - 100000, deliveredAt: now - 100000,
      latencyMs: 100, freshnessMs: 50,
    });
    recordLatencySample({
      asset: 'XLM', region: 'global', observedAt: now, deliveredAt: now,
      latencyMs: 500, freshnessMs: 100,
    });

    const app = makeApp();
    const res = await request(app)
      .get(`/consumer/latency-freshness?asset=XLM&from=${now - 60}&to=${now + 60}`);
    expect(res.status).toBe(200);
    expect(res.body.data.feeds).toHaveLength(1);
    expect(res.body.data.feeds[0].sampleCount).toBe(1);
  });

  it('validates query parameters', async () => {
    const app = makeApp();
    const res = await request(app).get('/consumer/latency-freshness?window=invalid');
    expect(res.status).toBe(400);
  });

  it('middleware records latency sample on price response', async () => {
    const app = express();
    app.use(express.json());
    app.use(latencyFreshnessMiddleware());
    app.get('/prices/:asset', (_req, res) => {
      res.json({ success: true, data: { asset: 'XLM', timestamp: Math.floor(Date.now() / 1000), sources: ['chainlink'] } });
    });

    await request(app).get('/prices/XLM').set('X-Region', 'eu-west');

    const { computeFeedStats } = await import('../src/price-serving/consumer/store');
    const stats = computeFeedStats('XLM', 'eu-west');
    expect(stats).toHaveLength(1);
    expect(stats[0].sampleCount).toBe(1);
    expect(stats[0].region).toBe('eu-west');
  });
});