#!/usr/bin/env node
/**
 * #552 — Gate releases on SLO error-budget burn rate.
 *
 * Evaluates whether an upcoming release is permitted, blocked, or degraded based on
 * real-time SLO error budget burn rates and remaining 30-day budget.
 *
 * Usage:
 *   node scripts/slo-release-gate.js [--environment=production] [--prometheus-url=http://localhost:9090]
 *   node scripts/slo-release-gate.js --override-reason="HOTFIX incident INC-123" --override-approver="sre@stellar.org"
 *   node scripts/slo-release-gate.js --input-metrics=./test-metrics.json
 *
 * Staged release train (#735):
 *   node scripts/slo-release-gate.js --train-manifest=./release-train.json \
 *     [--train-health=./region-health.json] [--train-output=./train-result.json]
 *
 *   The manifest declares ordered regions, promotion criteria, and automatic
 *   halt conditions. The gate emits PROMOTE / HOLD / HALT, writes the full
 *   decision to --train-output (and GITHUB_OUTPUT when present) so deploy
 *   scripts can advance, wait, or roll back the train deterministically.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface SloEvaluationInput {
  canonical1hBurnRate: number;
  canonical6hBurnRate: number;
  canonical24hBurnRate: number;
  remainingBudgetPercent: number;
  canaryBurnRate?: number;
  metricsAvailable?: boolean;
}

export type GateDecision = 'PERMIT' | 'DEGRADED_PERMIT' | 'BLOCK' | 'OVERRIDDEN_PERMIT';

/**
 * #735 — Staged release train across regions.
 *
 * A release train manifest declares the ordered list of regions a release must
 * be promoted through, the promotion criteria that must hold before advancing
 * from one region to the next, and the automatic halt conditions that stop the
 * train when verified health regresses.
 */
export interface ReleaseTrainRegion {
  /** Region identifier, e.g. "us-east-1". */
  name: string;
  /** 0-based position in the promotion order (must be unique and contiguous). */
  order: number;
  /** Traffic percentage (bps of 10000) the region receives once promoted. */
  trafficBps: number;
  /** Minimum soak time in minutes before the region may be promoted further. */
  soakMinutes: number;
  /** Optional per-region override of the global promotion criteria. */
  promotionCriteria?: Partial<PromotionCriteria>;
  /** Optional per-region override of the global halt conditions. */
  haltConditions?: Partial<HaltConditions>;
}

export interface PromotionCriteria {
  /** Maximum tolerated 1h burn rate before promotion is refused. */
  max1hBurnRate: number;
  /** Maximum tolerated 6h burn rate before promotion is refused. */
  max6hBurnRate: number;
  /** Maximum tolerated 24h burn rate before promotion is refused. */
  max24hBurnRate: number;
  /** Minimum remaining 30d error budget percent required to promote. */
  minRemainingBudgetPercent: number;
  /** Minimum number of consecutive healthy evaluation windows required. */
  minConsecutiveHealthyWindows: number;
}

export interface HaltConditions {
  /** Halt the train if the 1h burn rate reaches this value in any promoted region. */
  haltOn1hBurnRate: number;
  /** Halt the train if the 6h burn rate reaches this value in any promoted region. */
  haltOn6hBurnRate: number;
  /** Halt the train if remaining budget falls at or below this percent. */
  haltOnRemainingBudgetPercent: number;
  /** Halt the train if any promoted region reports metrics unavailable. */
  haltOnMetricsUnavailable: boolean;
}

export interface ReleaseTrainManifest {
  /** Identifier of the release being promoted (e.g. git SHA or semver). */
  releaseId: string;
  /** Ordered regions the release must be promoted through. */
  regions: ReleaseTrainRegion[];
  /** Global promotion criteria applied unless overridden per region. */
  promotionCriteria: PromotionCriteria;
  /** Global halt conditions applied unless overridden per region. */
  haltConditions: HaltConditions;
}

export interface RegionHealth {
  /** Region identifier matching a manifest region. */
  name: string;
  /** Observed SLO metrics for the region. */
  metrics: SloEvaluationInput;
  /** Whether the region has already been promoted to its target traffic. */
  promoted?: boolean;
  /** Minutes the region has been soaking at its current traffic level. */
  soakMinutesElapsed?: number;
  /** Number of consecutive healthy evaluation windows observed. */
  consecutiveHealthyWindows?: number;
}

