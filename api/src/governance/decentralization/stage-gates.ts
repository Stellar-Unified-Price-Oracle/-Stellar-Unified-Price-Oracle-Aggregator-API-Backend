import {
  decentralizationNakamotoCoefficient,
  decentralizationStageGatePassed,
  decentralizationTop1Share,
} from '../../observability/metrics';
import {
  appendSnapshot,
  getBaselineSnapshot,
  getCurrentStage,
  getLatestSnapshot,
  getSnapshots,
  nextId,
  setCurrentStage,
} from './store';
import {
  GovernanceReportingError,
  type ConcentrationDimension,
  type ConcentrationMeasures,
  type ConcentrationSnapshot,
  type DecentralizationStageReport,
  type DimensionGateResult,
  type StageDefinition,
  type StageGateReport,
  type StageGateThresholds,
  type WeightedEntity,
} from './types';

export const CONCENTRATION_DIMENSIONS: ConcentrationDimension[] = [
  'provider',
  'signer',
  'governance',
  'region',
];

const SUSTAINED_SNAPSHOTS_REQUIRED = 3;

function gate(
  minEntities: number,
  maxTop1Share: number,
  maxHhi: number,
  minNakamoto: number,
): StageGateThresholds {
  return { minEntities, maxTop1Share, maxHhi, minNakamoto };
}

/**
 * Stages are absolute, not cumulative: each stage's gates are stricter than the
 * previous stage's, so passing stage N's gates implies passing stage N-1's.
 */
export const DECENTRALIZATION_STAGES: StageDefinition[] = [
  {
    id: 'stage-0',
    name: 'Baseline',
    description: 'Single-operator baseline captured before any decentralization claim.',
    gates: {
      provider: gate(1, 1, 10_000, 1),
      signer: gate(1, 1, 10_000, 1),
      governance: gate(1, 1, 10_000, 1),
      region: gate(1, 1, 10_000, 1),
    },
  },
  {
    id: 'stage-1',
    name: 'Distributed',
    description: 'No single provider, signer, voter or region can act alone by default.',
    gates: {
      provider: gate(3, 0.6, 5_000, 2),
      signer: gate(3, 0.6, 5_000, 2),
      governance: gate(4, 0.5, 4_000, 2),
      region: gate(2, 0.7, 6_000, 2),
    },
  },
  {
    id: 'stage-2',
    name: 'Independent',
    description:
      'Independent operators control quorums: at least three parties are needed to exceed half of any dimension.',
    gates: {
      provider: gate(4, 0.45, 3_000, 3),
      signer: gate(5, 0.4, 3_000, 3),
      governance: gate(6, 0.35, 2_500, 3),
      region: gate(3, 0.55, 4_000, 2),
    },
  },
  {
    id: 'stage-3',
    name: 'Decentralized',
    description:
      'Mature decentralization: no party or region holds a blocking share of any dimension.',
    gates: {
      provider: gate(5, 0.35, 2_000, 4),
      signer: gate(7, 0.3, 2_000, 4),
      governance: gate(10, 0.25, 1_500, 4),
      region: gate(4, 0.45, 3_000, 3),
    },
  },
];

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function computeConcentration(
  dimension: ConcentrationDimension,
  entities: WeightedEntity[],
): ConcentrationMeasures {
  if (entities.length === 0) {
    throw new GovernanceReportingError(
      'EMPTY_DIMENSION',
      `No ${dimension} entities supplied; concentration cannot be measured`,
    );
  }

  const seen = new Set<string>();
  let totalWeight = 0;
  for (const entity of entities) {
    if (!entity.id.trim()) {
      throw new GovernanceReportingError(
        'INVALID_ENTITY',
        `A ${dimension} entity is missing an id`,
      );
    }
    if (seen.has(entity.id)) {
      throw new GovernanceReportingError(
        'DUPLICATE_ENTITY',
        `Duplicate ${dimension} entity id "${entity.id}"`,
      );
    }
    seen.add(entity.id);
    if (!Number.isFinite(entity.weight) || entity.weight < 0) {
      throw new GovernanceReportingError(
        'INVALID_WEIGHT',
        `${dimension} entity "${entity.id}" has a negative or non-numeric weight`,
      );
    }
    totalWeight += entity.weight;
  }

  if (totalWeight <= 0) {
    throw new GovernanceReportingError(
      'ZERO_WEIGHT',
      `All ${dimension} weights are zero; concentration is undefined`,
    );
  }

  const shares = entities
    .map((entity) => ({
      id: entity.id,
      share: round(entity.weight / totalWeight, 6),
    }))
    .sort((a, b) => b.share - a.share);

  const hhi = round(
    shares.reduce((sum, entry) => sum + (entry.share * 100) ** 2, 0),
    2,
  );
  const top1Share = shares[0].share;

  let cumulative = 0;
  let nakamotoCoefficient = 0;
  for (const entry of shares) {
    cumulative += entry.share;
    nakamotoCoefficient++;
    if (cumulative > 0.5) break;
  }

  return {
    dimension,
    entityCount: entities.length,
    totalWeight: round(totalWeight, 6),
    hhi,
    top1Share,
    nakamotoCoefficient,
    shares,
  };
}

