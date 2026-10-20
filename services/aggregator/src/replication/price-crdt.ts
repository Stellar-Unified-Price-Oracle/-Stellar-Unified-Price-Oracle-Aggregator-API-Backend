import { AggregatedPrice } from '../infrastructure/types';

/**
 * Per-feed health signal consumed by the router (issue #740).
 * `freshnessMs` is the age of the most recent accepted update for the feed;
 * `integrity` is a 0..1 score (1 = fully verified, 0 = failed validation).
 */
export interface FeedHealthSignal {
  region: string;
  asset: string;
  freshnessMs: number;
  integrity: number;
  /** Optional explicit region priority; lower value wins. Defaults to 0. */
  regionPriority?: number;
}

export interface FeedRouterConfig {
  /** A feed is considered stale when freshnessMs exceeds this threshold. */
  maxFreshnessMs: number;
  /** A feed is considered corrupt when integrity falls below this threshold. */
  minIntegrity: number;
}

export interface FeedRouteDecision {
  asset: string;
  selectedRegion: string | null;
  reason: 'selected' | 'failover' | 'no_healthy_feed';
  candidates: FeedHealthSignal[];
  decidedAt: number;
}

export interface FeedRouteMetrics {
  feed_route_decisions_total: number;
  feed_route_failovers_total: number;
}

export type FeedRouteLogger = (decision: FeedRouteDecision) => void;

const DEFAULT_CONFIG: FeedRouterConfig = {
  maxFreshnessMs: 30_000,
  minIntegrity: 0.5,
};

/**
 * Routes consumers to a serving region based on per-feed freshness and
 * integrity rather than region health alone. Ordering is deterministic:
 *   1. healthy feeds first (freshness within threshold, integrity above floor)
 *   2. lower freshnessMs wins
 *   3. higher integrity wins
 *   4. lower regionPriority wins
 *   5. lexicographic region name (final deterministic tie-break)
 */
export class FeedHealthRouter {
  private readonly config: FeedRouterConfig;
  private readonly logger?: FeedRouteLogger;
  private metrics: FeedRouteMetrics = {
    feed_route_decisions_total: 0,
    feed_route_failovers_total: 0,
  };
  private lastSelected = new Map<string, string>();

  constructor(config: Partial<FeedRouterConfig> = {}, logger?: FeedRouteLogger) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = logger;
  }

  isHealthy(signal: FeedHealthSignal): boolean {
    return signal.freshnessMs <= this.config.maxFreshnessMs
      && signal.integrity >= this.config.minIntegrity;
  }

  /**
   * Select the serving region for an asset. Returns a decision with
   * `selectedRegion === null` when no healthy feed exists.
   */
  route(asset: string, signals: FeedHealthSignal[], now = Date.now()): FeedRouteDecision {
    const candidates = signals.filter((signal) => signal.asset === asset);
    const healthy = candidates.filter((signal) => this.isHealthy(signal));

    let selectedRegion: string | null = null;
    let reason: FeedRouteDecision['reason'] = 'no_healthy_feed';

    if (healthy.length > 0) {
      const ordered = [...healthy].sort(compareSignals);
      selectedRegion = ordered[0].region;
      const previous = this.lastSelected.get(asset);
      reason = previous !== undefined && previous !== selectedRegion ? 'failover' : 'selected';
      this.lastSelected.set(asset, selectedRegion);
    }

    this.metrics.feed_route_decisions_total += 1;
    if (reason === 'failover') {
      this.metrics.feed_route_failovers_total += 1;
    }

    const decision: FeedRouteDecision = {
      asset,
      selectedRegion,
      reason,
      candidates,
      decidedAt: now,
    };

    if (this.logger) {
      this.logger(decision);
    }

    return decision;
  }

  getMetrics(): FeedRouteMetrics {
    return { ...this.metrics };
  }

  resetMetrics(): void {
    this.metrics = { feed_route_decisions_total: 0, feed_route_failovers_total: 0 };
  }
}

function compareSignals(a: FeedHealthSignal, b: FeedHealthSignal): number {
  if (a.freshnessMs !== b.freshnessMs) return a.freshnessMs - b.freshnessMs;
  if (a.integrity !== b.integrity) return b.integrity - a.integrity;
  const pa = a.regionPriority ?? 0;
  const pb = b.regionPriority ?? 0;
  if (pa !== pb) return pa - pb;
  return a.region < b.region ? -1 : a.region > b.region ? 1 : 0;
}

export interface RegionPriceRecord {
  region: string;
  asset: string;
  price: bigint;
  decimals: number;
  timestamp: number;
  receivedAt: number;
  source: 'local' | 'remote';
  /**
   * Monotonic publisher epoch (fencing token) for the originating region
   * (issue #745). Each leader election advances the epoch; records stamped
   * with an epoch lower than the highest epoch observed for a region are
   * rejected as coming from a stale or isolated publisher.
   */
  epoch: number;
  /** W3C trace context carried across the replication bus (issue #419). */
  traceparent?: string;
  tracestate?: string;
}

export interface StaleEpochRejection {
  region: string;
  asset: string;
  recordEpoch: number;
  currentEpoch: number;
  timestamp: number;
}

export interface LwwPriceRegisterOptions {
  /**
   * Persistence hook for the local publisher epoch. Called whenever the
   * local epoch advances so the value survives process restarts. Must be
   * durable before the new epoch is used to stamp outbound records.
   */
  persistEpoch?: (region: string, epoch: number) => void | Promise<void>;
  /** Clock override for deterministic tests. */
  now?: () => number;
}