export type TrainDecision = 'PROMOTE' | 'HOLD' | 'HALT';

export interface TrainRegionStatus {
  name: string;
  order: number;
  promoted: boolean;
  eligibleForPromotion: boolean;
  reasons: string[];
}

export interface TrainGateResult {
  decision: TrainDecision;
  exitCode: number;
  releaseId: string;
  /** Region the train is currently promoting into (or the last promoted region). */
  currentRegion?: string;
  /** Region that triggered an automatic halt, if any. */
  haltedRegion?: string;
  reasons: string[];
  regions: TrainRegionStatus[];
  overrideApplied?: boolean;
  overrideReason?: string;
  overrideApprover?: string;
}

export const DEFAULT_PROMOTION_CRITERIA: PromotionCriteria = {
  max1hBurnRate: 14.4,
  max6hBurnRate: 6.0,
  max24hBurnRate: 3.0,
  minRemainingBudgetPercent: 25,
  minConsecutiveHealthyWindows: 2,
};

export const DEFAULT_HALT_CONDITIONS: HaltConditions = {
  haltOn1hBurnRate: 14.4,
  haltOn6hBurnRate: 6.0,
  haltOnRemainingBudgetPercent: 0,
  haltOnMetricsUnavailable: true,
};
=======

export interface GateResult {
  decision: GateDecision;
  exitCode: number;
  reasons: string[];
  metrics: SloEvaluationInput;
  environment: string;
  overrideApplied?: boolean;
  overrideReason?: string;
  overrideApprover?: string;
}

export function evaluateSloGate(
  input: SloEvaluationInput,
  options: {
    environment?: string;
    overrideReason?: string;
    overrideApprover?: string;
    allowMetricsUnavailable?: boolean;
  } = {},
): GateResult {
  const env = options.environment || 'production';
  const reasons: string[] = [];

  // 1. Check metrics availability
  if (input.metricsAvailable === false) {
    if (env === 'production' && !options.allowMetricsUnavailable && !options.overrideReason) {
      return {
        decision: 'BLOCK',
        exitCode: 1,
        reasons: ['Prometheus SLO metrics unavailable in production (FAIL_CLOSED policy enforced)'],
        metrics: input,
        environment: env,
      };
    } else {
      reasons.push('Prometheus SLO metrics unavailable; continuing under WARN_AND_PERMIT policy');
      return {
        decision: options.overrideReason ? 'OVERRIDDEN_PERMIT' : 'PERMIT',
        exitCode: 0,
        reasons,
        metrics: input,
        environment: env,
        overrideApplied: Boolean(options.overrideReason),
        overrideReason: options.overrideReason,
        overrideApprover: options.overrideApprover,
      };
    }
  }

  // 2. Evaluate burn rates & budget exhaustion
  let blocked = false;
  let degraded = false;

  if (input.remainingBudgetPercent <= 0) {
    blocked = true;
    reasons.push(`Monthly error budget completely exhausted (${input.remainingBudgetPercent.toFixed(1)}% remaining)`);
  }

  if (input.canonical1hBurnRate >= 14.4) {
    blocked = true;
    reasons.push(
      `Fast burn rate critical: 1h burn rate is ${input.canonical1hBurnRate.toFixed(1)}x (threshold: >= 14.4x; consuming 2% of budget/hr)`,
    );
  }

  if (input.canonical6hBurnRate >= 6.0) {
    blocked = true;
    reasons.push(
      `Fast burn rate high: 6h burn rate is ${input.canonical6hBurnRate.toFixed(1)}x (threshold: >= 6.0x; consuming 5% of budget in 6hr)`,
    );
  }

  if (input.canonical24hBurnRate >= 3.0 && !blocked) {
    degraded = true;
    reasons.push(
      `Slow burn rate elevated: 24h burn rate is ${input.canonical24hBurnRate.toFixed(1)}x (threshold: >= 3.0x; consuming 10% of budget/day)`,
    );
  }

  // Note on canary isolation:
  if (input.canaryBurnRate !== undefined && input.canaryBurnRate > 0) {
    reasons.push(
      `Canary-isolated burn rate observed at ${input.canaryBurnRate.toFixed(1)}x (isolated from canonical deployment gate)`,
    );
  }

  // 3. Handle overrides
  if (options.overrideReason) {
    const approver = options.overrideApprover || 'anonymous-operator';
    recordOverrideAudit({
      timestamp: new Date().toISOString(),
      environment: env,
      reason: options.overrideReason,
      approver,
      metrics: input,
      originalBlocked: blocked,
    });

    return {
      decision: 'OVERRIDDEN_PERMIT',
      exitCode: 0,
      reasons: [
        `EMERGENCY OVERRIDE APPLIED by ${approver}: "${options.overrideReason}"`,
        ...reasons,
      ],
      metrics: input,
      environment: env,
      overrideApplied: true,
      overrideReason: options.overrideReason,
      overrideApprover: approver,
    };
  }

  if (blocked) {
    return {
      decision: 'BLOCK',
      exitCode: 1,
      reasons,
      metrics: input,
      environment: env,
    };
  }

  if (degraded) {
    return {
      decision: 'DEGRADED_PERMIT',
      exitCode: 0,
      reasons: [
        'Release permitted ONLY as reduced-traffic canary (<= 500 bps / 5%) with auto-promotion disabled',
        ...reasons,
      ],
      metrics: input,
      environment: env,
    };
  }

  return {
    decision: 'PERMIT',
    exitCode: 0,
    reasons: ['Error budget healthy and burn rates within safe operational limits'],
    metrics: input,
    environment: env,
  };
}

