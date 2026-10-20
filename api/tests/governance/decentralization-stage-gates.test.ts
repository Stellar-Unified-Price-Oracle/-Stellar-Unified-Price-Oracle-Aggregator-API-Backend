import { describe, it, expect, beforeEach } from 'vitest';
import {
  computeConcentration,
  getStageGateReport,
  recordConcentrationSnapshot,
  transitionStage,
} from '../../src/governance/decentralization/stage-gates';
import { resetForTesting } from '../../src/governance/decentralization/store';
import type { ConcentrationDimension, WeightedEntity } from '../../src/governance/decentralization/types';

function entities(prefix: string, count: number): WeightedEntity[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}${index + 1}`,
    weight: 1,
  }));
}

function strongSnapshot() {
  return {
    provider: entities('provider-', 7),
    signer: entities('signer-', 7),
    governance: entities('voter-', 10),
    region: entities('region-', 4),
  };
}

function centralizedSnapshot() {
  return {
    provider: [{ id: 'only-provider', weight: 100 }],
    signer: [{ id: 'only-signer', weight: 100 }],
    governance: [{ id: 'only-voter', weight: 100 }],
    region: [{ id: 'only-region', weight: 100 }],
  };
}

describe('concentration measures (#783)', () => {
  it('computes HHI, top-1 share and the Nakamoto coefficient from shares', () => {
    const measure = computeConcentration('provider', entities('p', 4));

    expect(measure.entityCount).toBe(4);
    expect(measure.top1Share).toBeCloseTo(0.25, 6);
    expect(measure.hhi).toBeCloseTo(2500, 2);
    expect(measure.nakamotoCoefficient).toBe(3);
  });

  it('requires more than half of the weight for the Nakamoto coefficient', () => {
    const measure = computeConcentration('signer', [
      { id: 'a', weight: 50 },
      { id: 'b', weight: 50 },
    ]);

    expect(measure.nakamotoCoefficient).toBe(2);
  });

  it('counts a 60% holder as a single-party majority', () => {
    const measure = computeConcentration('governance', [
      { id: 'whale', weight: 60 },
      { id: 'other', weight: 40 },
    ]);

    expect(measure.nakamotoCoefficient).toBe(1);
    expect(measure.top1Share).toBeCloseTo(0.6, 6);
  });

  it('rejects an empty dimension', () => {
    expect(() => computeConcentration('region', [])).toThrowError(/cannot be measured/);
  });

  it('rejects duplicate entity ids', () => {
    expect(() =>
      computeConcentration('provider', [
        { id: 'dup', weight: 1 },
        { id: 'dup', weight: 1 },
      ]),
    ).toThrowError(/Duplicate provider entity/);
  });

  it('rejects negative weights', () => {
    expect(() =>
      computeConcentration('provider', [{ id: 'bad', weight: -5 }]),
    ).toThrowError(/negative or non-numeric weight/);
  });

  it('rejects a dimension whose weights are all zero', () => {
    expect(() =>
      computeConcentration('signer', [
        { id: 'a', weight: 0 },
        { id: 'b', weight: 0 },
      ]),
    ).toThrowError(/concentration is undefined/);
  });
});

describe('decentralization stage gates (#783)', () => {
  beforeEach(() => {
    resetForTesting();
  });

  it('records a baseline snapshot and reports baseline measures without claiming advancement', () => {
    const report = recordConcentrationSnapshot(strongSnapshot(), 1_700_000_000);

    expect(report.currentStage).toBe('stage-0');
    expect(report.achievedStage).toBe('stage-3');
    expect(report.nextStage).toBe('stage-1');
    expect(report.baseline?.provider.entityCount).toBe(7);
    expect(report.sustain.consecutivePassingSnapshots).toBe(1);
    expect(report.eligibleForNextStage).toBe(false);
    expect(report.findings).toEqual([]);
  });

  it('requires the next stage gates on three consecutive snapshots before advancing', () => {
    recordConcentrationSnapshot(strongSnapshot(), 1_700_000_000);
    recordConcentrationSnapshot(strongSnapshot(), 1_700_086_400);
    const report = recordConcentrationSnapshot(strongSnapshot(), 1_700_172_800);

    expect(report.sustain.satisfied).toBe(true);
    expect(report.eligibleForNextStage).toBe(true);

    const advanced = transitionStage('stage-1');
    expect(advanced.currentStage).toBe('stage-1');
    expect(advanced.regression).toBe(false);
  });

  it('refuses an advance before the gates are sustained', () => {
    recordConcentrationSnapshot(strongSnapshot(), 1_700_000_000);

    expect(() => transitionStage('stage-1')).toThrowError(/gates are not met/);
  });

  it('refuses to skip a stage', () => {
    recordConcentrationSnapshot(strongSnapshot(), 1_700_000_000);
    recordConcentrationSnapshot(strongSnapshot(), 1_700_086_400);
    recordConcentrationSnapshot(strongSnapshot(), 1_700_172_800);

    expect(() => transitionStage('stage-3')).toThrowError(/cannot jump/);
  });

  it('allows rolling back to an earlier stage for recovery', () => {
    recordConcentrationSnapshot(strongSnapshot(), 1_700_000_000);
    recordConcentrationSnapshot(strongSnapshot(), 1_700_086_400);
    recordConcentrationSnapshot(strongSnapshot(), 1_700_172_800);
    transitionStage('stage-1');

    const rolledBack = transitionStage('stage-0');
    expect(rolledBack.currentStage).toBe('stage-0');
    expect(rolledBack.regression).toBe(false);
  });

  it('detects regression when current-stage gates stop passing', () => {
    recordConcentrationSnapshot(strongSnapshot(), 1_700_000_000);
    recordConcentrationSnapshot(strongSnapshot(), 1_700_086_400);
    recordConcentrationSnapshot(strongSnapshot(), 1_700_172_800);
    transitionStage('stage-1');

    const report = recordConcentrationSnapshot(centralizedSnapshot(), 1_700_259_200);

    expect(report.currentStage).toBe('stage-1');
    expect(report.regression).toBe(true);
    expect(report.achievedStage).toBe('stage-0');
    expect(report.findings.length).toBeGreaterThan(0);
  });

  it('rejects out-of-order snapshots so history cannot be rewritten silently', () => {
    recordConcentrationSnapshot(strongSnapshot(), 1_700_000_000);

    expect(() =>
      recordConcentrationSnapshot(strongSnapshot(), 1_699_000_000),
    ).toThrowError(/earlier than the latest recorded snapshot/);
  });

  it('fails closed when a dimension is missing from a snapshot', () => {
    const inputs = strongSnapshot();
    inputs.provider = [];

    expect(() => recordConcentrationSnapshot(inputs, 1_700_000_000)).toThrowError(
      /No provider entities/,
    );
  });

  it('reports no snapshot explicitly rather than inventing an evaluation', () => {
    expect(() => getStageGateReport()).toThrowError(/No concentration snapshot/);
  });

  it('returns per-criterion checks for each dimension and stage', () => {
    const report = recordConcentrationSnapshot(centralizedSnapshot(), 1_700_000_000);
    const providerStage1: ConcentrationDimension = 'provider';
    const stage1 = report.stages.find((stage) => stage.stage === 'stage-1')!;
    const provider = stage1.dimensions.find((dimension) => dimension.dimension === providerStage1)!;

    expect(stage1.passed).toBe(false);
    expect(provider.checks.find((check) => check.criterion === 'minEntities')).toMatchObject({
      actual: 1,
      required: 3,
      passed: false,
    });
    expect(provider.checks.find((check) => check.criterion === 'minNakamoto')).toMatchObject({
      actual: 1,
      required: 2,
      passed: false,
    });
  });
});
