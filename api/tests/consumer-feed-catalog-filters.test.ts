import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../src/governance/auth', () => ({
  optionalAuthMiddleware: (_req: any, _res: any, next: any) => next(),
}));

const POLICIES = [
  { feedId: 'xlm-usd', asset: 'public:XLM:NATIVE', version: 2, sources: [{ name: 'chainlink', eligible: true }, { name: 'redstone', eligible: true }], quorum: { minSources: 1 } },
  { feedId: 'btc-usd', asset: 'public:BTC:GBTCISSUERPLACEHOLDER000000000000000000000001', version: 1, sources: [{ name: 'chainlink', eligible: true }], quorum: { minSources: 1 } },
  { feedId: 'xlm-eur', asset: 'testnet:XLM:NATIVE', version: 1, sources: [], quorum: { minSources: 1 } },
];

const LIFECYCLE: Record<string, string> = {
  'xlm-usd': 'active',
  'btc-usd': 'active',
  'xlm-eur': 'proposed',
};

vi.mock('../src/feeds/feed-service', () => ({
  feedCatalogService: {
    listFeeds: vi.fn(() => POLICIES),
    getPolicy: vi.fn((feedId: string) => POLICIES.find((p) => p.feedId === feedId)),
    getLifecycle: vi.fn((feedId: string) => ({ state: LIFECYCLE[feedId] ?? 'active' })),
  },
}));

import feedCatalogRoutes from '../src/price-serving/consumer/feed-catalog-consumer';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/consumer/feeds', feedCatalogRoutes);
  return app;
}

describe('consumer feed-catalog filters (#709)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists all feeds with stable pagination metadata', async () => {
    const res = await request(makeApp()).get('/consumer/feeds');
    expect(res.status).toBe(200);
    expect(res.body.meta.success).toBe(true);
    expect(res.body.data.feeds).toHaveLength(3);
    expect(res.body.data.pagination.total).toBe(3);
    expect(res.body.data.pagination.totalPages).toBe(1);
    // stable ordering by feedId
    expect(res.body.data.feeds.map((f: any) => f.feedId)).toEqual(['btc-usd', 'xlm-eur', 'xlm-usd']);
  });

  it('paginates deterministically', async () => {
    const first = await request(makeApp()).get('/consumer/feeds?page=1&limit=2');
    const second = await request(makeApp()).get('/consumer/feeds?page=2&limit=2');
    expect(first.body.data.feeds).toHaveLength(2);
    expect(second.body.data.feeds).toHaveLength(1);
    expect(second.body.data.pagination.hasNext).toBe(false);
    expect(second.body.data.pagination.hasPrev).toBe(true);
    expect(first.body.data.feeds[0].feedId).toBe('btc-usd');
    expect(second.body.data.feeds[0].feedId).toBe('xlm-usd');
  });

  it('filters by network, quote unit, source coverage and lifecycle state', async () => {
    const net = await request(makeApp()).get('/consumer/feeds?network=testnet');
    expect(net.body.data.feeds.map((f: any) => f.feedId)).toEqual(['xlm-eur']);
    expect(net.body.data.feeds[0].network).toBe('testnet');

    const quote = await request(makeApp()).get('/consumer/feeds?quoteUnit=eur');
    expect(quote.body.data.feeds.map((f: any) => f.feedId)).toEqual(['xlm-eur']);

    const coverage = await request(makeApp()).get('/consumer/feeds?sourceCoverage=2');
    expect(coverage.body.data.feeds.map((f: any) => f.feedId)).toEqual(['xlm-usd']);
    expect(coverage.body.data.feeds[0].eligibleSources).toBe(2);

    const state = await request(makeApp()).get('/consumer/feeds?lifecycleState=proposed');
    expect(state.body.data.feeds.map((f: any) => f.feedId)).toEqual(['xlm-eur']);
  });

  it('rejects out-of-range pagination parameters', async () => {
    const res = await request(makeApp()).get('/consumer/feeds?limit=1000');
    expect(res.status).toBe(400);
  });

  it('returns feed details and 404s for unknown feeds', async () => {
    const ok = await request(makeApp()).get('/consumer/feeds/xlm-usd');
    expect(ok.status).toBe(200);
    expect(ok.body.data.network).toBe('mainnet');
    expect(ok.body.data.quoteUnit).toBe('USD');
    expect(ok.body.data.eligibleSources).toBe(2);

    const missing = await request(makeApp()).get('/consumer/feeds/nope');
    expect(missing.status).toBe(404);
    expect(missing.body.meta.success).toBe(false);
  });
});
