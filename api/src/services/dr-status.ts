import fs from 'fs';
import path from 'path';
import { Logger } from 'winston';
import client from 'prom-client';
import { register } from '../observability/metrics';
import { BackupService, BackupEntry } from '../infrastructure/backup';

export const drRpoSeconds = new client.Gauge({
  name: 'dr_rpo_seconds',
  help: 'Age in seconds of the most recent backup (actual RPO if a disaster happened now)',
});
register.registerMetric(drRpoSeconds);

export const drRpoTargetSeconds = new client.Gauge({
  name: 'dr_rpo_target_seconds',
  help: 'Configured RPO target in seconds',
});
register.registerMetric(drRpoTargetSeconds);

export const drLastDrillRtoSeconds = new client.Gauge({
  name: 'dr_last_drill_rto_seconds',
  help: 'RTO measured (in seconds) during the most recent DR drill',
});
register.registerMetric(drLastDrillRtoSeconds);

export const drLastExerciseRtoSeconds = new client.Gauge({
  name: 'dr_last_exercise_rto_seconds',
  help: 'RTO measured (in seconds) during the most recent dependency-failure exercise, per dependency',
  labelNames: ['dependency'],
});
register.registerMetric(drLastExerciseRtoSeconds);

export const drLastExercisePassed = new client.Gauge({
  name: 'dr_last_exercise_passed',
  help: 'Whether the most recent dependency-failure exercise passed (1) or failed (0), per dependency',
  labelNames: ['dependency'],
});
register.registerMetric(drLastExercisePassed);

export const drLastExerciseTimestampSeconds = new client.Gauge({
  name: 'dr_last_exercise_timestamp_seconds',
  help: 'Unix timestamp (seconds) of the most recent dependency-failure exercise, per dependency',
  labelNames: ['dependency'],
});
register.registerMetric(drLastExerciseTimestampSeconds);

export const drLastFailbackPassed = new client.Gauge({
  name: 'dr_last_failback_passed',
  help: 'Whether the most recent regional failback drill passed (1) or failed (0)',
});
register.registerMetric(drLastFailbackPassed);

export const drLastFailbackDurationSeconds = new client.Gauge({
  name: 'dr_last_failback_duration_seconds',
  help: 'Duration (in seconds) of the most recent regional failback drill',
});
register.registerMetric(drLastFailbackDurationSeconds);

export const drLastFailbackTimestampSeconds = new client.Gauge({
  name: 'dr_last_failback_timestamp_seconds',
  help: 'Unix timestamp (seconds) of the most recent regional failback drill',
});
register.registerMetric(drLastFailbackTimestampSeconds);

/** Dependencies covered by scheduled failure exercises (see docs/disaster-recovery/exercises.md). */
export const DEPENDENCY_KINDS = ['database', 'cache', 'provider', 'network'] as const;
export type DependencyKind = (typeof DEPENDENCY_KINDS)[number];

export const FAILBACK_OUTCOMES = ['passed', 'failed', 'aborted'] as const;
export type FailbackOutcome = (typeof FAILBACK_OUTCOMES)[number];

export interface RpoStatus {
  lastBackupAt: string | null;
  ageSeconds: number | null;
  targetSeconds: number;
  withinTarget: boolean;
  backupCount: number;
}

export interface DrillResult {
  date: string;
  environment: string;
  tier: 'tier1-pitr' | 'tier2-full';
  rtoSeconds: number;
  rpoSeconds: number;
  rtoTargetSeconds: number;
  rpoTargetSeconds: number;
  passed: boolean;
  report?: string;
}

export interface DependencyExerciseResult {
  date: string;
  dependency: DependencyKind;
  environment: string;
  /** Time to detect the injected failure and begin recovery, in seconds. */
  detectionSeconds: number;
  /** Time to full recovery of the dependency, in seconds. */
  rtoSeconds: number;
  rtoTargetSeconds: number;
  /** Observed error-rate increase during the exercise, in percentage points. */
  errorRateDeltaPct: number;
  errorRateDeltaTargetPct: number;
  /** Free-form pointer to recovery evidence (dashboard, log query, ticket). */
  recoveryEvidence: string;
  passed: boolean;
  report?: string;
}

