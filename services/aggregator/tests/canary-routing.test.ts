import { describe, it, expect } from 'vitest';
import {
  BPS_DENOMINATOR,
  CanaryRollbackGuard,
  shouldRouteToCanary,
} from '../src/contract-publishing/canary';

describe('shouldRouteToCanary — traffic splitting (Issue #105)', () => {
  it('never routes when the share is 0 bps', () => {
    for (let seq = 0; seq < 500; seq += 1) {
      expect(shouldRouteToCanary(seq, 0)).toBe(false);
    }
  });

  it('always routes when the share is 10000 bps (full canary)', () => {
    for (let seq = 0; seq < 500; seq += 1) {
      expect(shouldRouteToCanary(seq, 10_000)).toBe(true);
    }
  });

  it('routes roughly the configured percentage over a full cycle', () => {
    const shareBps = 5_000; // 50%
    let routed = 0;
    const cycles = 20;
    for (let seq = 0; seq < BPS_DENOMINATOR * cycles; seq += 1) {
      if (shouldRouteToCanary(seq, shareBps)) routed += 1;
    }
    expect(routed).toBe(BPS_DENOMINATOR * cycles * 0.5);
  });

  it('routes exactly shareBps submissions per 10_000-sequence cycle', () => {
    const shareBps = 1_000; // 10%
    let routed = 0;
    for (let seq = 0; seq < BPS_DENOMINATOR; seq += 1) {
      if (shouldRouteToCanary(seq, shareBps)) routed += 1;
    }
    expect(routed).toBe(1_000);
  });

  it('clamps out-of-range shares to the valid 0..10000 range', () => {
    expect(shouldRouteToCanary(0, -500)).toBe(false);
    expect(shouldRouteToCanary(0, 12_000)).toBe(true);
  });

  it('routing decisions are deterministic for a given sequence', () => {
    const seq = 4_567;
    const first = shouldRouteToCanary(seq, 2_500);
    for (let i = 0; i < 10; i += 1) {
      expect(shouldRouteToCanary(seq, 2_500)).toBe(first);
    }
  });
});

describe('CanaryRollbackGuard — failure threshold (Issue #105)', () => {
  it('does not roll back before the threshold is reached', () => {
    const guard = new CanaryRollbackGuard(3);
    expect(guard.recordFailure()).toBe(false);
    expect(guard.recordFailure()).toBe(false);
    expect(guard.consecutiveFailures()).toBe(2);
    expect(guard.shouldRollback()).toBe(false);
  });

  it('signals rollback once consecutive failures reach the threshold', () => {
    const guard = new CanaryRollbackGuard(3);
    expect(guard.recordFailure()).toBe(false);
    expect(guard.recordFailure()).toBe(false);
    expect(guard.recordFailure()).toBe(true);
    expect(guard.shouldRollback()).toBe(true);
  });

  it('a success resets the failure streak', () => {
    const guard = new CanaryRollbackGuard(3);
    guard.recordFailure();
    guard.recordFailure();
    guard.recordSuccess();
    expect(guard.consecutiveFailures()).toBe(0);
    expect(guard.recordFailure()).toBe(false);
    expect(guard.shouldRollback()).toBe(false);
  });

  it('tracks total successes for observability', () => {
    const guard = new CanaryRollbackGuard(2);
    guard.recordSuccess();
    guard.recordSuccess();
    guard.recordFailure();
    expect(guard.totalSuccesses()).toBe(2);
  });

  it('rejects a non-positive threshold', () => {
    expect(() => new CanaryRollbackGuard(0)).toThrow();
    expect(() => new CanaryRollbackGuard(-1)).toThrow();
  });
});
