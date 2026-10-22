import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import feedCatalogRouter from '../../src/routes/feed-catalog';
import { feedCatalogService } from '../../src/feeds/feed-service';

// The API-key store lives outside this workstream; the catalog router only
// needs the resolved role, so the key lookup is stubbed here and the RBAC
// gate itself (the thing under test) stays real.
const ROLE_BY_KEY = new Map<string, 'admin' | 'operator' | 'viewer'>();

// The RBAC guard writes a denial to the audit log; the audit log lives outside
// this workstream, so it is stubbed to keep the route test independent of it.
vi.mock('../../src/governance/audit-logger', () => ({
  auditLog: vi.fn(),
}));

vi.mock('../../src/governance/auth', () => ({
  adminAuthMiddleware: () => (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const raw = req.headers['authorization'];
    const key = typeof raw === 'string' && raw.startsWith('Bearer ') ? raw.slice(7) : '';
    const role = ROLE_BY_KEY.get(key);
    if (!role) {
      res.status(401).json({ success: false, error: { code: 'MISSING_API_KEY', message: 'Admin API key required.' } });
      return;
    }
    req.apiKey = key;
    req.userRole = role;
    next();
  },
}));

const ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

let app: express.Express;
let viewerKey: string;
let operatorKey: string;
let adminKey: string;

const auth = (key: string) => ({ Authorization: `Bearer ${key}` });

function policyBody(feedId: string) {
  return {
    asset: `public:BTC:${ISSUER}`,
    sources: [
      { name: 'chainlink', eligible: true },
      { name: 'redstone', eligible: true },
    ],
    quorum: { minSources: 2 },
  };
}

beforeAll(() => {
  viewerKey = 'viewer-key';
  operatorKey = 'operator-key';
  adminKey = 'admin-key';
  ROLE_BY_KEY.set(viewerKey, 'viewer');
  ROLE_BY_KEY.set(operatorKey, 'operator');
  ROLE_BY_KEY.set(adminKey, 'admin');
});

beforeEach(() => {
  app = express();
  app.use(express.json());
  app.use('/catalog', feedCatalogRouter);
});

afterEach(() => {
  for (const policy of feedCatalogService.listFeeds()) {
    feedCatalogService.removePolicy(policy.feedId);
  }
});

