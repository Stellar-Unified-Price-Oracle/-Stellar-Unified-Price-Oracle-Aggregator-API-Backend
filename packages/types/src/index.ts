/**
 * Shared type definitions for the Stellar Unified Price Oracle & Aggregator.
 *
 * These types are the canonical source of truth used by both the API and
 * aggregator services, ensuring consistency across service boundaries.
 */

// ── Oracle source identifiers ────────────────────────────────────────────────

export type OracleSourceName = 'chainlink' | 'redstone' | 'band' | 'reflector';

// ── Normalized per-source price ───────────────────────────────────────────────

export interface NormalizedPrice {
  asset: string;
  price: bigint;
  decimals: number;
  source: OracleSourceName;
  /**
   * Best-known observation time, in Unix seconds.
   *
   * This equals `observedAt` when the provider reported one, and is otherwise
   * the local fetch time. Anything that reasons about *age* — staleness checks,
   * retention, gap detection — should read `observedAt` rather than this field,
   * because a locally stamped price can never be shown to be stale.
   */
  timestamp: number;
  /**
   * The provider's own observation time, in Unix seconds.
   *
   * `null` (or absent) means the provider does not report one, so `timestamp`
   * is only local fetch time and the freshness of this price is not
   * independently verifiable.
   */
  observedAt?: number | null;
  /** Local time this response was received, in Unix seconds. */
  fetchedAt?: number;
}

// ── Aggregated (median) price ─────────────────────────────────────────────────

export type DegradationLevel = 'healthy' | 'degraded' | 'critical';

export interface AnomalyScore {
  isAnomaly: boolean;
  score: number;
  method: 'zscore' | 'moving_average' | 'volatility';
  details: string;
}

export interface AggregatedPrice {
  asset: string;
  price: string;
  decimals: number;
  sources: OracleSourceName[];
  timestamp: number;
  confidence: number;
  degradationLevel: DegradationLevel;
  stale: boolean;
  /**
   * True only when every contributing source reported its own observation
   * time, so this price's age was independently verifiable. False means
   * freshness rests on local fetch times — a provider quietly serving cached
   * data would not be detected.
   */
  ageVerified?: boolean;
  anomaly?: AnomalyScore;
}

// ── Source health ─────────────────────────────────────────────────────────────

export interface SourceHealthStatus {
  healthy: boolean;
  lastSuccess: number | null;
  lastFailure: number | null;
  consecutiveFailures: number;
  totalRequests: number;
  totalFailures: number;
  uptimePercent: number;
}

// ── Contract / Soroban configuration ──────────────────────────────────────────

export interface ContractConfig {
  rpcUrl: string;
  contractId: string;
  networkPassphrase: string;
  adminSecret: string;
}

// ── API price representation (returned to consumers) ─────────────────────────

export interface ApiPrice {
  asset: string;
  price: string;
  decimals: number;
  source: string;
  timestamp: number;
  sources?: OracleSourceName[];
  confidence?: number;
  degradationLevel?: DegradationLevel;
  stale?: boolean;
  anomaly?: AnomalyScore;
}

export interface HistoricalPriceEntry {
  price: string;
  decimals: number;
  source: string;
  timestamp: number;
}

// ── Consumer data product types (issues #715-#718) ─────────────────────────────

/** Consumer-supplied or derived geographic region for latency/freshness grouping. */
export type ConsumerRegion = string;

/** A single measured delivery sample: how long a price took to reach the consumer
 *  and how fresh it was at serve time. */
export interface LatencySample {
  asset: string;
  region: ConsumerRegion;
  /** Price observation timestamp, Unix seconds (provider's observedAt when present). */
  observedAt: number;
  /** When the API delivered the response, Unix seconds. */
  deliveredAt: number;
  /** End-to-end delivery latency in milliseconds. */
  latencyMs: number;
  /** Data age at delivery in milliseconds (deliveredAt - price.timestamp). */
  freshnessMs: number;
  source?: OracleSourceName;
}

/** Percentile summary for a numeric distribution. */
export interface PercentileSummary {
  p50: number;
  p95: number;
  p99: number;
  mean: number;
  max: number;
  count: number;
}

/** Latency + freshness stats for one (asset, region) feed over a sample window. */
export interface FeedLatencyFreshnessStats {
  asset: string;
  region: ConsumerRegion;
  windowStart: number; // Unix seconds
  windowEnd: number;   // Unix seconds
  sampleCount: number;
  latency: PercentileSummary;
  freshness: PercentileSummary & { staleCount: number };
  methodology: string;
}

/** One usage record exported to the calling consumer (tenant-scoped). */
export interface UsageExportRecord {
  endpoint: string;
  method: string;
  asset?: string;
  status: number;
  timestamp: number; // Unix seconds
}

/** Machine-readable usage export for the authenticated consumer only. */
export interface UsageExport {
  keyPrefix: string;
  windowStart: number; // Unix seconds
  windowEnd: number;   // Unix seconds
  totalRequests: number;
  byEndpoint: Record<string, number>;
  byAsset: Record<string, number>;
  byStatus: Record<string, number>;
  records: UsageExportRecord[];
  generatedAt: number; // Unix seconds
}

/** A contracted consumer delivery objective (SLO/SLA). */
export interface DeliveryObjective {
  id: string;
  name: string;
  description: string;
  metric: 'latency' | 'freshness' | 'uptime' | 'availability';
  target: number;
  unit: 'ms' | 'seconds' | 'percent';
  window: '1h' | '24h' | '7d' | '30d';
}

/** Measured attainment of a delivery objective, with exclusions and incidents. */
export interface DeliveryObjectiveAttainment {
  objective: DeliveryObjective;
  attained: boolean;
  actual: number;
  target: number;
  unit: 'ms' | 'seconds' | 'percent';
  exclusions: Array<{ reason: string; from: number; to: number }>;
  incidentWindows: Array<{ id: string; from: number; to: number; reason: string }>;
  calculation: string; // human-readable, auditable description of the calculation
}

/** Price-provenance response linking a price to its production lineage. */
export interface PriceProvenance {
  asset: string;
  price: string;
  decimals: number;
  timestamp: number; // Unix seconds
  observedAt: number | null;
  catalogVersion: string;
  aggregationPolicy: {
    strategy: string;
    sourceCount: number;
    minSources: number;
  };
  sourceSet: OracleSourceName[];
  observationTimeSemantics: {
    observedAt?: number | null;
    fetchedAt?: number | null;
    /** True only when every contributing source reported its own observation time. */
    ageVerified: boolean;
  };
  provenanceId: string;
  verificationUrl: string;
}
