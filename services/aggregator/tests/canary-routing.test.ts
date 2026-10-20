import { describe, it, expect } from 'vitest';
import {
  BPS_DENOMINATOR,
  CanaryRollbackGuard,
  shouldRouteToCanary,
} from '../src/contract-publishing/canary';
import {
  ReleaseTrain,
  ReleaseTrainHaltedError,
  type RegionHealth,
  type RegionStage,
} from '../src/contract-publishing/release-train';

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

const healthy = (overrides: Partial<RegionHealth> = {}): RegionHealth => ({
  errorRateBps: 10,
  p99LatencyMs: 200,
  ...overrides,
});

const REGIONS = ['us-east', 'eu-west', 'ap-south'] as const;

const buildTrain = (): ReleaseTrain =>
  new ReleaseTrain({
    regions: [...REGIONS],
    maxErrorRateBps: 100,
    maxP99LatencyMs: 500,
    minHealthyWindows: 2,
  });

describe('ReleaseTrain — staged promotion across regions (Issue #735)', () => {
  it('promotes regions in declared order once health windows pass', () => {
    const train = buildTrain();
    expect(train.stageOf('us-east')).toBe<RegionStage>('pending');

    train.recordHealth('us-east', healthy());
    train.recordHealth('us-east', healthy());
    expect(train.stageOf('us-east')).toBe<RegionStage>('verified');

    train.promote('us-east');
    expect(train.stageOf('us-east')).toBe<RegionStage>('live');
    expect(train.liveRegions()).toEqual(['us-east']);
  });

  it('refuses to promote a later region before earlier regions are live', () => {
    const train = buildTrain();
    train.recordHealth('eu-west', healthy());
    train.recordHealth('eu-west', healthy());
    expect(() => train.promote('eu-west')).toThrow(ReleaseTrainHaltedError);
    expect(train.stageOf('eu-west')).toBe<RegionStage>('verified');
  });

  it('refuses to promote a region that has not met the health window', () => {
    const train = buildTrain();
    train.recordHealth('us-east', healthy());
    expect(() => train.promote('us-east')).toThrow(ReleaseTrainHaltedError);
  });

  it('rejects unknown regions', () => {
    const train = buildTrain();
    expect(() => train.recordHealth('mars-1', healthy())).toThrow();
    expect(() => train.promote('mars-1')).toThrow();
  });
});

describe('ReleaseTrain — automatic halt conditions (Issue #735)', () => {
  it('halts the train when error rate exceeds the budget', () => {
    const train = buildTrain();
    train.recordHealth('us-east', healthy({ errorRateBps: 101 }));
    expect(train.isHalted()).toBe(true);
    expect(train.haltReason()).toMatch(/error rate/i);
    expect(() => train.promote('us-east')).toThrow(ReleaseTrainHaltedError);
  });

  it('halts the train when p99 latency exceeds the budget', () => {
    const train = buildTrain();
    train.recordHealth('us-east', healthy({ p99LatencyMs: 501 }));
    expect(train.isHalted()).toBe(true);
    expect(train.haltReason()).toMatch(/latency/i);
  });

  it('does not halt at the exact budget boundary', () => {
    const train = buildTrain();
    train.recordHealth('us-east', healthy({ errorRateBps: 100, p99LatencyMs: 500 }));
    expect(train.isHalted()).toBe(false);
    expect(train.haltReason()).toBeNull();
  });

  it('a halt in a live region blocks promotion of subsequent regions', () => {
    const train = buildTrain();
    train.recordHealth('us-east', healthy());
    train.recordHealth('us-east', healthy());
    train.promote('us-east');

    train.recordHealth('us-east', healthy({ errorRateBps: 250 }));
    expect(train.isHalted()).toBe(true);
    expect(() => train.promote('eu-west')).toThrow(ReleaseTrainHaltedError);
  });

  it('resets the health window when a failing sample arrives', () => {
    const train = buildTrain();
    train.recordHealth('us-east', healthy());
    train.recordHealth('us-east', healthy({ errorRateBps: 500 }));
    train.recordHealth('us-east', healthy());
    expect(train.stageOf('us-east')).toBe<RegionStage>('pending');
    expect(train.isHalted()).toBe(true);
  });

  it('rejects invalid health samples', () => {
    const train = buildTrain();
    expect(() => train.recordHealth('us-east', healthy({ errorRateBps: -1 }))).toThrow();
    expect(() => train.recordHealth('us-east', healthy({ p99LatencyMs: -5 }))).toThrow();
  });
});
