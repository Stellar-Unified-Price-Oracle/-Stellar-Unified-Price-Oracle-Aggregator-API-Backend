import { config } from '../infrastructure/config';
import { AggregatedPrice } from '../infrastructure/types';
import { FeedReplicationMonitor } from './feed-replication-monitor';
import { LwwPriceRegister, RegionPriceRecord } from './price-crdt';
import { propagateForHop, TraceHeaders } from './trace-context';
import { metrics } from '../infrastructure/metrics';

/**
 * Fencing epoch carried on every replication record (issue #745). The epoch is
 * monotonically increasing per region and is bumped on leader election, so a
 * stale or isolated region that keeps publishing after failover is rejected by
 * peers because its epoch is older than the last epoch seen for that region.
 */
export interface FencedPriceRecord extends Omit<RegionPriceRecord, 'receivedAt' | 'source'> {
  epoch: number;
}

export interface StaleEpochRejection {
  region: string;
  asset: string;
  recordEpoch: number;
  lastSeenEpoch: number;
}

/**
 * Ownership rules for a single feed (issue #737). Exactly one region is the
 * authorized publisher at any time: `primaryRegion` in steady state, or
 * `failoverRegion` while a failover is active. `epoch` is bumped on every
 * ownership transition so stale publishers can be detected and rejected.
 */
export interface FeedOwnership {
  feed: string;
  primaryRegion: string;
  failoverRegion: string;
  /** Region currently authorized to publish this feed. */
  activeRegion: string;
  /** Monotonic ownership epoch; incremented on every transition. */
  epoch: number;
}

export interface FeedOwnershipConfig {
  feed: string;
  primaryRegion: string;
  failoverRegion: string;
}

/**
 * Per-feed ownership registry (issue #737). Resolves the primary/failover
 * region for each feed from configuration and answers whether a given region
 * is the authorized publisher.
 */
export class FeedOwnershipRegistry {
  private readonly feeds = new Map<string, FeedOwnership>();

  constructor(entries: FeedOwnershipConfig[], initialEpoch = 1) {
    for (const entry of entries) {
      if (this.feeds.has(entry.feed)) {
        throw new Error(`duplicate feed ownership entry for ${entry.feed}`);
      }
      if (entry.primaryRegion === entry.failoverRegion) {
        throw new Error(`feed ${entry.feed} primary and failover regions must differ`);
      }
      this.feeds.set(entry.feed, {
        feed: entry.feed,
        primaryRegion: entry.primaryRegion,
        failoverRegion: entry.failoverRegion,
        activeRegion: entry.primaryRegion,
        epoch: initialEpoch,
      });
    }
  }

  get(feed: string): FeedOwnership | undefined {
    return this.feeds.get(feed);
  }

  list(): FeedOwnership[] {
    return Array.from(this.feeds.values());
  }

  /** True when `region` is the active publisher for `feed`. */
  isOwner(feed: string, region: string): boolean {
    return this.feeds.get(feed)?.activeRegion === region;
  }

  /** Region that should take over `feed` if the active region fails. */
  failoverTarget(feed: string): string | undefined {
    const ownership = this.feeds.get(feed);
    if (!ownership) return undefined;
    return ownership.activeRegion === ownership.primaryRegion
      ? ownership.failoverRegion
      : ownership.primaryRegion;
  }

  /**
   * Transfer publishing authority for `feed` to `region`, bumping the epoch.
   * Returns the new ownership record, or undefined for an unknown feed.
   */
  transfer(feed: string, region: string): FeedOwnership | undefined {
    const ownership = this.feeds.get(feed);
    if (!ownership) return undefined;
    if (region !== ownership.primaryRegion && region !== ownership.failoverRegion) {
      throw new Error(`region ${region} is not a configured owner for feed ${feed}`);
    }
    if (ownership.activeRegion === region) return ownership;
    ownership.activeRegion = region;
    ownership.epoch += 1;
    return ownership;
  }
}

