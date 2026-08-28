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
  timestamp: number;
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