export interface FailbackDrillResult {
  date: string;
  environment: string;
  fromRegion: string;
  toRegion: string;
  /** Seconds spent waiting for stability evidence before failback began. */
  stabilityWaitSeconds: number;
  /** Total duration of the failback procedure, in seconds. */
  durationSeconds: number;
  durationTargetSeconds: number;
  /** Whether state reconciliation completed without divergence. */
  stateReconciled: boolean;
  /** Whether traffic and publishing authority were transferred without split brain. */
  splitBrainDetected: boolean;
  outcome: FailbackOutcome;
  report?: string;
}

export interface DrReadiness {
  rpo: RpoStatus;
  lastDrill: DrillResult | null;
  lastExercises: DependencyExerciseResult[];
  lastFailback: FailbackDrillResult | null;
  ready: boolean;
  feeds: FeedHealthReport;
}

export interface FeedLagSample {
  feed: string;
  region: string;
  /** Age in seconds of the newest replicated sequence for this feed/region. */
  lagSeconds: number;
  /** Highest contiguous sequence number observed for this feed/region. */
  lastSequence: number | null;
  /** Sequence numbers observed but not yet contiguous (gaps). */
  missingSequences: number[];
}

export interface FeedHealthThresholds {
  /** Max acceptable lag in seconds before a feed is considered degraded. */
  lagSeconds: number;
  /** Max acceptable number of missing sequences before a feed is unhealthy. */
  missingSequences: number;
}

export interface FeedHealth {
  feed: string;
  region: string;
  lagSeconds: number;
  lastSequence: number | null;
  missingSequences: number[];
  healthy: boolean;
  reasons: string[];
}

export interface FeedHealthReport {
  generatedAt: string;
  thresholds: FeedHealthThresholds;
  feeds: FeedHealth[];
  /** Feeds that are unhealthy and should be routed away from. */
  unhealthyFeeds: string[];
  /** True when every observed feed is healthy. */
  allHealthy: boolean;
}

export const DEFAULT_FEED_THRESHOLDS: FeedHealthThresholds = {
  lagSeconds: 60,
  missingSequences: 0,
};

/** Pure: detect gaps in a set of observed sequence numbers. No IO. */
export function detectMissingSequences(sequences: number[]): number[] {
  const unique = Array.from(new Set(sequences.filter((s) => Number.isFinite(s)))).sort(
    (a, b) => a - b,
  );
  if (unique.length < 2) return [];
  const missing: number[] = [];
  for (let i = 1; i < unique.length; i++) {
    const prev = unique[i - 1];
    const curr = unique[i];
    for (let s = prev + 1; s < curr; s++) missing.push(s);
  }
  return missing;
}

/** Pure: evaluate a single feed sample against thresholds. No IO. */
export function evaluateFeedHealth(
  sample: FeedLagSample,
  thresholds: FeedHealthThresholds = DEFAULT_FEED_THRESHOLDS,
): FeedHealth {
  const reasons: string[] = [];
  const lagSeconds = Math.max(0, sample.lagSeconds);
  if (lagSeconds > thresholds.lagSeconds) {
    reasons.push(`lag ${lagSeconds}s exceeds ${thresholds.lagSeconds}s`);
  }
  const missingSequences = sample.missingSequences ?? [];
  if (missingSequences.length > thresholds.missingSequences) {
    reasons.push(
      `${missingSequences.length} missing sequences exceeds ${thresholds.missingSequences}`,
    );
  }
  return {
    feed: sample.feed,
    region: sample.region,
    lagSeconds,
    lastSequence: sample.lastSequence,
    missingSequences,
    healthy: reasons.length === 0,
    reasons,
  };
}

