import { describe, expect, it } from 'vitest';
import { FeedCatalogSnapshotStore, CatalogReleaseManager } from '../../src/feeds/catalog-snapshots';
import { createFeedAliasRegistry } from '../../src/feeds/feed-aliases';
import { createFeedLifecycleStore, registerFeed, transitionFeed } from '../../src/feeds/feed-lifecycle';
import type { FeedPolicy } from '../../src/feeds/feed-policy';
import { isFeedMetadata } from '../../../packages/sdk-bindings/src/generated/feedMetadata';

const policy: FeedPolicy = {
  feedId: 'btc-usd', asset: 'public:BTC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  version: 1, sources: [{ name: 'chainlink', eligible: true }], quorum: { minSources: 1 },
};

describe('catalog consumer compatibility', () => {
  it('keeps canonical feed fields stable through alias, canary, active and retirement transitions', () => {
    const lifecycle = createFeedLifecycleStore();
    registerFeed(lifecycle, { feedId: policy.feedId, actor: 'test', role: 'operator' });
    transitionFeed(lifecycle, { feedId: policy.feedId, transition: 'validate', actor: 'test', role: 'operator', reason: 'validated' });
    transitionFeed(lifecycle, { feedId: policy.feedId, transition: 'promote-to-canary', actor: 'test', role: 'operator', reason: 'canary' });
    const aliases = createFeedAliasRegistry();
    aliases.register({ alias: 'old-btc-usd', successor: policy.feedId, kind: 'rename', sunsetAt: '2030-01-01T00:00:00Z', notice: 'Use btc-usd', registeredAt: '2026-01-01T00:00:00Z', registeredBy: 'test' });
    aliases.register({ alias: 'retired-btc-usd', successor: null, kind: 'retirement', sunsetAt: '2030-01-01T00:00:00Z', notice: 'This feed was retired', registeredAt: '2026-01-01T00:00:00Z', registeredBy: 'test' });
    const store = new FeedCatalogSnapshotStore();
    const canary = store.create({ policies: [policy], lifecycle: (id) => lifecycle.get(id), aliases: aliases.list() }, '2026-01-01T00:00:00Z');
    const consumerShape = JSON.parse(JSON.stringify(canary));
    expect(consumerShape.feeds[0].policy).toMatchObject({ feedId: 'btc-usd', asset: policy.asset, version: 1 });
    expect(consumerShape.feeds[0].lifecycle.state).toBe('canary');
    expect(consumerShape.aliases[0]).toMatchObject({ alias: 'OLD-BTC-USD', successor: 'btc-usd', kind: 'rename' });
    expect(consumerShape.aliases[1]).toMatchObject({ alias: 'RETIRED-BTC-USD', successor: null, kind: 'retirement' });
    const sdkV1Metadata = {
      asset: 'BTC/USD', decimals: 8, sources: ['chainlink'], heartbeatSeconds: 60,
      status: consumerShape.feeds[0].lifecycle.state === 'active' ? 'active' : 'paused',
    };
    expect(isFeedMetadata(sdkV1Metadata)).toBe(true);

    transitionFeed(lifecycle, { feedId: policy.feedId, transition: 'activate', actor: 'admin', role: 'admin', reason: 'promoted' });
    transitionFeed(lifecycle, { feedId: policy.feedId, transition: 'retire', actor: 'admin', role: 'admin', reason: 'retired' });
    const retired = store.create({ policies: [policy], lifecycle: (id) => lifecycle.get(id), aliases: aliases.list() }, '2026-01-02T00:00:00Z');
    expect(retired.feeds[0].policy.feedId).toBe('btc-usd');
    expect(retired.feeds[0].lifecycle?.state).toBe('retired');
    expect(isFeedMetadata({ asset: 'BTC/USD', decimals: 8, sources: ['chainlink'], heartbeatSeconds: 60, status: 'deprecated' })).toBe(true);
    expect(store.get(canary.id)).toEqual(canary);
    expect(Object.isFrozen(canary.feeds[0].policy)).toBe(true);
    const difference = new CatalogReleaseManager('a'.repeat(40));
    const stable = store.create({ policies: [policy], lifecycle: (id) => lifecycle.get(id), aliases: [] }, '2026-01-03T00:00:00Z');
    const changed = store.create({ policies: [{ ...policy, version: 2 }], lifecycle: (id) => lifecycle.get(id), aliases: aliases.list() }, '2026-01-04T00:00:00Z');
    expect(difference.compare(changed.id, changed, stable)).toMatchObject({ changedFeeds: ['btc-usd'], aliasesChanged: true });
  });

  it('requires signed releases for canary promotion and rollback', () => {
    const releases = new CatalogReleaseManager('a'.repeat(40));
    const first = releases.sign('snapshot-1', '2026-01-01T00:00:00Z');
    const second = releases.sign('snapshot-2', '2026-01-02T00:00:00Z');
    expect(releases.stageCanary(first)).toBe(true);
    expect(releases.promoteCanary()).toBe(true);
    expect(releases.stageCanary(second)).toBe(true);
    expect(releases.compare('snapshot-2').matchesStable).toBe(false);
    expect(releases.promoteCanary()).toBe(true);
    expect(releases.rollback(first.snapshotId, first.signature)).toBe(true);
    expect(releases.state().stable?.snapshotId).toBe('snapshot-1');
    expect(releases.rollback('snapshot-forged', 'deadbeef')).toBe(false);
  });
});