export interface PublishDecision {
  allowed: boolean;
  epoch: number;
  reason?: 'unknown-feed' | 'not-owner' | 'stale-epoch';
}

/**
 * Epoch/lease-based publisher authority (issue #737). Tracks the highest epoch
 * observed per feed and rejects local publishing when this region is not the
 * owner or when the caller's epoch is older than the one already observed.
 */
export class PublisherAuthority {
  private readonly observedEpochs = new Map<string, number>();

  constructor(
    private readonly registry: FeedOwnershipRegistry,
    private readonly region: string = config.region.id,
  ) {}

  /** Highest epoch observed for `feed` (0 when never seen). */
  currentEpoch(feed: string): number {
    return this.observedEpochs.get(feed) ?? 0;
  }

  /**
   * Record an epoch observed on an inbound replication record. Returns false
   * when the record is stale (older than the highest epoch already seen).
   */
  observeEpoch(feed: string, epoch: number): boolean {
    const current = this.currentEpoch(feed);
    if (epoch < current) return false;
    if (epoch > current) this.observedEpochs.set(feed, epoch);
    return true;
  }

  /** Decide whether this region may publish `feed` at `epoch`. */
  authorize(feed: string, epoch?: number): PublishDecision {
    const ownership = this.registry.get(feed);
    if (!ownership) {
      return { allowed: false, epoch: this.currentEpoch(feed), reason: 'unknown-feed' };
    }
    const effectiveEpoch = epoch ?? ownership.epoch;
    const observed = this.currentEpoch(feed);
    if (effectiveEpoch < observed || effectiveEpoch < ownership.epoch) {
      return { allowed: false, epoch: observed, reason: 'stale-epoch' };
    }
    if (ownership.activeRegion !== this.region) {
      return { allowed: false, epoch: effectiveEpoch, reason: 'not-owner' };
    }
    return { allowed: true, epoch: effectiveEpoch };
  }
}

export interface DriftReport {
  maxDriftPercent: number;
  maxStalenessMs: number;
  asset?: string;
  regions: string[];
  regionCount: number;
  peerCount: number;
  hasPeers: boolean;
  driftKnown: boolean;
}

export class RegionPriceReplicator {
  private readonly register = new LwwPriceRegister();
  private epoch: number;
  private readonly lastSeenEpochByRegion = new Map<string, number>();
  private readonly staleEpochRejections: StaleEpochRejection[] = [];

  constructor(initialEpoch = 0) {
    this.epoch = initialEpoch;
  }

  /** Current fencing epoch for this region. */
  getEpoch(): number {
    return this.epoch;
  }

  /**
   * Advance the fencing epoch on leader election. Must be called before the
   * newly elected leader publishes anything so peers can distinguish its
   * records from those of the previous (possibly partitioned) leader.
   */
  advanceEpochOnLeaderElection(nextEpoch?: number): number {
    const candidate = nextEpoch ?? this.epoch + 1;
    if (candidate > this.epoch) {
      this.epoch = candidate;
    }
    return this.epoch;
  }

  /** Last epoch accepted from `region`, if any. */
  getLastSeenEpoch(region: string): number | undefined {
    return this.lastSeenEpochByRegion.get(region);
  }

  /** Rejections recorded for stale-epoch inbound records. */
  getStaleEpochRejections(): StaleEpochRejection[] {
    return [...this.staleEpochRejections];
  }

  constructor(
    ownership: FeedOwnershipRegistry = new FeedOwnershipRegistry(config.feeds ?? []),
    authority?: PublisherAuthority,
  ) {
    this.ownership = ownership;
    this.authority = authority ?? new PublisherAuthority(ownership);
  }

  /**
   * Merge locally produced prices. Only prices for feeds this region is the
   * authorized publisher of are accepted (issue #737); others are dropped so a
   * non-owner never emits local records.
   */
  mergeLocalPrices(prices: AggregatedPrice[]): void {
    this.register.mergeLocal(config.region.id, prices, this.epoch);
  }

