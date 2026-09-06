import fs from 'fs';
import path from 'path';
import { Logger } from 'winston';
import client from 'prom-client';
import { register } from '../middleware/metrics';
import { BackupService, BackupEntry } from './backup';

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

export interface DrReadiness {
  rpo: RpoStatus;
  lastDrill: DrillResult | null;
  ready: boolean;
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

/**
 * Reports live DR readiness: how stale the newest backup is relative to the RPO
 * target, and the outcome of the most recent quarterly drill (see
 * docs/disaster-recovery/drills.md). Read-only — this service does not perform backups.
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
      refreshIntervalMs?: number;
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
    return {
      rpo,
      lastDrill,
      ready: rpo.withinTarget && (lastDrill === null || lastDrill.passed),
    };
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
