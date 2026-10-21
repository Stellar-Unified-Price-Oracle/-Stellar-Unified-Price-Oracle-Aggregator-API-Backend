import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

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

const PRICES = [
  { asset: 'XLM', price: '10000000', decimals: 7, source: 'chainlink', timestamp: 1700000000, sources: ['chainlink', 'redstone'] },
];

vi.mock('../src/price-serving/price-store', () => ({
  readAssetPrices: vi.fn(() => Promise.resolve(PRICES)),
}));

vi.mock('../src/feeds/feed-service', () => ({
  feedCatalogService: {
    listFeeds: vi.fn(() => [
      { feedId: 'xlm-usd', asset: 'public:XLM:NATIVE', version: 3, sources: [{ name: 'chainlink', eligible: true }], quorum: { minSources: 1 } },
    ]),
  },
}));

vi.mock('../src/feeds/asset-identity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/feeds/asset-identity')>();
  return { ...actual, parseCanonicalAssetId: actual.parseCanonicalAssetId };
});

import snapshotRoutes from '../src/price-serving/consumer/snapshot-signer';
import { verifyPriceSnapshot } from '../src/price-serving/snapshot-verifier';

const AUTH_KEY = 'test-key-abc123456';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/consumer/snapshots', snapshotRoutes);
  return app;
}

describe('signed price snapshots (#708)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requires authentication', async () => {
    const res = await request(makeApp()).get('/consumer/snapshots/XLM');
    expect(res.status).toBe(401);
  });

  it('returns 404 for an unknown asset', async () => {
    const res = await request(makeApp()).get('/consumer/snapshots/NOPE').set('X-Api-Key', AUTH_KEY);
    expect(res.status).toBe(404);
    expect(res.body.meta.success).toBe(false);
  });

  it('signs a schemaVersion 2 snapshot that round-trips through the verifier', async () => {
    const res = await request(makeApp()).get('/consumer/snapshots/XLM').set('X-Api-Key', AUTH_KEY);
    expect(res.status).toBe(200);
    const snap = res.body.data;
    expect(snap.schemaVersion).toBe(2);
    expect(snap.asset).toBe('XLM');
    expect(snap.price).toBe('10000000');
    expect(snap.decimals).toBe(7);
    expect(snap.feedId).toBe('xlm-usd');
    expect(snap.policyVersion).toBe(3);
    expect(snap.observedAt).toBe(snap.timestamp);
    expect(snap.keyId).toBe('oracle-v1-primary');
    expect(typeof snap.signature).toBe('string');

    const verified = verifyPriceSnapshot(snap);
    expect(verified.valid).toBe(true);
    expect(verified.price?.asset).toBe('XLM');
  });

  it('detects tampering with any bound field', async () => {
    const res = await request(makeApp()).get('/consumer/snapshots/XLM').set('X-Api-Key', AUTH_KEY);
    const snap = res.body.data;
    expect(verifyPriceSnapshot({ ...snap, price: '1' }).valid).toBe(false);
    expect(verifyPriceSnapshot({ ...snap, feedId: 'evil-feed' }).valid).toBe(false);
    expect(verifyPriceSnapshot({ ...snap, policyVersion: 999 }).valid).toBe(false);
    expect(verifyPriceSnapshot({ ...snap, keyId: 'unknown-key' }).valid).toBe(false);
  });

  it('lists available snapshot assets', async () => {
    const res = await request(makeApp()).get('/consumer/snapshots').set('X-Api-Key', AUTH_KEY);
    expect(res.status).toBe(200);
    expect(res.body.data.assets).toContain('XLM');
    expect(res.body.data.schemaVersion).toBe(2);
  });
});