export class LwwPriceRegister {
  private values = new Map<string, RegionPriceRecord>();
  /** Highest publisher epoch observed per region (fencing token). */
  private epochs = new Map<string, number>();
  /** Epoch this node is currently authorised to publish with, per region. */
  private localEpochs = new Map<string, number>();
  private rejectedStaleEpochs = 0;
  private lastRejection: StaleEpochRejection | null = null;
  private readonly persistEpoch?: (region: string, epoch: number) => void | Promise<void>;
  private readonly now: () => number;

  constructor(options: LwwPriceRegisterOptions = {}) {
    this.persistEpoch = options.persistEpoch;
    this.now = options.now ?? Date.now;
  }

  /**
   * Merge a price record using last-writer-wins semantics.
   * The record with the greatest timestamp wins.
   *
   * Records from a stale publisher (epoch lower than the highest epoch seen
   * for that region) are rejected outright and never mutate the register.
   */
  merge(record: RegionPriceRecord): boolean {
    const currentEpoch = this.epochs.get(record.region) ?? 0;
    if (record.epoch < currentEpoch) {
      this.rejectedStaleEpochs += 1;
      this.lastRejection = {
        region: record.region,
        asset: record.asset,
        recordEpoch: record.epoch,
        currentEpoch,
        timestamp: this.now(),
      };
      return false;
    }
    if (record.epoch > currentEpoch) {
      this.epochs.set(record.region, record.epoch);
    }

    const key = `${record.region}:${record.asset}`;
    const current = this.values.get(key);

    // LWW: only update if new record has later timestamp
    if (!current || record.timestamp > current.timestamp) {
      this.values.set(key, record);
      return 'applied';
    }
    return true;
  }

  /**
   * Merge local prices into the register, stamping them with the current
   * local publisher epoch for the region.
   */
  mergeLocal(region: string, prices: AggregatedPrice[], now = Date.now()): void {
    const epoch = this.currentEpoch(region);
    for (const price of prices) {
      const ownership = this.ownership.get(price.asset);
      this.merge({
        region,
        asset: price.asset,
        price: typeof price.price === 'bigint' ? price.price : BigInt(price.price),
        decimals: price.decimals,
        timestamp: price.timestamp,
        receivedAt: now,
        source: 'local',
        epoch,
      });
    }
  }

  /**
   * Return the highest publisher epoch observed for a region.
   */
  epochFor(region: string): number {
    return this.epochs.get(region) ?? 0;
  }

  /**
   * Return the epoch this node is authorised to publish with for a region.
   * Defaults to the highest observed epoch so a node that has not yet been
   * promoted cannot publish with a lower token.
   */
  currentEpoch(region: string): number {
    return Math.max(this.localEpochs.get(region) ?? 0, this.epochs.get(region) ?? 0);
  }

  /**
   * Advance the local publisher epoch for a region, e.g. on leader election.
   * The epoch is strictly monotonic: the new value is always greater than
   * both the previously persisted local epoch and the highest epoch observed
   * from any publisher. The value is persisted (if a hook is configured)
   * before it is used to stamp outbound records.
   */
  async advanceEpoch(region: string, proposed?: number): Promise<number> {
    const floor = this.currentEpoch(region);
    const next = proposed !== undefined ? Math.max(proposed, floor + 1) : floor + 1;
    if (this.persistEpoch) {
      await this.persistEpoch(region, next);
    }
    this.localEpochs.set(region, next);
    this.epochs.set(region, next);
    return next;
  }

  /**
   * Restore a persisted local epoch on startup. Never lowers the epoch.
   */
  restoreEpoch(region: string, persisted: number): void {
    if (persisted > this.currentEpoch(region)) {
      this.localEpochs.set(region, persisted);
      this.epochs.set(region, persisted);
    }
  }

  /**
   * Number of merges rejected because they carried a stale epoch.
   */
  staleEpochRejections(): number {
    return this.rejectedStaleEpochs;
  }

  /**
   * Details of the most recent stale-epoch rejection, for diagnostics.
   */
  lastStaleEpochRejection(): StaleEpochRejection | null {
    return this.lastRejection;
  }

  /**
   * Get the latest (highest timestamp) record for a specific asset across all regions
   */
  latest(asset: string): RegionPriceRecord | null {
    const candidates = Array.from(this.values.values()).filter((record) => record.asset === asset);
    if (candidates.length === 0) return null;
    return candidates.reduce((winner, record) => (
      record.timestamp > winner.timestamp ? record : winner
    ));
  }

  /**
   * Get the latest record for each unique asset
   */
  latestAll(): RegionPriceRecord[] {
    const assets = new Set(Array.from(this.values.values()).map((record) => record.asset));
    return Array.from(assets)
      .map((asset) => this.latest(asset))
      .filter((record): record is RegionPriceRecord => record !== null);
  }

  /**
   * Get all records for a specific asset from all regions
   */
  byAsset(asset: string): RegionPriceRecord[] {
    return Array.from(this.values.values()).filter((record) => record.asset === asset);
  }

  /**
   * Get all records for a specific region
   */
  byRegion(region: string): RegionPriceRecord[] {
    return Array.from(this.values.values()).filter((record) => record.region === region);
  }

  /**
   * Get the number of stored records
   */
  size(): number {
    return this.values.size;
  }

  /**
   * Clear all stored records. Publisher epochs are retained so that a
   * restart or cache flush cannot resurrect a stale publisher.
   */
  clear(): void {
    this.values.clear();
  }

  /**
   * Clear ownership metadata (used when reconciling state after a transition).
   */
  clearOwnership(): void {
    this.ownership.clear();
  }
}
