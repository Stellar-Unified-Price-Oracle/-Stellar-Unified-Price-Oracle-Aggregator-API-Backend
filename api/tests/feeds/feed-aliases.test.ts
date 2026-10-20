import { describe, it, expect } from 'vitest';
import {
  aliasMetadata,
  createFeedAliasRegistry,
  expiredFeedAliases,
  resolveFeedAlias,
} from '../../src/feeds/feed-aliases';

const REGISTRATION = '2026-01-01T00:00:00.000Z';
const SUNSET = '2026-04-01T00:00:00.000Z';

describe('feed alias semantics (#673)', () => {
  it('registers and resolves a rename alias', () => {
    const registry = createFeedAliasRegistry();
    const result = registry.register({
      alias: 'btc-usd',
      successor: 'btc-usd-v2',
      kind: 'rename',
      sunsetAt: SUNSET,
      notice: 'renamed to BTC/USD v2',
      registeredAt: REGISTRATION,
      registeredBy: 'alice',
    });
    expect(result.ok).toBe(true);

    const resolution = resolveFeedAlias(registry, 'BTC-USD', new Date('2026-02-01T00:00:00.000Z'));
    expect(resolution.known).toBe(true);
    expect(resolution.redirected).toBe(true);
    expect(resolution.resolvedFeed).toBe('btc-usd-v2');
    expect(resolution.expired).toBe(false);
    expect(resolution.kind).toBe('rename');
    expect(resolution.notice).toBe('renamed to BTC/USD v2');
  });

  it('resolves a merge alias to its successor', () => {
    const registry = createFeedAliasRegistry();
    registry.register({
      alias: 'btc-usd-legacy',
      successor: 'btc-usd',
      kind: 'merge',
      sunsetAt: SUNSET,
      notice: 'merged into BTC/USD',
      registeredAt: REGISTRATION,
      registeredBy: 'alice',
    });
    const resolution = resolveFeedAlias(registry, 'btc-usd-legacy');
    expect(resolution.known).toBe(true);
    expect(resolution.redirected).toBe(true);
    expect(resolution.kind).toBe('merge');
  });

  it('keeps a retired alias resolvable but reports no successor', () => {
    const registry = createFeedAliasRegistry();
    registry.register({
      alias: 'doge-usd',
      successor: null,
      kind: 'retirement',
      sunsetAt: SUNSET,
      notice: 'feed retired on 2026-01-01',
      registeredAt: REGISTRATION,
      registeredBy: 'alice',
    });
    const resolution = resolveFeedAlias(registry, 'doge-usd');
    expect(resolution.known).toBe(true);
    expect(resolution.redirected).toBe(false);
    expect(resolution.resolvedFeed).toBeNull();
    expect(resolution.notice).toContain('retired');
  });

  it('flags an alias as expired after its sunset date', () => {
    const registry = createFeedAliasRegistry();
    registry.register({
      alias: 'btc-usd',
      successor: 'btc-usd-v2',
      kind: 'rename',
      sunsetAt: SUNSET,
      notice: 'renamed',
      registeredAt: REGISTRATION,
      registeredBy: 'alice',
    });
    const resolution = resolveFeedAlias(registry, 'btc-usd', new Date('2026-06-01T00:00:00.000Z'));
    expect(resolution.expired).toBe(true);
    expect(resolution.resolvedFeed).toBe('btc-usd-v2');
  });

  it('returns an unknown alias as unknown', () => {
    const registry = createFeedAliasRegistry();
    const resolution = resolveFeedAlias(registry, 'nope');
    expect(resolution.known).toBe(false);
    expect(resolution.resolvedFeed).toBeNull();
  });

  it('refuses a duplicate alias', () => {
    const registry = createFeedAliasRegistry();
    const entry = {
      alias: 'btc-usd',
      successor: 'btc-usd-v2',
      kind: 'rename' as const,
      sunsetAt: SUNSET,
      notice: 'renamed',
      registeredAt: REGISTRATION,
      registeredBy: 'alice',
    };
    expect(registry.register(entry).ok).toBe(true);
    const second = registry.register(entry);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('ALIAS_EXISTS');
  });

  it('refuses a merge alias without a successor and a retirement with one', () => {
    const registry = createFeedAliasRegistry();
    const merge = registry.register({
      alias: 'a',
      successor: null,
      kind: 'merge',
      sunsetAt: SUNSET,
      notice: 'merged',
      registeredAt: REGISTRATION,
      registeredBy: 'alice',
    });
    expect(merge.ok).toBe(false);
    if (!merge.ok) expect(merge.error.code).toBe('INVALID_SUCCESSOR');

    const retirement = registry.register({
      alias: 'b',
      successor: 'c',
      kind: 'retirement',
      sunsetAt: SUNSET,
      notice: 'retired',
      registeredAt: REGISTRATION,
      registeredBy: 'alice',
    });
    expect(retirement.ok).toBe(false);
  });

  it('refuses an invalid sunset date', () => {
    const registry = createFeedAliasRegistry();
    const invalid = registry.register({
      alias: 'a',
      successor: 'b',
      kind: 'rename',
      sunsetAt: 'not-a-date',
      notice: 'x',
      registeredAt: REGISTRATION,
      registeredBy: 'alice',
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.code).toBe('INVALID_SUNSET');

    const backwards = registry.register({
      alias: 'c',
      successor: 'b',
      kind: 'rename',
      sunsetAt: '2025-01-01T00:00:00.000Z',
      notice: 'x',
      registeredAt: REGISTRATION,
      registeredBy: 'alice',
    });
    expect(backwards.ok).toBe(false);
  });

  it('lists expired aliases for cleanup', () => {
    const registry = createFeedAliasRegistry();
    registry.register({
      alias: 'old',
      successor: 'new',
      kind: 'rename',
      sunsetAt: '2026-02-01T00:00:00.000Z',
      notice: 'x',
      registeredAt: REGISTRATION,
      registeredBy: 'alice',
    });
    const expired = expiredFeedAliases(registry, new Date('2026-03-01T00:00:00.000Z'));
    expect(expired.map((e) => e.alias)).toEqual(['OLD']);
  });

  it('builds response metadata for an alias-served response', () => {
    const registry = createFeedAliasRegistry();
    registry.register({
      alias: 'btc-usd',
      successor: 'btc-usd-v2',
      kind: 'rename',
      sunsetAt: SUNSET,
      notice: 'renamed to BTC/USD v2',
      registeredAt: REGISTRATION,
      registeredBy: 'alice',
    });
    const metadata = aliasMetadata(
      resolveFeedAlias(registry, 'btc-usd', new Date('2026-02-01T00:00:00.000Z')),
    );
    expect(metadata).toEqual({
      requestedAlias: 'BTC-USD',
      canonicalFeed: 'btc-usd-v2',
      aliasKind: 'rename',
      notice: 'renamed to BTC/USD v2',
      sunsetAt: SUNSET,
      deprecated: false,
    });
  });

  it('produces no metadata for an unknown or retired alias', () => {
    const registry = createFeedAliasRegistry();
    expect(aliasMetadata(resolveFeedAlias(registry, 'nope'))).toBeNull();

    registry.register({
      alias: 'doge',
      successor: null,
      kind: 'retirement',
      sunsetAt: SUNSET,
      notice: 'retired',
      registeredAt: REGISTRATION,
      registeredBy: 'alice',
    });
    expect(aliasMetadata(resolveFeedAlias(registry, 'doge'))).toBeNull();
  });
});