/**
 * Validate a release-train manifest. Throws on structural problems so that a
 * malformed manifest fails the pipeline loudly rather than silently promoting.
 */
export function validateReleaseTrainManifest(manifest: ReleaseTrainManifest): void {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('Release train manifest must be an object');
  }
  if (!manifest.releaseId || typeof manifest.releaseId !== 'string') {
    throw new Error('Release train manifest requires a non-empty releaseId');
  }
  if (!Array.isArray(manifest.regions) || manifest.regions.length === 0) {
    throw new Error('Release train manifest requires at least one region');
  }

  const seenNames = new Set<string>();
  const seenOrders = new Set<number>();
  for (const region of manifest.regions) {
    if (!region.name || typeof region.name !== 'string') {
      throw new Error('Each release train region requires a non-empty name');
    }
    if (seenNames.has(region.name)) {
      throw new Error(`Duplicate region in release train manifest: ${region.name}`);
    }
    seenNames.add(region.name);

    if (!Number.isInteger(region.order) || region.order < 0) {
      throw new Error(`Region ${region.name} has an invalid order: ${region.order}`);
    }
    if (seenOrders.has(region.order)) {
      throw new Error(`Duplicate region order ${region.order} in release train manifest`);
    }
    seenOrders.add(region.order);

    if (typeof region.trafficBps !== 'number' || region.trafficBps < 0 || region.trafficBps > 10000) {
      throw new Error(`Region ${region.name} has an invalid trafficBps: ${region.trafficBps}`);
    }
    if (typeof region.soakMinutes !== 'number' || region.soakMinutes < 0) {
      throw new Error(`Region ${region.name} has an invalid soakMinutes: ${region.soakMinutes}`);
    }
  }

  const sortedOrders = [...seenOrders].sort((a, b) => a - b);
  for (let i = 0; i < sortedOrders.length; i++) {
    if (sortedOrders[i] !== i) {
      throw new Error('Release train region orders must be contiguous starting at 0');
    }
  }

  if (!manifest.promotionCriteria || typeof manifest.promotionCriteria !== 'object') {
    throw new Error('Release train manifest requires promotionCriteria');
  }
  if (!manifest.haltConditions || typeof manifest.haltConditions !== 'object') {
    throw new Error('Release train manifest requires haltConditions');
  }
}

function resolvePromotionCriteria(
  global: PromotionCriteria,
  override?: Partial<PromotionCriteria>,
): PromotionCriteria {
  return { ...DEFAULT_PROMOTION_CRITERIA, ...global, ...(override || {}) };
}

function resolveHaltConditions(global: HaltConditions, override?: Partial<HaltConditions>): HaltConditions {
  return { ...DEFAULT_HALT_CONDITIONS, ...global, ...(override || {}) };
}