/** Pure: build a full feed health report from samples. No IO. */
export function computeFeedHealthReport(
  samples: FeedLagSample[],
  thresholds: FeedHealthThresholds = DEFAULT_FEED_THRESHOLDS,
  now: Date = new Date(),
): FeedHealthReport {
  const feeds = samples.map((s) => evaluateFeedHealth(s, thresholds));
  const unhealthyFeeds = Array.from(
    new Set(feeds.filter((f) => !f.healthy).map((f) => f.feed)),
  ).sort();
  return {
    generatedAt: now.toISOString(),
    thresholds,
    feeds,
    unhealthyFeeds,
    allHealthy: unhealthyFeeds.length === 0,
  };
}

/** Pure: derive RPO status from a list of backup timestamps. No IO. */
export function computeRpoStatus(
  backups: Pick<BackupEntry, 'createdAt'>[],
  targetSeconds: number,
  now: Date = new Date(),
): RpoStatus {
  if (backups.length === 0) {
    return {
      lastBackupAt: null,
      ageSeconds: null,
      targetSeconds,
      withinTarget: false,
      backupCount: 0,
    };
  }
  const latest = backups.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
  const ageSeconds = Math.max(0, (now.getTime() - latest.createdAt.getTime()) / 1000);
  return {
    lastBackupAt: latest.createdAt.toISOString(),
    ageSeconds,
    targetSeconds,
    withinTarget: ageSeconds <= targetSeconds,
    backupCount: backups.length,
  };
}

/** Pure: validate/narrow a parsed drill report JSON blob. */
export function parseDrillResult(raw: unknown): DrillResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.date !== 'string' ||
    typeof r.environment !== 'string' ||
    (r.tier !== 'tier1-pitr' && r.tier !== 'tier2-full') ||
    typeof r.rtoSeconds !== 'number' ||
    typeof r.rpoSeconds !== 'number' ||
    typeof r.rtoTargetSeconds !== 'number' ||
    typeof r.rpoTargetSeconds !== 'number' ||
    typeof r.passed !== 'boolean'
  ) {
    return null;
  }
  return {
    date: r.date,
    environment: r.environment,
    tier: r.tier,
    rtoSeconds: r.rtoSeconds,
    rpoSeconds: r.rpoSeconds,
    rtoTargetSeconds: r.rtoTargetSeconds,
    rpoTargetSeconds: r.rpoTargetSeconds,
    passed: r.passed,
    report: typeof r.report === 'string' ? r.report : undefined,
  };
}

function isDependencyKind(v: unknown): v is DependencyKind {
  return typeof v === 'string' && (DEPENDENCY_KINDS as readonly string[]).includes(v);
}

function isFailbackOutcome(v: unknown): v is FailbackOutcome {
  return typeof v === 'string' && (FAILBACK_OUTCOMES as readonly string[]).includes(v);
}

/**
 * Pure: validate/narrow a parsed dependency-failure exercise report JSON blob.
 * Returns null for malformed input; boundary values (zero durations, exact
 * target equality) are accepted and left to the caller to interpret.
 */
export function parseDependencyExerciseResult(raw: unknown): DependencyExerciseResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.date !== 'string' ||
    !isDependencyKind(r.dependency) ||
    typeof r.environment !== 'string' ||
    typeof r.detectionSeconds !== 'number' ||
    typeof r.rtoSeconds !== 'number' ||
    typeof r.rtoTargetSeconds !== 'number' ||
    typeof r.errorRateDeltaPct !== 'number' ||
    typeof r.errorRateDeltaTargetPct !== 'number' ||
    typeof r.recoveryEvidence !== 'string' ||
    r.recoveryEvidence.trim() === '' ||
    typeof r.passed !== 'boolean'
  ) {
    return null;
  }
  if (
    !Number.isFinite(r.detectionSeconds) ||
    !Number.isFinite(r.rtoSeconds) ||
    !Number.isFinite(r.rtoTargetSeconds) ||
    !Number.isFinite(r.errorRateDeltaPct) ||
    !Number.isFinite(r.errorRateDeltaTargetPct) ||
    r.detectionSeconds < 0 ||
    r.rtoSeconds < 0 ||
    r.rtoTargetSeconds < 0 ||
    r.errorRateDeltaTargetPct < 0
  ) {
    return null;
  }
  return {
    date: r.date,
    dependency: r.dependency,
    environment: r.environment,
    detectionSeconds: r.detectionSeconds,
    rtoSeconds: r.rtoSeconds,
    rtoTargetSeconds: r.rtoTargetSeconds,
    errorRateDeltaPct: r.errorRateDeltaPct,
    errorRateDeltaTargetPct: r.errorRateDeltaTargetPct,
    recoveryEvidence: r.recoveryEvidence,
    passed: r.passed,
    report: typeof r.report === 'string' ? r.report : undefined,
  };
}

