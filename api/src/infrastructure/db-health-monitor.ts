import { Logger } from 'winston';
import client from 'prom-client';
import { register } from '../observability/metrics';
import { DatabaseClient } from './database';

export const dbHealthAlertsTotal = new client.Counter({
  name: 'db_health_alerts_total',
  help: 'Total DB health alerts fired by type',
  labelNames: ['type'],
});
register.registerMetric(dbHealthAlertsTotal);

export const dbConnectionExhaustionRatio = new client.Gauge({
  name: 'db_connection_exhaustion_ratio',
  help: 'Ratio of waiting clients to max pool size (alert at >=0.8)',
  labelNames: ['pool'],
});
register.registerMetric(dbConnectionExhaustionRatio);

export const dbProbeLatencyMs = new client.Gauge({
  name: 'db_probe_latency_ms',
  help: 'Round-trip latency of a lightweight DB liveness probe in ms',
  labelNames: ['pool'],
});
register.registerMetric(dbProbeLatencyMs);

export interface DbHealthReport {
  status: 'healthy' | 'degraded' | 'critical';
  probeLatencyMs: number;
  pools: ReturnType<DatabaseClient['getPoolStats']>;
  issues: string[];
  checkedAt: number;
}

interface DbHealthMonitorConfig {
  checkIntervalMs?: number;
  connectionExhaustionThreshold?: number;
  slowQueryThresholdMs?: number;
  replicationLagAlertMs?: number;
}

export class DbHealthMonitor {
  private timer?: NodeJS.Timeout;
  private lastReport?: DbHealthReport;
  private readonly cfg: Required<DbHealthMonitorConfig>;

  constructor(
    private readonly db: DatabaseClient,
    private readonly logger: Logger,
    cfg: DbHealthMonitorConfig = {},
  ) {
    this.cfg = {
      checkIntervalMs: cfg.checkIntervalMs ?? 15000,
      connectionExhaustionThreshold: cfg.connectionExhaustionThreshold ?? 0.8,
      slowQueryThresholdMs: cfg.slowQueryThresholdMs ?? 5000,
      replicationLagAlertMs: cfg.replicationLagAlertMs ?? 30000,
    };
  }

  start(): void {
    const check = (): void => { void this.runCheck(); };
    check();
    this.timer = setInterval(check, this.cfg.checkIntervalMs);
    this.timer.unref?.();
    this.logger.info('DB health monitor started');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runCheck(): Promise<DbHealthReport> {
    const issues: string[] = [];
    const stats = this.db.getPoolStats();
    let probeLatencyMs = -1;

    // Connection exhaustion check
    const pools = [stats.primary, ...stats.replicas];
    for (const pool of pools) {
      const ratio = pool.max > 0 ? pool.waiting / pool.max : 0;
      dbConnectionExhaustionRatio.set({ pool: pool.name }, ratio);
      if (ratio >= this.cfg.connectionExhaustionThreshold) {
        dbHealthAlertsTotal.inc({ type: 'connection_exhaustion' });
        const msg = `Pool "${pool.name}" connection exhaustion: ${pool.waiting} waiting / ${pool.max} max (${(ratio * 100).toFixed(0)}%)`;
        issues.push(msg);
        this.logger.error(`DB health alert: ${msg}`);
      }
      if (pool.circuitState === 'open') {
        dbHealthAlertsTotal.inc({ type: 'circuit_open' });
        const msg = `Pool "${pool.name}" circuit breaker is open`;
        issues.push(msg);
        this.logger.error(`DB health alert: ${msg}`);
      }
    }

    // Slow query / liveness probe
    try {
      const t0 = Date.now();
      await this.db.readQuery('SELECT 1');
      probeLatencyMs = Date.now() - t0;
      dbProbeLatencyMs.set({ pool: 'primary' }, probeLatencyMs);
      if (probeLatencyMs > this.cfg.slowQueryThresholdMs) {
        dbHealthAlertsTotal.inc({ type: 'slow_query' });
        const msg = `DB probe latency ${probeLatencyMs}ms exceeds threshold ${this.cfg.slowQueryThresholdMs}ms`;
        issues.push(msg);
        this.logger.warn(`DB health alert: ${msg}`);
      }
    } catch (err) {
      dbHealthAlertsTotal.inc({ type: 'probe_failed' });
      issues.push('DB liveness probe failed');
      this.logger.error('DB health alert: liveness probe failed', err);
    }

    // Replication lag check via pg_last_xact_replay_timestamp
    if (stats.replicas.length > 0) {
      try {
        const lagRes = await this.db.readQuery<{ lag: string | null }>(
          `SELECT EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))::float8 AS lag`,
        );
        const lagMs = Number(lagRes.rows[0]?.lag ?? 0) * 1000;
        if (lagMs > this.cfg.replicationLagAlertMs) {
          dbHealthAlertsTotal.inc({ type: 'replication_lag' });
          const msg = `Replication lag ${lagMs.toFixed(0)}ms exceeds threshold ${this.cfg.replicationLagAlertMs}ms`;
          issues.push(msg);
          this.logger.warn(`DB health alert: ${msg}`);
        }
      } catch {
        // Replica lag is best-effort
      }
    }

    const status: DbHealthReport['status'] =
      issues.some((i) => i.includes('circuit breaker') || i.includes('probe failed'))
        ? 'critical'
        : issues.length > 0
        ? 'degraded'
        : 'healthy';

    this.lastReport = { status, probeLatencyMs, pools: stats, issues, checkedAt: Date.now() };
    return this.lastReport;
  }

  getLastReport(): DbHealthReport | undefined {
    return this.lastReport;
  }
}