/**
 * Evaluate a staged release train across regions.
 *
 * The train advances one region at a time in `order`. A region may only be
 * promoted when:
 *   - every previously promoted region is still healthy (no halt condition),
 *   - the region's own metrics satisfy the promotion criteria,
 *   - the region has soaked for at least `soakMinutes`, and
 *   - it has accumulated `minConsecutiveHealthyWindows` healthy windows.
 *
 * Any promoted region (or the region under evaluation) that trips a halt
 * condition immediately HALTs the whole train.
 */
export function evaluateReleaseTrain(
  manifest: ReleaseTrainManifest,
  health: RegionHealth[],
  options: {
    overrideReason?: string;
    overrideApprover?: string;
  } = {},
): TrainGateResult {
  validateReleaseTrainManifest(manifest);

  const healthByName = new Map<string, RegionHealth>();
  for (const h of health) {
    healthByName.set(h.name, h);
  }

  const orderedRegions = [...manifest.regions].sort((a, b) => a.order - b.order);
  const statuses: TrainRegionStatus[] = [];
  const reasons: string[] = [];

  let haltedRegion: string | undefined;
  let currentRegion: string | undefined;
  let allPriorPromoted = true;

  for (const region of orderedRegions) {
    const regionHealth = healthByName.get(region.name);
    const criteria = resolvePromotionCriteria(manifest.promotionCriteria, region.promotionCriteria);
    const halt = resolveHaltConditions(manifest.haltConditions, region.haltConditions);
    const regionReasons: string[] = [];

    if (!regionHealth) {
      regionReasons.push(`No health data reported for region ${region.name}`);
      statuses.push({
        name: region.name,
        order: region.order,
        promoted: false,
        eligibleForPromotion: false,
        reasons: regionReasons,
      });
      allPriorPromoted = false;
      continue;
    }

    const m = regionHealth.metrics;
    const promoted = Boolean(regionHealth.promoted);

    // --- Automatic halt conditions (evaluated for promoted regions and the
    // region currently under evaluation). ---
    let haltTriggered = false;
    if (promoted || allPriorPromoted) {
      if (halt.haltOnMetricsUnavailable && m.metricsAvailable === false) {
        haltTriggered = true;
        regionReasons.push(`HALT: metrics unavailable in region ${region.name}`);
      }
      if (m.canonical1hBurnRate >= halt.haltOn1hBurnRate) {
        haltTriggered = true;
        regionReasons.push(
          `HALT: 1h burn rate ${m.canonical1hBurnRate.toFixed(1)}x >= ${halt.haltOn1hBurnRate}x in region ${region.name}`,
        );
      }
      if (m.canonical6hBurnRate >= halt.haltOn6hBurnRate) {
        haltTriggered = true;
        regionReasons.push(
          `HALT: 6h burn rate ${m.canonical6hBurnRate.toFixed(1)}x >= ${halt.haltOn6hBurnRate}x in region ${region.name}`,
        );
      }
      if (m.remainingBudgetPercent <= halt.haltOnRemainingBudgetPercent) {
        haltTriggered = true;
        regionReasons.push(
          `HALT: remaining budget ${m.remainingBudgetPercent.toFixed(1)}% <= ${halt.haltOnRemainingBudgetPercent}% in region ${region.name}`,
        );
      }
    }

    if (haltTriggered && !haltedRegion) {
      haltedRegion = region.name;
    }

    // --- Promotion criteria (only meaningful for the next un-promoted region
    // once all prior regions are promoted). ---
    let eligible = false;
    if (!promoted && allPriorPromoted && !haltTriggered) {
      if (m.metricsAvailable === false) {
        regionReasons.push(`Cannot promote ${region.name}: metrics unavailable`);
      } else if (m.canonical1hBurnRate >= criteria.max1hBurnRate) {
        regionReasons.push(
          `Cannot promote ${region.name}: 1h burn rate ${m.canonical1hBurnRate.toFixed(1)}x >= ${criteria.max1hBurnRate}x`,
        );
      } else if (m.canonical6hBurnRate >= criteria.max6hBurnRate) {
        regionReasons.push(
          `Cannot promote ${region.name}: 6h burn rate ${m.canonical6hBurnRate.toFixed(1)}x >= ${criteria.max6hBurnRate}x`,
        );
      } else if (m.canonical24hBurnRate >= criteria.max24hBurnRate) {
        regionReasons.push(
          `Cannot promote ${region.name}: 24h burn rate ${m.canonical24hBurnRate.toFixed(1)}x >= ${criteria.max24hBurnRate}x`,
        );
      } else if (m.remainingBudgetPercent < criteria.minRemainingBudgetPercent) {
        regionReasons.push(
          `Cannot promote ${region.name}: remaining budget ${m.remainingBudgetPercent.toFixed(1)}% < ${criteria.minRemainingBudgetPercent}%`,
        );
      } else if ((regionHealth.soakMinutesElapsed ?? 0) < region.soakMinutes) {
        regionReasons.push(
          `Cannot promote ${region.name}: soaked ${regionHealth.soakMinutesElapsed ?? 0}m < required ${region.soakMinutes}m`,
        );
      } else if ((regionHealth.consecutiveHealthyWindows ?? 0) < criteria.minConsecutiveHealthyWindows) {
        regionReasons.push(
          `Cannot promote ${region.name}: ${regionHealth.consecutiveHealthyWindows ?? 0} healthy windows < required ${criteria.minConsecutiveHealthyWindows}`,
        );
      } else {
        eligible = true;
        regionReasons.push(`Region ${region.name} meets promotion criteria`);
      }
    }

    if (promoted) {
      regionReasons.push(`Region ${region.name} already promoted at ${region.trafficBps} bps`);
    }

    statuses.push({
      name: region.name,
      order: region.order,
      promoted,
      eligibleForPromotion: eligible,
      reasons: regionReasons,
    });

    if (eligible && !currentRegion) {
      currentRegion = region.name;
    }

    if (!promoted) {
      allPriorPromoted = false;
    }
  }

  // --- Override handling: an explicit, audited override permits promotion of
  // the next eligible region even when the train would otherwise HOLD/HALT. ---
  if (options.overrideReason) {
    const approver = options.overrideApprover || 'anonymous-operator';
    recordOverrideAudit({
      timestamp: new Date().toISOString(),
      kind: 'release-train',
      releaseId: manifest.releaseId,
      reason: options.overrideReason,
      approver,
      haltedRegion,
      regions: statuses.map((s) => ({ name: s.name, promoted: s.promoted, eligible: s.eligibleForPromotion })),
    });
    reasons.push(`EMERGENCY OVERRIDE APPLIED by ${approver}: "${options.overrideReason}"`);
    if (haltedRegion) {
      reasons.push(`Override bypasses automatic halt triggered by region ${haltedRegion}`);
    }
    return {
      decision: 'PROMOTE',
      exitCode: 0,
      releaseId: manifest.releaseId,
      currentRegion: currentRegion || haltedRegion,
      haltedRegion,
      reasons,
      regions: statuses,
      overrideApplied: true,
      overrideReason: options.overrideReason,
      overrideApprover: approver,
    };
  }

  if (haltedRegion) {
    reasons.push(`Automatic halt triggered by region ${haltedRegion}; release train stopped`);
    return {
      decision: 'HALT',
      exitCode: 1,
      releaseId: manifest.releaseId,
      currentRegion,
      haltedRegion,
      reasons,
      regions: statuses,
    };
  }

  if (currentRegion) {
    reasons.push(`Region ${currentRegion} is eligible for promotion`);
    return {
      decision: 'PROMOTE',
      exitCode: 0,
      releaseId: manifest.releaseId,
      currentRegion,
      reasons,
      regions: statuses,
    };
  }

  const allPromoted = statuses.every((s) => s.promoted);
  reasons.push(
    allPromoted
      ? 'All regions promoted; release train complete'
      : 'No region currently eligible for promotion; train held pending verified health',
  );
  return {
    decision: 'HOLD',
    exitCode: 0,
    releaseId: manifest.releaseId,
    reasons,
    regions: statuses,
  };
}