function evaluateDimension(
  measured: ConcentrationMeasures,
  thresholds: StageGateThresholds,
): DimensionGateResult {
  const checks = [
    {
      criterion: 'minEntities' as const,
      actual: measured.entityCount,
      required: thresholds.minEntities,
      comparison: '>=' as const,
      passed: measured.entityCount >= thresholds.minEntities,
    },
    {
      criterion: 'maxTop1Share' as const,
      actual: measured.top1Share,
      required: thresholds.maxTop1Share,
      comparison: '<=' as const,
      passed: measured.top1Share <= thresholds.maxTop1Share,
    },
    {
      criterion: 'maxHhi' as const,
      actual: measured.hhi,
      required: thresholds.maxHhi,
      comparison: '<=' as const,
      passed: measured.hhi <= thresholds.maxHhi,
    },
    {
      criterion: 'minNakamoto' as const,
      actual: measured.nakamotoCoefficient,
      required: thresholds.minNakamoto,
      comparison: '>=' as const,
      passed: measured.nakamotoCoefficient >= thresholds.minNakamoto,
    },
  ];

  return {
    dimension: measured.dimension,
    measured,
    checks,
    passed: checks.every((check) => check.passed),
  };
}

function measuresFor(
  snapshot: ConcentrationSnapshot,
): Record<ConcentrationDimension, ConcentrationMeasures> {
  const measured = {} as Record<ConcentrationDimension, ConcentrationMeasures>;
  for (const dimension of CONCENTRATION_DIMENSIONS) {
    measured[dimension] = computeConcentration(dimension, snapshot.inputs[dimension]);
  }
  return measured;
}

function evaluateStage(
  stage: StageDefinition,
  measured: Record<ConcentrationDimension, ConcentrationMeasures>,
): DecentralizationStageReport {
  const dimensions = CONCENTRATION_DIMENSIONS.map((dimension) =>
    evaluateDimension(measured[dimension], stage.gates[dimension]),
  );
  return {
    stage: stage.id,
    passed: dimensions.every((dimension) => dimension.passed),
    dimensions,
  };
}

export function findStage(stageId: string): StageDefinition {
  const stage = DECENTRALIZATION_STAGES.find((candidate) => candidate.id === stageId);
  if (!stage) {
    throw new GovernanceReportingError('UNKNOWN_STAGE', `Unknown stage "${stageId}"`);
  }
  return stage;
}

function stageIndex(stageId: string): number {
  const index = DECENTRALIZATION_STAGES.findIndex((stage) => stage.id === stageId);
  if (index < 0) {
    throw new GovernanceReportingError('UNKNOWN_STAGE', `Unknown stage "${stageId}"`);
  }
  return index;
}

function consecutivePassingSnapshots(
  stage: StageDefinition,
  required: number,
): number {
  const snapshots = getSnapshots();
  let consecutive = 0;

  for (let i = snapshots.length - 1; i >= 0 && consecutive < required; i--) {
    const measured = measuresFor(snapshots[i]);
    if (evaluateStage(stage, measured).passed) {
      consecutive++;
    } else {
      break;
    }
  }

  return consecutive;
}

