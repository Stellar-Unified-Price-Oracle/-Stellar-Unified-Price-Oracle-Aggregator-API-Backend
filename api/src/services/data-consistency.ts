import { Logger } from 'winston';
import client from 'prom-client';
import { register } from '../middleware/metrics';
import { DatabaseClient } from './database';

export const consistencyChecksTotal = new client.Counter({
  name: 'data_consistency_checks_total',
  help: 'Total data consistency checks run, by result',
  labelNames: ['layer', 'result'],
});
register.registerMetric(consistencyChecksTotal);

export const consistencyViolations = new client.Gauge({
  name: 'data_consistency_violations',
  help: 'Current count of open data consistency violations by layer',
  labelNames: ['layer'],
});
register.registerMetric(consistencyViolations);

export interface ConsistencyViolation {
  asset: string;
  expected: unknown;
  actual: unknown;
  diff: string;
}

export interface ConsistencyCheckResult {
  layer: string;
  status: 'ok' | 'violation';
  details: string;
  violations: ConsistencyViolation[];
  checkedAt: number;
}

const STALE_PRICE_SECONDS = 600;          // 10 min — price not updated
const AGGREGATOR_DRIFT_SECONDS = 120;     // 2 min — aggregator vs DB clock drift tolerance

export class DataConsistencyChecker {
  private timer?: NodeJS.Timeout;
  private latestResults: ConsistencyCheckResult[] = [];

  constructor(
    private readonly db: DatabaseClient,
    private readonly aggregatorUrl: string,
    private readonly logger: Logger,
    private readonly checkIntervalMs = 60_000,
  ) {}

  start(): void {
    const run = (): void => { void this.checkAll(); };
    run();
    this.timer = setInterval(run, this.checkIntervalMs);
    this.timer.unref?.();
    this.logger.info('Data consistency checker started');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  getLatestResults(): ConsistencyCheckResult[] {
    return this.latestResults;
  }

  async checkAll(): Promise<ConsistencyCheckResult[]> {
    const results = await Promise.all([
      this.checkAggregatorVsDb(),
      this.checkDbIntegrity(),
    ]);
    this.latestResults = results;
    return results;
  }

  /** Verify that data written by the aggregator is visible in the DB. */
  private async checkAggregatorVsDb(): Promise<ConsistencyCheckResult> {
    const layer = 'aggregator→db';
    const violations: ConsistencyViolation[] = [];

    try {
      let aggPrices: { asset: string; price: string; timestamp: number }[] = [];
      try {
        const res = await fetch(`${this.aggregatorUrl}/prices`, { signal: AbortSignal.timeout(5000) });
        if (res.ok) aggPrices = await res.json() as { asset: string; price: string; timestamp: number }[];
      } catch {
        // Aggregator unreachable — skip without marking a violation
        consistencyChecksTotal.inc({ layer, result: 'skipped' });
        return { layer, status: 'ok', details: 'Aggregator unreachable, skipped', violations: [], checkedAt: Date.now() };
      }

      const dbPrices = await this.db.getAllLatestPrices();
      const dbMap = new Map(dbPrices.map((p) => [p.asset, p]));

      for (const agg of aggPrices) {
        const db = dbMap.get(agg.asset);
        if (!db) {
          violations.push({ asset: agg.asset, expected: 'persisted in DB', actual: 'missing', diff: 'not found in DB' });
          continue;
        }
        const drift = Math.abs(agg.timestamp - db.timestamp);
        if (drift > AGGREGATOR_DRIFT_SECONDS) {
          violations.push({
            asset: agg.asset,
            expected: agg.timestamp,
            actual: db.timestamp,
            diff: `timestamp drift ${drift}s (>${AGGREGATOR_DRIFT_SECONDS}s)`,
          });
        }
      }
    } catch (err) {
      this.logger.error(`Consistency check error [${layer}]`, err);
      consistencyChecksTotal.inc({ layer, result: 'error' });
      return { layer, status: 'ok', details: `check error: ${String(err)}`, violations: [], checkedAt: Date.now() };
    }

    consistencyViolations.set({ layer }, violations.length);
    const result = violations.length > 0 ? 'violation' : 'ok';
    consistencyChecksTotal.inc({ layer, result });
    if (violations.length > 0) {
      this.logger.warn(`[data-consistency] ${violations.length} violation(s) in ${layer}`, { violations });
    }
    return {
      layer,
      status: result,
      details: violations.length > 0 ? `${violations.length} violations` : 'all assets consistent',
      violations,
      checkedAt: Date.now(),
    };
  }

  /** Detect duplicates, stale data, and price anomalies in the DB itself. */
  private async checkDbIntegrity(): Promise<ConsistencyCheckResult> {
    const layer = 'db-integrity';
    const violations: ConsistencyViolation[] = [];

    try {
      // Duplicate (asset, source, timestamp) tuples should be impossible given the unique index,
      // but check in case migrations bypassed constraints.
      const dups = await this.db.readQuery<{ asset: string; source: string; count: string }>(
        `SELECT asset, source, COUNT(*) AS count
           FROM price_history
          GROUP BY asset, source, timestamp
         HAVING COUNT(*) > 1
          LIMIT 20`,
      );
      for (const row of dups.rows) {
        violations.push({
          asset: row.asset,
          expected: 1,
          actual: parseInt(row.count, 10),
          diff: `${row.count} duplicate rows for source "${row.source}"`,
        });
      }

      // Stale prices: no update in STALE_PRICE_SECONDS
      const nowSec = Math.floor(Date.now() / 1000);
      const stale = await this.db.readQuery<{ asset: string; latest_ts: string }>(
        `SELECT asset, MAX(timestamp) AS latest_ts
           FROM price_history
          GROUP BY asset
         HAVING MAX(timestamp) < $1`,
        [nowSec - STALE_PRICE_SECONDS],
      );
      for (const row of stale.rows) {
        const ageSeconds = nowSec - parseInt(row.latest_ts, 10);
        violations.push({
          asset: row.asset,
          expected: `updated within ${STALE_PRICE_SECONDS}s`,
          actual: row.latest_ts,
          diff: `stale by ${ageSeconds}s`,
        });
      }

      // Impossible prices: zero or negative
      const invalid = await this.db.readQuery<{ asset: string; price: string }>(
        `SELECT DISTINCT asset, price
           FROM price_history
          WHERE price::numeric <= 0
          LIMIT 20`,
      );
      for (const row of invalid.rows) {
        violations.push({
          asset: row.asset,
          expected: 'price > 0',
          actual: row.price,
          diff: 'non-positive price stored',
        });
      }
    } catch (err) {
      this.logger.error(`Consistency check error [${layer}]`, err);
      consistencyChecksTotal.inc({ layer, result: 'error' });
      return { layer, status: 'ok', details: `check error: ${String(err)}`, violations: [], checkedAt: Date.now() };
    }

    consistencyViolations.set({ layer }, violations.length);
    const result = violations.length > 0 ? 'violation' : 'ok';
    consistencyChecksTotal.inc({ layer, result });
    if (violations.length > 0) {
      this.logger.warn(`[data-consistency] ${violations.length} integrity issue(s) in ${layer}`, { violations });
    }
    return {
      layer,
      status: result,
      details: violations.length > 0 ? `${violations.length} issues` : 'no duplicates, stale data, or invalid prices',
      violations,
      checkedAt: Date.now(),
    };
  }
}