export function formatTrainStepSummary(result: TrainGateResult): string {
  const icon = result.decision === 'PROMOTE' ? '🚀' : result.decision === 'HALT' ? '🛑' : '⏸️';
  const regionLines = result.regions
    .map((r) => {
      const state = r.promoted ? 'promoted' : r.eligibleForPromotion ? 'eligible' : 'pending';
      return `- **${r.name}** (order ${r.order}): \`${state}\`${r.reasons.length ? ` — ${r.reasons.join('; ')}` : ''}`;
    })
    .join('\n');

  return `
## ${icon} Release Train Decision: **${result.decision}**

- **Release:** \`${result.releaseId}\`
- **Current Region:** \`${result.currentRegion ?? 'none'}\`
${result.haltedRegion ? `- **Halted Region:** \`${result.haltedRegion}\`\n` : ''}${result.overrideApplied ? `- **Override Reason:** *${result.overrideReason}* (approved by ${result.overrideApprover})\n` : ''}
### Regions
${regionLines}

### Details & Findings
${result.reasons.map((r) => `- ${r}`).join('\n')}
`;
}

function recordOverrideAudit(record: Record<string, any>): void {
  try {
    const logsDir = path.resolve(__dirname, '../logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    const auditFile = path.join(logsDir, 'slo-gate-overrides.jsonl');
    fs.appendFileSync(auditFile, JSON.stringify(record) + '\n', 'utf8');
  } catch (err) {
    console.error('Failed to write audit log:', err);
  }
}

async function queryPrometheus(baseUrl: string, expr: string): Promise<number | null> {
  const url = `${baseUrl}/api/v1/query?query=${encodeURIComponent(expr)}`;
  try {
    const res = await fetch(url);
    const json = (await res.json()) as any;
    const value = json?.data?.result?.[0]?.value?.[1];
    return value !== undefined ? parseFloat(value) : null;
  } catch {
    return null;
  }
}

export async function fetchLiveSloMetrics(prometheusUrl: string): Promise<SloEvaluationInput> {
  // Query 1h, 6h, 24h burn rates and budget consumption
  const q1h = 'sum(rate(http_requests_total{job="stellar-api",status_code=~"5.."}[1h])) / sum(rate(http_requests_total{job="stellar-api"}[1h])) / 0.001';
  const q6h = 'sum(rate(http_requests_total{job="stellar-api",status_code=~"5.."}[6h])) / sum(rate(http_requests_total{job="stellar-api"}[6h])) / 0.001';
  const q24h = 'sum(rate(http_requests_total{job="stellar-api",status_code=~"5.."}[24h])) / sum(rate(http_requests_total{job="stellar-api"}[24h])) / 0.001';
  const qBudget = '100 - (sum_over_time(rate(http_requests_total{job="stellar-api",status_code=~"5.."}[30d])[30d:1h]) / 0.001 * 100)';

  const [b1, b6, b24, budget] = await Promise.all([
    queryPrometheus(prometheusUrl, q1h),
    queryPrometheus(prometheusUrl, q6h),
    queryPrometheus(prometheusUrl, q24h),
    queryPrometheus(prometheusUrl, qBudget),
  ]);

  if (b1 === null && b6 === null && budget === null) {
    return {
      canonical1hBurnRate: 0,
      canonical6hBurnRate: 0,
      canonical24hBurnRate: 0,
      remainingBudgetPercent: 100,
      metricsAvailable: false,
    };
  }

  return {
    canonical1hBurnRate: b1 ?? 0,
    canonical6hBurnRate: b6 ?? 0,
    canonical24hBurnRate: b24 ?? 0,
    remainingBudgetPercent: budget ?? 100,
    metricsAvailable: true,
  };
}

export function formatGithubStepSummary(result: GateResult): string {
  const icon =
    result.decision === 'PERMIT'
      ? '✅'
      : result.decision === 'DEGRADED_PERMIT'
      ? '⚠️'
      : result.decision === 'OVERRIDDEN_PERMIT'
      ? '🚨'
      : '❌';

  return `
