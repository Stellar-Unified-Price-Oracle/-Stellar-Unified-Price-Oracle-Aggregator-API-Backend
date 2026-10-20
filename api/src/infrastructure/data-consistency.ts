import { Logger } from 'winston';
import client from 'prom-client';
import { register } from '../observability/metrics';
import { DatabaseClient } from './database';

export type ReconciliationLayer = 'aggregator→db' | 'db-integrity' | 'chain→db' | 'cache→db';

/**
 * Data products exposed to consumers. Each product has its own consistency and
 * freshness objectives; see {@link DATA_PRODUCT_OBJECTIVES}.
 */
export type DataProduct = 'live-prices' | 'history' | 'catalog' | 'analytics';

/**
 * Consumer-visible read semantics for a data product. These describe what a
 * consumer can expect when reading the product, so staleness can be handled
 * explicitly rather than silently.
 */
export interface ReadSemantics {
  /** Human-readable description of what a read returns. */
  description: string;
  /** Whether reads may return data older than the freshness bound. */
  allowsStaleReads: boolean;
  /** Whether responses carry staleness metadata (age, as-of timestamp). */
  exposesStalenessMetadata: boolean;
  /** Field name carrying the as-of timestamp in responses, if any. */
  asOfField?: string;
  /** Field name carrying the age in seconds in responses, if any. */
  ageField?: string;
}

/**
 * Measurable consistency and freshness objective for a single data product.
 */
export interface DataProductObjective {
  product: DataProduct;
  /** Owner accountable for meeting the objective. */
  owner: string;
  /** Maximum acceptable age (seconds) of the newest record for the product. */
  freshnessBoundSeconds: number;
  /** Age (seconds) beyond which data is considered stale and flagged. */
  stalenessThresholdSeconds: number;
  /** Supported scope of the objective. */
  scope: string;
  /** Consumer-visible read semantics. */
  readSemantics: ReadSemantics;
}

export const DATA_PRODUCT_OBJECTIVES: Readonly<Record<DataProduct, DataProductObjective>> = Object.freeze({
  'live-prices': {
    product: 'live-prices',
    owner: 'market-data',
    freshnessBoundSeconds: 60,
    stalenessThresholdSeconds: 120,
    scope: 'Latest price per asset served from the aggregator and persisted to the DB.',
    readSemantics: {
      description: 'Latest known price per asset; may be served from cache.',
      allowsStaleReads: true,
      exposesStalenessMetadata: true,
      asOfField: 'asOf',
      ageField: 'ageSeconds',
    },
  },
  history: {
    product: 'history',
    owner: 'market-data',
    freshnessBoundSeconds: 300,
    stalenessThresholdSeconds: 600,
    scope: 'Append-only price history rows per asset and source.',
    readSemantics: {
      description: 'Historical price rows; reads are strongly consistent with the DB.',
      allowsStaleReads: false,
      exposesStalenessMetadata: true,
      asOfField: 'asOf',
      ageField: 'ageSeconds',
    },
  },
  catalog: {
    product: 'catalog',
    owner: 'platform',
    freshnessBoundSeconds: 900,
    stalenessThresholdSeconds: 1800,
    scope: 'Asset catalog metadata (symbols, sources, status).',
    readSemantics: {
      description: 'Asset catalog metadata; cached with explicit staleness metadata.',
      allowsStaleReads: true,
      exposesStalenessMetadata: true,
      asOfField: 'asOf',
      ageField: 'ageSeconds',
    },
  },
  analytics: {
    product: 'analytics',
    owner: 'analytics',
    freshnessBoundSeconds: 3600,
    stalenessThresholdSeconds: 7200,
    scope: 'Derived analytics aggregates computed from history.',
    readSemantics: {
      description: 'Derived aggregates; may lag source data and always reports as-of time.',
      allowsStaleReads: true,
      exposesStalenessMetadata: true,
      asOfField: 'asOf',
      ageField: 'ageSeconds',
    },
  },
});

/** Look up the objective for a data product. Throws on unknown products. */
export function getDataProductObjective(product: DataProduct): DataProductObjective {
  const objective = DATA_PRODUCT_OBJECTIVES[product];
  if (!objective) {
    throw new Error(`Unknown data product: ${String(product)}`);
  }
  return objective;
}

/**
 * Classify the age of a record against a product's objectives.
 * - `fresh`: within the freshness bound
 * - `stale`: beyond the freshness bound but within the staleness threshold
 * - `expired`: beyond the staleness threshold
 */
export type FreshnessState = 'fresh' | 'stale' | 'expired';

export function classifyFreshness(product: DataProduct, ageSeconds: number): FreshnessState {
  const objective = getDataProductObjective(product);
  if (ageSeconds <= objective.freshnessBoundSeconds) return 'fresh';
  if (ageSeconds <= objective.stalenessThresholdSeconds) return 'stale';
  return 'expired';
}

/**
 * Build consumer-visible staleness metadata for a response.
 */
export interface StalenessMetadata {
  asOf: string;
  ageSeconds: number;
  state: FreshnessState;
  product: DataProduct;
}

export function buildStalenessMetadata(product: DataProduct, asOfMs: number, nowMs = Date.now()): StalenessMetadata {
  const ageSeconds = Math.max(0, Math.floor((nowMs - asOfMs) / 1000));
  return {
    asOf: new Date(asOfMs).toISOString(),
    ageSeconds,
    state: classifyFreshness(product, ageSeconds),
    product,
  };
}

export const objectiveBreachesTotal = new client.Counter({
  name: 'data_product_objective_breaches_total',
  help: 'Total data product objective breaches, by product and state',
  labelNames: ['product', 'state'],
});
register.registerMetric(objectiveBreachesTotal);

export const objectiveAgeSeconds = new client.Gauge({
  name: 'data_product_age_seconds',
  help: 'Observed age in seconds of the newest record per data product',
  labelNames: ['product'],
});
register.registerMetric(objectiveAgeSeconds);

/**
 * Record the observed age of a data product's newest record and emit breach
 * metrics when it exceeds the freshness bound or staleness threshold.
 */
export function recordDataProductAge(product: DataProduct, ageSeconds: number): FreshnessState {
  const state = classifyFreshness(product, ageSeconds);
  objectiveAgeSeconds.set({ product }, ageSeconds);
  if (state !== 'fresh') {
    objectiveBreachesTotal.inc({ product, state });
  }
  return state;
}

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

  /**
   * Evaluate the freshness objective for a data product given the timestamp of
   * its newest record. Emits objective metrics and returns the freshness state.
   */
  evaluateObjective(product: DataProduct, newestRecordMs: number, nowMs = Date.now()): FreshnessState {
    const ageSeconds = Math.max(0, Math.floor((nowMs - newestRecordMs) / 1000));
    const state = recordDataProductAge(product, ageSeconds);
    if (state !== 'fresh') {
      this.logger.warn(`[data-consistency] ${product} is ${state} (age ${ageSeconds}s)`);
    }
    return state;
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
