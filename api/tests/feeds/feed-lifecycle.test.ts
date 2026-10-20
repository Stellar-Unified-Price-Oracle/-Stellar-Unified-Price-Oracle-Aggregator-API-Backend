import { describe, it, expect } from 'vitest';
import {
  createFeedLifecycleStore,
  registerFeed,
  transitionFeed,
  isPublishableState,
  isCanaryState,
} from '../../src/feeds/feed-lifecycle';

function setup() {
  const store = createFeedLifecycleStore();
  const registered = registerFeed(store, {
    feedId: 'btc-usd',
    actor: 'alice',
    role: 'operator',
    reason: 'initial proposal',
    at: '2026-01-01T00:00:00.000Z',
  });
  expect(registered.ok).toBe(true);
  return store;
}

describe('feed lifecycle (#672)', () => {
  it('registers a feed in the proposed state with a change record', () => {
    const store = setup();
    const entry = store.get('btc-usd');
    expect(entry?.state).toBe('proposed');
    expect(entry?.version).toBe(1);
    expect(entry?.changeLog).toHaveLength(1);
    expect(entry?.changeLog[0]).toMatchObject({ from: null, to: 'proposed', sequence: 1, actor: 'alice' });
  });

  it('refuses to register the same feed twice', () => {
    const store = setup();
    const again = registerFeed(store, { feedId: 'btc-usd', actor: 'alice', role: 'operator' });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe('INVALID_TRANSITION');
  });

  it('refuses registration by a viewer', () => {
    const store = createFeedLifecycleStore();
    const result = registerFeed(store, { feedId: 'x', actor: 'v', role: 'viewer' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INSUFFICIENT_ROLE');
  });

  it('walks the full lifecycle and records every transition', () => {
    const store = setup();
    const steps: Array<[string, 'operator' | 'admin']> = [
      ['validate', 'operator'],
      ['promote-to-canary', 'operator'],
      ['activate', 'admin'],
      ['suspend', 'operator'],
      ['resume', 'operator'],
      ['retire', 'admin'],
    ];
    for (const [transition, role] of steps) {
      const result = transitionFeed(store, {
        feedId: 'btc-usd',
        transition: transition as never,
        actor: 'alice',
        role,
        reason: `moving to ${transition}`,
        at: '2026-01-02T00:00:00.000Z',
      });
      expect(result.ok).toBe(true);
    }
    const entry = store.get('btc-usd');
    expect(entry?.state).toBe('retired');
    expect(entry?.changeLog).toHaveLength(7);
    expect(entry?.changeLog.map((r) => r.to)).toEqual([
      'proposed',
      'validated',
      'canary',
      'active',
      'suspended',
      'active',
      'retired',
    ]);
  });

  it('refuses a transition that is not allowed from the current state', () => {
    const store = setup();
    const result = transitionFeed(store, {
      feedId: 'btc-usd',
      transition: 'activate',
      actor: 'alice',
      role: 'admin',
      reason: 'skipping ahead',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_TRANSITION');
  });

  it('refuses a transition the actor role is too low for', () => {
    const store = setup();
    transitionFeed(store, {
      feedId: 'btc-usd',
      transition: 'validate',
      actor: 'alice',
      role: 'operator',
      reason: 'ok',
    });
    transitionFeed(store, {
      feedId: 'btc-usd',
      transition: 'promote-to-canary',
      actor: 'alice',
      role: 'operator',
      reason: 'ok',
    });
    const result = transitionFeed(store, {
      feedId: 'btc-usd',
      transition: 'activate',
      actor: 'bob',
      role: 'operator',
      reason: 'operator cannot activate',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INSUFFICIENT_ROLE');
  });

  it('requires a reason for every transition', () => {
    const store = setup();
    const result = transitionFeed(store, {
      feedId: 'btc-usd',
      transition: 'validate',
      actor: 'alice',
      role: 'operator',
      reason: '   ',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('reason');
  });

  it('treats retirement as a terminal state', () => {
    const store = setup();
    for (const [transition, role] of [
      ['validate', 'operator'],
      ['promote-to-canary', 'operator'],
      ['activate', 'admin'],
      ['retire', 'admin'],
    ] as const) {
      transitionFeed(store, { feedId: 'btc-usd', transition, actor: 'alice', role, reason: 'ok' });
    }
    const result = transitionFeed(store, {
      feedId: 'btc-usd',
      transition: 'resume',
      actor: 'alice',
      role: 'admin',
      reason: 'bring it back',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('TERMINAL_STATE');
  });

  it('reports an unknown feed', () => {
    const store = setup();
    const result = transitionFeed(store, {
      feedId: 'nope',
      transition: 'validate',
      actor: 'alice',
      role: 'operator',
      reason: 'ok',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('FEED_NOT_FOUND');
  });

  it('knows which states publish prices', () => {
    expect(isPublishableState('active')).toBe(true);
    expect(isPublishableState('canary')).toBe(false);
    expect(isCanaryState('canary')).toBe(true);
    expect(isCanaryState('suspended')).toBe(false);
  });
});
