import type { AssetPair, PriceDecimal, TimestampMs, OracleSourceId } from '../../types/branded';

/**
 * RawPriceTick — price data as returned by an external oracle provider.
 */
export interface RawPriceTick {
  readonly pair: AssetPair;
  readonly price: PriceDecimal;
  readonly source: OracleSourceId;
  readonly fetchedAt: TimestampMs;
  /** Provider-specific confidence score (0–1). */
  readonly confidence: number;
}

/**
 * IOracleProvider — port for fetching price data from an external oracle.
 *
 * Each supported oracle (Band Protocol, Pyth Network, DIA, etc.) provides
 * an adapter that implements this interface.
 */
export interface IOracleProvider {
  /** Unique identifier for this provider (matches OracleSourceId values). */
  readonly sourceId: OracleSourceId;

  /** Fetch the current price for the given asset pair. */
  fetchPrice(pair: AssetPair): Promise<RawPriceTick>;

  /** Fetch prices for multiple pairs in a single round-trip (optional optimisation). */
  fetchPrices?(pairs: AssetPair[]): Promise<RawPriceTick[]>;

  /** Whether this provider is currently reachable. */
  isHealthy(): Promise<boolean>;
}