/**
 * Pure: validate/narrow a parsed regional failback drill report JSON blob.
 * A drill is only considered passing when the outcome is 'passed', state was
 * reconciled, and no split brain was detected.
 */
export function parseFailbackDrillResult(raw: unknown): FailbackDrillResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.date !== 'string' ||
    typeof r.environment !== 'string' ||
    typeof r.fromRegion !== 'string' ||
    typeof r.toRegion !== 'string' ||
    typeof r.stabilityWaitSeconds !== 'number' ||
    typeof r.durationSeconds !== 'number' ||
    typeof r.durationTargetSeconds !== 'number' ||
    typeof r.stateReconciled !== 'boolean' ||
    typeof r.splitBrainDetected !== 'boolean' ||
    !isFailbackOutcome(r.outcome)
  ) {
    return null;
  }
  if (
    !Number.isFinite(r.stabilityWaitSeconds) ||
    !Number.isFinite(r.durationSeconds) ||
    !Number.isFinite(r.durationTargetSeconds) ||
    r.stabilityWaitSeconds < 0 ||
    r.durationSeconds < 0 ||
    r.durationTargetSeconds < 0
  ) {
    return null;
  }
  return {
    date: r.date,
    environment: r.environment,
    fromRegion: r.fromRegion,
    toRegion: r.toRegion,
    stabilityWaitSeconds: r.stabilityWaitSeconds,
    durationSeconds: r.durationSeconds,
    durationTargetSeconds: r.durationTargetSeconds,
    stateReconciled: r.stateReconciled,
    splitBrainDetected: r.splitBrainDetected,
    outcome: r.outcome,
    report: typeof r.report === 'string' ? r.report : undefined,
  };
}

/** Pure: a failback drill only counts as passing when it is safe and in budget. */
export function isFailbackDrillPassing(result: FailbackDrillResult): boolean {
  return (
    result.outcome === 'passed' &&
    result.stateReconciled &&
    !result.splitBrainDetected &&
    result.durationSeconds <= result.durationTargetSeconds
  );
}

/**
 * Pure: pick the most recent exercise per dependency from a list of results.
 * Ties on date are broken by list order (later entries win).
 */
export function latestExercisePerDependency(
  results: DependencyExerciseResult[],
): DependencyExerciseResult[] {
  const byDependency = new Map<DependencyKind, DependencyExerciseResult>();
  for (const result of results) {
    const existing = byDependency.get(result.dependency);
    if (!existing || result.date >= existing.date) {
      byDependency.set(result.dependency, result);
    }
  }
  return DEPENDENCY_KINDS.flatMap((kind) => {
    const found = byDependency.get(kind);
    return found ? [found] : [];
  });
}

/**
 * Reports live DR readiness: how stale the newest backup is relative to the RPO
 * target, the outcome of the most recent quarterly drill (see
 * docs/disaster-recovery/drills.md), the latest dependency-failure exercise per
 * dependency (see docs/disaster-recovery/exercises.md), and the most recent
 * regional failback drill (see docs/disaster-recovery/failback.md). Read-only —
 * this service does not perform backups, exercises, or failbacks.
 */
export class DrStatusService {
  private refreshTimer?: NodeJS.Timeout;

  constructor(
    private readonly databaseUrl: string,
    private readonly logger: Logger,
    private readonly options: {
      backupDir?: string;
      rpoTargetSeconds?: number;
      drillReportPath?: string;
      exerciseReportPath?: string;
      failbackReportPath?: string;
      refreshIntervalMs?: number;
      feedThresholds?: FeedHealthThresholds;
      /** Optional provider of per-feed replication samples (e.g. from replication monitors). */
      feedSampleProvider?: () => FeedLagSample[];
    } = {},
  ) {}