  /**
   * Merge an inbound remote record. Returns `false` (and records a rejection)
   * when the record's epoch is older than the last epoch seen for its region,
   * which fences out stale or isolated publishers after failover.
   */
  mergeRemotePrice(record: FencedPriceRecord): boolean {
    const lastSeen = this.lastSeenEpochByRegion.get(record.region);
    if (lastSeen !== undefined && record.epoch < lastSeen) {
      this.staleEpochRejections.push({
        region: record.region,
        asset: record.asset,
        recordEpoch: record.epoch,
        lastSeenEpoch: lastSeen,
      });
      metrics.increment('replication_stale_epoch_rejected_total', {
        region: record.region,
      });
      return false;
    }

    if (lastSeen === undefined || record.epoch > lastSeen) {
      this.lastSeenEpochByRegion.set(record.region, record.epoch);
    }
    this.register.merge({ ...record, receivedAt: Date.now(), source: 'remote' });
    return true;
  }

  /**
   * Build the outbound replication records for this region's latest prices,
   * stamped with the current fencing epoch.
   */
  buildOutboundRecords(): FencedPriceRecord[] {
    return this.getLocalPrices().map((record) => ({
      region: record.region,
      asset: record.asset,
      price: record.price,
      timestamp: record.timestamp,
      epoch: this.epoch,
      traceparent: record.traceparent,
      tracestate: record.tracestate,
    }));
  }

  /** Ownership record for `feed`, if configured. */
  getOwnership(feed: string): FeedOwnership | undefined {
    return this.ownership.get(feed);
  }

  /** Epoch this region would stamp on an outbound record for `feed`. */
  outboundEpoch(feed: string): number {
    return this.ownership.get(feed)?.epoch ?? this.authority.currentEpoch(feed);
  }

  getLatestPrices(): RegionPriceRecord[] {
    return this.register.latestAll();
  }

  getLocalPrices(): RegionPriceRecord[] {
    return this.register
      .byRegion(config.region.id)
      .filter((record) => record.source === 'local');
  }

  /**
   * Trace headers to attach to an outbound replication message for `asset`
   * (issue #419). Continues the trace carried by the last inbound record for
   * that asset, or starts a fresh one, and tags this region into `tracestate`.
   */
  outboundTraceHeaders(asset: string, inbound?: TraceHeaders): TraceHeaders {
    const carried = inbound
      ?? this.register
        .byAsset(asset)
        .filter((r) => r.source === 'remote' && r.traceparent)
        .sort((a, b) => b.receivedAt - a.receivedAt)[0];
    return propagateForHop(
      carried ? { traceparent: carried.traceparent, tracestate: carried.tracestate } : undefined,
      config.region.id,
    );
  }

  getReplicationLagReport(now = Date.now()) {
    return this.monitor.report(now);
  }

  getDriftReport(now = Date.now()): DriftReport {
    let maxDriftPercent = 0;
    let maxStalenessMs = 0;
    let asset: string | undefined;
    let comparableAssets = 0;
    const regions = new Set<string>();
    const assets = new Set<string>();

    for (const price of this.register.latestAll()) {
      assets.add(price.asset);
    }

    for (const assetName of assets) {
      const records = this.register.byAsset(assetName);
      for (const record of records) {
        regions.add(record.region);
        maxStalenessMs = Math.max(maxStalenessMs, now - record.receivedAt);
      }
      if (records.length < 2) continue;

      const values = records.map((record) => Number(record.price));
      const median = values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
      if (median === 0) continue;

      comparableAssets += 1;
      for (const value of values) {
        const drift = Math.abs(value - median) / median * 100;
        if (drift > maxDriftPercent) {
          maxDriftPercent = drift;
          asset = assetName;
        }
      }
    }

    const regionCount = regions.size;
    const peerCount = regions.has(config.region.id) ? regionCount - 1 : regionCount;

    return {
      maxDriftPercent,
      maxStalenessMs,
      asset,
      regions: Array.from(regions).sort(),
      regionCount,
      peerCount,
      hasPeers: peerCount > 0,
      driftKnown: comparableAssets > 0,
    };
  }
}