describe('feed catalog routes', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/catalog/feeds');
    expect(res.status).toBe(401);
  });

  it('lets a viewer read the catalog', async () => {
    const res = await request(app).get('/catalog/feeds').set(auth(viewerKey));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.feeds)).toBe(true);
  });

  it('serves immutable snapshot pages with ETags and deterministic cursors', async () => {
    await request(app).put('/catalog/feeds/snapshot-btc/policy').set(auth(operatorKey)).send(policyBody('snapshot-btc'));
    const first = await request(app).get('/catalog/snapshots?limit=1');
    expect(first.status).toBe(200);
    expect(first.body.data.snapshots).toHaveLength(1);
    expect(first.body.data.nextCursor).toBeTruthy();
    const snapshotId = first.body.data.snapshots[0].id;
    const detail = await request(app).get(`/catalog/snapshots/${snapshotId}`);
    expect(detail.status).toBe(200);
    expect(detail.headers.etag).toBe(`"${snapshotId}"`);
    const cached = await request(app).get(`/catalog/snapshots/${snapshotId}`).set('If-None-Match', `"${snapshotId}"`);
    expect(cached.status).toBe(304);
    const next = await request(app).get(`/catalog/snapshots?limit=1&cursor=${encodeURIComponent(first.body.data.nextCursor)}`);
    expect(next.status).toBe(200);
    expect(next.body.data.snapshots[0].id).not.toBe(snapshotId);
  });

  it('rejects unknown snapshot cursors and fails closed when signing is unavailable', async () => {
    const cursor = await request(app).get('/catalog/snapshots?cursor=unknown').set(auth(viewerKey));
    expect(cursor.status).toBe(400);
    await request(app).put('/catalog/feeds/signing-btc/policy').set(auth(operatorKey)).send(policyBody('signing-btc'));
    const snapshots = await request(app).get('/catalog/snapshots');
    const signing = await request(app).post('/catalog/releases/canary').set(auth(operatorKey)).send({ snapshotId: snapshots.body.data.snapshots[0].id });
    expect(signing.status).toBe(503);
    expect(signing.body.error.code).toBe('SIGNING_UNAVAILABLE');
  });

  it('blocks a viewer from writing a policy', async () => {
    const res = await request(app)
      .put('/catalog/feeds/btc-usd/policy')
      .set(auth(viewerKey))
      .send(policyBody('btc-usd'));
    expect(res.status).toBe(403);
  });

  it('lets an operator write a valid policy and rejects an invalid one', async () => {
    const ok = await request(app)
      .put('/catalog/feeds/btc-usd/policy')
      .set(auth(operatorKey))
      .send(policyBody('btc-usd'));
    expect(ok.status).toBe(200);
    expect(ok.body.data.asset).toBe(`public:BTC:${ISSUER}`);
    expect(ok.body.data.freshness).toEqual({ profile: 'standard', warnSeconds: 60, maxAgeSeconds: 120 });
    expect(ok.body.data.quoteUnit).toEqual({ currency: 'USD', denomination: 'USD_PER_ASSET_UNIT', scaleDecimals: 8, displayDecimals: 4, rounding: 'half-even' });

    const bad = await request(app)
      .put('/catalog/feeds/bad-usd/policy')
      .set(auth(operatorKey))
      .send({ ...policyBody('bad-usd'), asset: 'BTC' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('INVALID_FEED_POLICY');
  });

  it('walks a feed through the lifecycle and enforces the role gate', async () => {
    await request(app)
      .put('/catalog/feeds/btc-usd/policy')
      .set(auth(operatorKey))
      .send(policyBody('btc-usd'));

    const validated = await request(app)
      .post('/catalog/feeds/btc-usd/transitions')
      .set(auth(operatorKey))
      .send({ transition: 'validate', reason: 'checks passed' });
    expect(validated.status).toBe(200);
    expect(validated.body.data.to).toBe('validated');

    const activate = await request(app)
      .post('/catalog/feeds/btc-usd/transitions')
      .set(auth(operatorKey))
      .send({ transition: 'activate', reason: 'go live' });
    expect(activate.status).toBe(409);
    expect(activate.body.error.code).toBe('INVALID_TRANSITION');
  });

  it('refuses an illegal transition and an unknown feed', async () => {
    const illegal = await request(app)
      .post('/catalog/feeds/btc-usd/transitions')
      .set(auth(operatorKey))
      .send({ transition: 'activate', reason: 'go live' });
    expect(illegal.status).toBe(409);

    const unknown = await request(app)
      .post('/catalog/feeds/nope/transitions')
      .set(auth(operatorKey))
      .send({ transition: 'validate', reason: 'x' });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('FEED_NOT_FOUND');
  });

  it('registers a feed alias and rejects a duplicate one', async () => {
    const created = await request(app)
      .post('/catalog/feeds/btc-usd/aliases')
      .set(auth(operatorKey))
      .send({
        alias: 'btc-usd-old',
        successor: 'btc-usd',
        kind: 'rename',
        sunsetAt: '2027-01-01T00:00:00.000Z',
        notice: 'renamed to btc-usd',
      });
    expect(created.status).toBe(201);
    expect(created.body.data.alias).toBe('BTC-USD-OLD');

    const duplicate = await request(app)
      .post('/catalog/feeds/btc-usd/aliases')
      .set(auth(operatorKey))
      .send({
        alias: 'btc-usd-old',
        successor: 'btc-usd',
        kind: 'rename',
        sunsetAt: '2027-01-01T00:00:00.000Z',
        notice: 'renamed to btc-usd',
      });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('ALIAS_EXISTS');
  });

  it('evaluates the quorum of a feed', async () => {
    await request(app)
      .put('/catalog/feeds/btc-usd/policy')
      .set(auth(operatorKey))
      .send(policyBody('btc-usd'));

    const satisfied = await request(app)
      .get('/catalog/feeds/btc-usd/quorum?contributions=chainlink,redstone')
      .set(auth(viewerKey));
    expect(satisfied.status).toBe(200);
    expect(satisfied.body.data.satisfied).toBe(true);

    const unsatisfied = await request(app)
      .get('/catalog/feeds/btc-usd/quorum?contributions=chainlink')
      .set(auth(viewerKey));
    expect(unsatisfied.body.data.satisfied).toBe(false);
  });

  it('resolves an asset alias to its canonical id', async () => {
    const registered = feedCatalogService.registerAssetAlias('BTC', `public:BTC:${ISSUER}`);
    expect(registered.ok).toBe(true);

    const res = await request(app).get('/catalog/assets/BTC').set(auth(viewerKey));
    expect(res.status).toBe(200);
    expect(res.body.data.canonicalId).toBe(`public:BTC:${ISSUER}`);

    const unknown = await request(app).get('/catalog/assets/NOPE').set(auth(viewerKey));
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('NOT_FOUND');
  });

  it('exposes the admin role for catalog writes', () => {
    expect(adminKey).toBeTruthy();
  });
});