  start(): void {
    const intervalMs = this.options.refreshIntervalMs ?? 60_000;
    const tick = () => {
      try {
        const status = this.getStatus();
        if (status.rpo.ageSeconds !== null) drRpoSeconds.set(status.rpo.ageSeconds);
        drRpoTargetSeconds.set(status.rpo.targetSeconds);
        if (status.lastDrill) drLastDrillRtoSeconds.set(status.lastDrill.rtoSeconds);
        for (const exercise of status.lastExercises) {
          drLastExerciseRtoSeconds.set({ dependency: exercise.dependency }, exercise.rtoSeconds);
          drLastExercisePassed.set({ dependency: exercise.dependency }, exercise.passed ? 1 : 0);
          const ts = Date.parse(exercise.date);
          if (!Number.isNaN(ts)) {
            drLastExerciseTimestampSeconds.set({ dependency: exercise.dependency }, ts / 1000);
          }
        }
        if (status.lastFailback) {
          drLastFailbackPassed.set(isFailbackDrillPassing(status.lastFailback) ? 1 : 0);
          drLastFailbackDurationSeconds.set(status.lastFailback.durationSeconds);
          const ts = Date.parse(status.lastFailback.date);
          if (!Number.isNaN(ts)) drLastFailbackTimestampSeconds.set(ts / 1000);
        }
      } catch (err) {
        this.logger.warn('DR status refresh failed', err);
      }
    };
    tick();
    this.refreshTimer = setInterval(tick, intervalMs);
    this.refreshTimer.unref?.();
  }

  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }

  getStatus(): DrReadiness {
    const svc = new BackupService(this.databaseUrl, this.logger, {
      backupDir: this.options.backupDir,
    });
    const rpo = computeRpoStatus(svc.listBackups(), this.options.rpoTargetSeconds ?? 300);
    const lastDrill = this.readLastDrill();
    const lastExercises = this.readExercises();
    const lastFailback = this.readLastFailback();
    const exercisesHealthy = lastExercises.every((e) => e.passed);
    const failbackHealthy = lastFailback === null || isFailbackDrillPassing(lastFailback);
    return {
      rpo,
      lastDrill,
      lastExercises,
      lastFailback,
      ready:
        rpo.withinTarget &&
        (lastDrill === null || lastDrill.passed) &&
        exercisesHealthy &&
        failbackHealthy,
    };
  }

  private readExercises(): DependencyExerciseResult[] {
    const reportPath = this.options.exerciseReportPath
      ?? path.resolve(process.cwd(), '../docs/disaster-recovery/reports/exercises-latest.json');
    try {
      if (!fs.existsSync(reportPath)) return [];
      const raw = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      const entries = Array.isArray(raw) ? raw : (raw as Record<string, unknown>)?.exercises;
      if (!Array.isArray(entries)) return [];
      const parsed = entries
        .map(parseDependencyExerciseResult)
        .filter((r): r is DependencyExerciseResult => r !== null);
      return latestExercisePerDependency(parsed);
    } catch (err) {
      this.logger.warn(`Failed to read DR exercise report at ${reportPath}`, err);
      return [];
    }
  }

  private readLastFailback(): FailbackDrillResult | null {
    const reportPath = this.options.failbackReportPath
      ?? path.resolve(process.cwd(), '../docs/disaster-recovery/reports/failback-latest.json');
    try {
      if (!fs.existsSync(reportPath)) return null;
      const raw = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      return parseFailbackDrillResult(raw);
    } catch (err) {
      this.logger.warn(`Failed to read DR failback report at ${reportPath}`, err);
      return null;
    }
  }

  private readLastDrill(): DrillResult | null {
    const reportPath = this.options.drillReportPath
      ?? path.resolve(process.cwd(), '../docs/disaster-recovery/reports/latest.json');
    try {
      if (!fs.existsSync(reportPath)) return null;
      const raw = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      return parseDrillResult(raw);
    } catch (err) {
      this.logger.warn(`Failed to read DR drill report at ${reportPath}`, err);
      return null;
    }
  }
}