function buildReport(snapshot: ConcentrationSnapshot): StageGateReport {
  const measured = measuresFor(snapshot);
  const currentStage = findStage(getCurrentStage());
  const currentIndex = stageIndex(currentStage.id);
  const nextStage = DECENTRALIZATION_STAGES[currentIndex + 1] ?? null;

  const stages = DECENTRALIZATION_STAGES.map((stage) => evaluateStage(stage, measured));

  let achievedStage = DECENTRALIZATION_STAGES[0].id;
  for (const stage of stages) {
    if (stage.passed) achievedStage = stage.stage;
    else break;
  }

  const currentEvaluation = stages[currentIndex];
  const nextEvaluation = nextStage ? stages[currentIndex + 1] : null;
  const sustained = nextStage
    ? consecutivePassingSnapshots(nextStage, SUSTAINED_SNAPSHOTS_REQUIRED)
    : consecutivePassingSnapshots(currentStage, SUSTAINED_SNAPSHOTS_REQUIRED);

  const findings: string[] = [];
  for (const dimension of currentEvaluation.dimensions) {
    if (dimension.passed) continue;
    for (const check of dimension.checks) {
      if (!check.passed) {
        findings.push(
          `${dimension.dimension} ${check.criterion} is ${check.actual}, ` +
            `stage ${currentStage.id} requires ${check.comparison} ${check.required}`,
        );
      }
    }
  }

  const baselineSnapshot = getBaselineSnapshot();

  return {
    generatedAt: Math.floor(Date.now() / 1000),
    snapshotId: snapshot.id,
    currentStage: currentStage.id,
    achievedStage,
    nextStage: nextStage ? nextStage.id : null,
    eligibleForNextStage: Boolean(
      nextStage &&
        nextEvaluation?.passed &&
        sustained >= SUSTAINED_SNAPSHOTS_REQUIRED,
    ),
    sustain: {
      requiredSnapshots: SUSTAINED_SNAPSHOTS_REQUIRED,
      consecutivePassingSnapshots: sustained,
      satisfied: sustained >= SUSTAINED_SNAPSHOTS_REQUIRED,
    },
    regression: currentIndex > 0 && !currentEvaluation.passed,
    baseline: baselineSnapshot ? measuresFor(baselineSnapshot) : null,
    target: nextEvaluation ?? currentEvaluation,
    stages,
    findings,
  };
}

function publishMetrics(report: StageGateReport): void {
  const latest = getLatestSnapshot();
  if (!latest) return;
  for (const stage of report.stages) {
    decentralizationStageGatePassed.set({ stage: stage.stage }, stage.passed ? 1 : 0);
    for (const dimension of stage.dimensions) {
      decentralizationTop1Share.set(
        { dimension: dimension.dimension },
        dimension.measured.top1Share,
      );
      decentralizationNakamotoCoefficient.set(
        { dimension: dimension.dimension },
        dimension.measured.nakamotoCoefficient,
      );
    }
  }
}

export function recordConcentrationSnapshot(
  inputs: Record<ConcentrationDimension, WeightedEntity[]>,
  capturedAt: number = Math.floor(Date.now() / 1000),
): StageGateReport {
  const snapshot: ConcentrationSnapshot = {
    id: nextId('snap'),
    capturedAt,
    inputs: {
      provider: inputs.provider.map((entity) => ({ ...entity })),
      signer: inputs.signer.map((entity) => ({ ...entity })),
      governance: inputs.governance.map((entity) => ({ ...entity })),
      region: inputs.region.map((entity) => ({ ...entity })),
    },
  };

  for (const dimension of CONCENTRATION_DIMENSIONS) {
    computeConcentration(dimension, snapshot.inputs[dimension]);
  }

  const previousSnapshots = getSnapshots();
  if (
    previousSnapshots.length > 0 &&
    capturedAt < previousSnapshots[previousSnapshots.length - 1].capturedAt
  ) {
    throw new GovernanceReportingError(
      'OUT_OF_ORDER_SNAPSHOT',
      'Snapshot capturedAt is earlier than the latest recorded snapshot',
    );
  }

  appendSnapshot(snapshot);
  const report = buildReport(snapshot);
  publishMetrics(report);
  return report;
}

export function getStageGateReport(): StageGateReport {
  const latest = getLatestSnapshot();
  if (!latest) {
    throw new GovernanceReportingError(
      'NO_SNAPSHOT',
      'No concentration snapshot has been recorded yet',
    );
  }
  return buildReport(latest);
}

export function transitionStage(stageId: string): StageGateReport {
  const target = findStage(stageId);
  const current = findStage(getCurrentStage());
  const targetIndex = stageIndex(target.id);
  const currentIndex = stageIndex(current.id);
  const report = getStageGateReport();

  if (targetIndex > currentIndex) {
    if (targetIndex !== currentIndex + 1) {
      throw new GovernanceReportingError(
        'INVALID_STAGE_TRANSITION',
        `Stages advance one at a time; ${current.id} cannot jump to ${target.id}`,
      );
    }
    if (!report.eligibleForNextStage) {
      throw new GovernanceReportingError(
        'STAGE_GATE_NOT_MET',
        `Stage ${target.id} gates are not met for ${report.sustain.requiredSnapshots} consecutive snapshots`,
      );
    }
  }

  setCurrentStage(target.id);
  return buildReport(getLatestSnapshot()!);
}
