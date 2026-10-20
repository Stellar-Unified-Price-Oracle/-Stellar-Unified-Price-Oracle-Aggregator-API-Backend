import { describe, it, expect } from 'vitest';
import { TenantWindow, type SharedCountStore } from '../src/platform/tenant-window';
import {
  TIER_RATE_LIMITS,
  TIER_RATE_LIMIT_CEILINGS,
  effectiveTenantLimit,
  clampOverride,
} from '../src/platform/limit-model';

/**
 * Adversarial noisy-neighbor and quota-isolation checks (issue #757).
 * Procedure and rollout notes: docs/security/quota-isolation-testing.md
 */

class InMemoryStore implements SharedCountStore {
  private counts = new Map<string, number>();
  async increment(identity: string, windowStart: number): Promise<number> {
    const k = `${identity}:${windowStart}`;
    const n = (this.counts.get(k) ?? 0) + 1;
    this.counts.set(k, n);
    return n;
  }
}

class FailingStore implements SharedCountStore {
  async increment(): Promise<number> {
    throw new Error('store unavailable');
  }
}

describe('quota isolation: noisy neighbor', () => {
  it('a flooding consumer does not consume another consumer allowance', async () => {
    const win = new TenantWindow();
    const limit = 5;
    for (let i = 0; i < 1000; i++) await win.consume('noisy', limit);
    const noisy = await win.consume('noisy', limit);
    expect(noisy.allowed).toBe(false);

    const quiet = await win.consume('quiet', limit);
    expect(quiet.allowed).toBe(true);
    expect(quiet.consumed).toBe(1);
    expect(quiet.remaining).toBe(limit - 1);
  });

  it('many concurrent identities each get their own full budget', async () => {
    const win = new TenantWindow();
    const results = await Promise.all(
      Array.from({ length: 200 }, (_, i) => win.consume(`tenant-${i}`, 3)),
    );
    expect(results.every((r) => r.allowed && r.consumed === 1)).toBe(true);
  });

  it('concurrent burst from one identity never admits more than the limit', async () => {
    const win = new TenantWindow(new InMemoryStore());
    const limit = 10;
    const results = await Promise.all(Array.from({ length: 100 }, () => win.consume('burst', limit)));
    expect(results.filter((r) => r.allowed).length).toBe(limit);
  });

  it('identities that only differ by case or whitespace are separate budgets (no shared-bucket collapse)', async () => {
    const win = new TenantWindow();
    await win.consume('Key-A', 1);
    const other = await win.consume('key-a ', 1);
    expect(other.allowed).toBe(true);
  });
});

describe('quota isolation: shared store behavior', () => {
  it('replicas pointing at the same store share one budget', async () => {
    const store = new InMemoryStore();
    const podA = new TenantWindow(store);
    const podB = new TenantWindow(store);
    const limit = 4;
    for (let i = 0; i < 2; i++) await podA.consume('k', limit);
    for (let i = 0; i < 2; i++) await podB.consume('k', limit);
    const next = await podA.consume('k', limit);
    expect(next.allowed).toBe(false);
    expect(next.mode).toBe('shared-redis');
  });

  it('falls back to a local per-pod counter when the shared store fails, and still enforces', async () => {
    const win = new TenantWindow(new FailingStore());
    const first = await win.consume('k', 2);
    expect(first.mode).toBe('local-per-pod');
    expect(first.shared).toBe(false);
    await win.consume('k', 2);
    const third = await win.consume('k', 2);
    expect(third.allowed).toBe(false);
  });
});

describe('quota isolation: limit bypass attempts', () => {
  it('limit 0 denies every request', async () => {
    const win = new TenantWindow();
    const r = await win.consume('k', 0);
    expect(r.allowed).toBe(false);
    expect(r.remaining).toBe(0);
  });

  it('overrides above the tier ceiling are clamped', () => {
    for (const tier of Object.keys(TIER_RATE_LIMITS) as Array<keyof typeof TIER_RATE_LIMITS>) {
      const ceiling = TIER_RATE_LIMIT_CEILINGS[tier];
      expect(effectiveTenantLimit(tier, ceiling * 100)).toBe(ceiling);
      expect(effectiveTenantLimit(tier, Number.MAX_SAFE_INTEGER)).toBe(ceiling);
      expect(clampOverride(tier, ceiling + 1).clamped).toBe(true);
    }
  });

  it('malformed overrides fall back to the tier default rather than unlimited', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -5, undefined]) {
      expect(effectiveTenantLimit('free', bad as number | undefined)).toBe(TIER_RATE_LIMITS.free);
    }
    expect(effectiveTenantLimit('free', '9999' as unknown as number)).toBe(TIER_RATE_LIMITS.free);
  });

  it('fractional overrides are floored, never rounded up past the stated value', () => {
    expect(effectiveTenantLimit('free', 59.99)).toBe(59);
  });

  it('a free-tier consumer cannot exceed its ceiling even with a huge requested override', async () => {
    const win = new TenantWindow();
    const limit = effectiveTenantLimit('free', 1e9);
    expect(limit).toBe(TIER_RATE_LIMIT_CEILINGS.free);
    let allowed = 0;
    for (let i = 0; i < limit + 50; i++) if ((await win.consume('free-user', limit)).allowed) allowed++;
    expect(allowed).toBe(limit);
  });
});