## ${icon} SLO Error-Budget Release Gate Decision: **${result.decision}**

- **Target Environment:** \`${result.environment}\`
- **Remaining 30d Budget:** \`${result.metrics.remainingBudgetPercent.toFixed(1)}%\`
- **1h Burn Rate:** \`${result.metrics.canonical1hBurnRate.toFixed(2)}x\`
- **6h Burn Rate:** \`${result.metrics.canonical6hBurnRate.toFixed(2)}x\`
- **24h Burn Rate:** \`${result.metrics.canonical24hBurnRate.toFixed(2)}x\`
${result.overrideApplied ? `- **Override Reason:** *${result.overrideReason}* (approved by ${result.overrideApprover})\n` : ''}
### Details & Findings
${result.reasons.map((r) => `- ${r}`).join('\n')}
`;
}

async function runCli(): Promise<void> {
  const args = process.argv.slice(2);
  const getArg = (flag: string) => {
    const found = args.find((a) => a.startsWith(`--${flag}=`));
    return found ? found.split('=').slice(1).join('=') : undefined;
  };
  const hasFlag = (flag: string) => args.includes(`--${flag}`);

  const environment = getArg('environment') || process.env.DEPLOY_ENV || 'production';
  const prometheusUrl = getArg('prometheus-url') || process.env.PROMETHEUS_URL || 'http://localhost:9090';
  const overrideReason = getArg('override-reason') || process.env.SLO_OVERRIDE_REASON;
  const overrideApprover = getArg('override-approver') || process.env.SLO_OVERRIDE_APPROVER;
  const inputFile = getArg('input-metrics');
  const allowMetricsUnavailable = hasFlag('allow-metrics-unavailable') || process.env.SLO_ALLOW_METRICS_DOWN === 'true';
  const trainManifestFile = getArg('train-manifest');
  const trainHealthFile = getArg('train-health');
  const trainOutputFile = getArg('train-output');

  // --- Staged release train mode (#735) ---
  if (trainManifestFile) {
    let manifest: ReleaseTrainManifest;
    let health: RegionHealth[];
    try {
      manifest = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), trainManifestFile), 'utf8'));
      if (trainHealthFile) {
        health = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), trainHealthFile), 'utf8'));
      } else {
        // Fall back to live metrics for every region in the manifest.
        health = await Promise.all(
          manifest.regions.map(async (region) => ({
            name: region.name,
            metrics: await fetchLiveSloMetrics(prometheusUrl),
          })),
        );
      }
    } catch (err) {
      console.error('Failed to load release train inputs:', err);
      process.exit(1);
    }

    const trainResult = evaluateReleaseTrain(manifest, health, { overrideReason, overrideApprover });
    const trainSummary = formatTrainStepSummary(trainResult);
    console.log(trainSummary);

    if (process.env.GITHUB_STEP_SUMMARY) {
      try {
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, trainSummary, 'utf8');
      } catch (err) {
        console.error('Could not write to GITHUB_STEP_SUMMARY:', err);
      }
    }

    // Expose the decision for deploy scripts.
    if (trainOutputFile) {
      try {
        fs.writeFileSync(path.resolve(process.cwd(), trainOutputFile), JSON.stringify(trainResult, null, 2), 'utf8');
      } catch (err) {
        console.error('Could not write train output file:', err);
      }
    }
    if (process.env.GITHUB_OUTPUT) {
      try {
        fs.appendFileSync(
          process.env.GITHUB_OUTPUT,
          `train_decision=${trainResult.decision}\n` +
            `train_current_region=${trainResult.currentRegion ?? ''}\n` +
            `train_halted_region=${trainResult.haltedRegion ?? ''}\n`,
          'utf8',
        );
      } catch (err) {
        console.error('Could not write to GITHUB_OUTPUT:', err);
      }
    }

    if (trainResult.exitCode !== 0) {
      console.error(`\n[RELEASE TRAIN HALTED]: ${trainResult.reasons.join('; ')}`);
    }
    process.exit(trainResult.exitCode);
  }

  let metrics: SloEvaluationInput;

  if (inputFile) {
    const raw = fs.readFileSync(path.resolve(process.cwd(), inputFile), 'utf8');
    metrics = JSON.parse(raw);
  } else {
    metrics = await fetchLiveSloMetrics(prometheusUrl);
  }

  const result = evaluateSloGate(metrics, {
    environment,
    overrideReason,
    overrideApprover,
    allowMetricsUnavailable,
  });

  const summary = formatGithubStepSummary(result);
  console.log(summary);

  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary, 'utf8');
    } catch (err) {
      console.error('Could not write to GITHUB_STEP_SUMMARY:', err);
    }
  }

  if (result.exitCode !== 0) {
    console.error(`\n[SLO GATE BLOCKED]: Release halted due to error-budget burn rate.`);
  }

  process.exit(result.exitCode);
}

// Run CLI if invoked directly
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runCli().catch((err) => {
    console.error('Fatal error in SLO release gate:', err);
    process.exit(1);
  });
}
