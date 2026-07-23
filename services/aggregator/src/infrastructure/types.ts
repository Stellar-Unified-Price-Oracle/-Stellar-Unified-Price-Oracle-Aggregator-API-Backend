export interface NormalizedPrice {
  asset: string;
  price: bigint;
  decimals: number;
  source: OracleSourceName;
  timestamp: number;
}

export type OracleSourceName = 'chainlink' | 'redstone' | 'band' | 'reflector';

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

export interface SourceHealthStatus {
  healthy: boolean;
  lastSuccess: number | null;
  lastFailure: number | null;
  consecutiveFailures: number;
  totalRequests: number;
  totalFailures: number;
  uptimePercent: number;
}

export interface ContractConfig {
  rpcUrl: string;
  contractId: string;
  networkPassphrase: string;
  adminSecret: string;
}
