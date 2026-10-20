import { describe, it, expect } from 'vitest';
import {
  createFeedCatalog,
  lookupFeed,
  type FeedCatalogEntry,
} from '../../src/feeds/feed-catalog';
import {
  createFeedAliasRegistry,
} from '../../src/feeds/feed-aliases';
import {
  createFeedLifecycleStore,
  registerFeed,
  transitionFeed,
} from '../../src/feeds/feed-lifecycle';
import type { FeedPolicy } from '../../src/feeds/feed-policy';

const ISSUER_A = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

function policyFor(feedId: string, asset: string): FeedPolicy {
  return {
    feedId,
    asset,
    version: 1,
    sources: [
      { name: 'chainlink', eligible: true },
      { name: 'redstone', eligible: true },
    ],
    quorum: { minSources: 2 },
  };
}

function buildCatalog() {
  const entries: FeedCatalogEntry[] = [
    {
      feedId: 'btc-usd',
      asset: `public:BTC:${ISSUER_A}`,
      policy: policyFor('btc-usd', `public:BTC:${ISSUER_A}`),
    },
  ];
  const lifecycle = createFeedLifecycleStore();
  const aliases = createFeedAliasRegistry();
  const catalog = createFeedCatalog(
    entries,
    [{ alias: 'BTC', canonicalId: `public:BTC:${ISSUER_A}` }],
    lifecycle,
    aliases,
  );
  registerFeed(lifecycle, { feedId: 'btc-usd', actor: 'alice', role: 'operator', reason: 'proposal' });
  for (const [transition, role] of [
    ['validate', 'operator'],
    ['promote-to-canary', 'operator'],
    ['activate', 'admin'],
  ] as const) {
    transitionFeed(lifecycle, {
      feedId: 'btc-usd',
      transition,
      actor: 'alice',
      role,
      reason: 'rollout',
    });
  }
  return catalog;
}

describe('feed catalog lookup', () => {
  it('finds a feed by its feed id', () => {
    const catalog = buildCatalog();
    const result = lookupFeed(catalog, 'btc-usd');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.feed.feedId).toBe('btc-usd');
      expect(result.state).toBe('active');
      expect(result.publishable).toBe(true);
      expect(result.alias).toBeNull();
    }
  });

  it('finds a feed by a canonical asset id', () => {
    const catalog = buildCatalog();
    const result = lookupFeed(catalog, `public:BTC:${ISSUER_A}`);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.feed.feedId).toBe('btc-usd');
  });

  it('finds a feed by a registered asset alias', () => {
    const catalog = buildCatalog();
    const result = lookupFeed(catalog, 'BTC');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.feed.feedId).toBe('btc-usd');
  });

  it('reports an unknown feed and an invalid asset', () => {
    const catalog = buildCatalog();
    const unknown = lookupFeed(catalog, 'nope');
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe('FEED_NOT_FOUND');

    const invalid = lookupFeed(catalog, 'not a valid asset');
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.code).toBe('INVALID_ASSET');
  });

  it('refuses to serve a feed that is not publishable', () => {
    const catalog = buildCatalog();
    transitionFeed(catalog.lifecycle, {
      feedId: 'btc-usd',
      transition: 'suspend',
      actor: 'alice',
      role: 'operator',
      reason: 'incident',
    });
    const result = lookupFeed(catalog, 'btc-usd');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('FEED_NOT_PUBLISHABLE');

    const allowed = lookupFeed(catalog, 'btc-usd', { allowNonPublishable: true });
    expect(allowed.ok).toBe(true);
    if (allowed.ok) expect(allowed.publishable).toBe(false);
  });

  it('follows a rename alias and attaches alias metadata', () => {
    const catalog = buildCatalog();
    catalog.aliases.register({
      alias: 'btc-usd-old',
      successor: 'btc-usd',
      kind: 'rename',
      sunsetAt: '2026-12-01T00:00:00.000Z',
      notice: 'renamed to btc-usd',
      registeredAt: '2026-01-01T00:00:00.000Z',
      registeredBy: 'alice',
    });
    const result = lookupFeed(catalog, 'btc-usd-old', { now: new Date('2026-02-01T00:00:00.000Z') });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.feed.feedId).toBe('btc-usd');
      expect(result.alias?.requestedAlias).toBe('BTC-USD-OLD');
      expect(result.alias?.canonicalFeed).toBe('btc-usd');
      expect(result.alias?.deprecated).toBe(false);
    }
  });

  it('rejects a catalog entry whose policy is invalid', () => {
    const lifecycle = createFeedLifecycleStore();
    const catalog = createFeedCatalog(
      [
        {
          feedId: 'broken',
          asset: 'BROKEN',
          policy: policyFor('broken', 'BROKEN'),
        },
      ],
      [],
      lifecycle,
      createFeedAliasRegistry(),
    );
    const result = lookupFeed(catalog, 'broken');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_POLICY');
  });
});
