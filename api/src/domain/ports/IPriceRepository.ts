import type { AssetPair, PriceDecimal, TimestampMs, OracleSourceId, PriceId } from '../../types/branded';

/**
 * PriceRecord — the canonical domain representation of a single price data point.
 */
export interface PriceRecord {
  readonly id: PriceId;
  readonly pair: AssetPair;
  readonly price: PriceDecimal;
  readonly source: OracleSourceId;
  readonly fetchedAt: TimestampMs;
  readonly confidence: number; // 0–1
}

/**
 * PriceFilter — query parameters for fetching price records.
 */
export interface PriceFilter {
  readonly pair?: AssetPair;
  readonly source?: OracleSourceId;
  readonly from?: TimestampMs;
  readonly to?: TimestampMs;
  readonly limit?: number;
  readonly cursor?: string;
}

/**
 * IPriceRepository — port (interface) for price data access.
 *
 * The domain defines this contract; the infrastructure layer provides
 * a concrete adapter (e.g. PostgresPriceRepository).
 */
export interface IPriceRepository {
  /** Retrieve the latest price record for a given asset pair. */
  findLatest(pair: AssetPair): Promise<PriceRecord | null>;

  /** Retrieve historical price records matching the given filter. */
  findHistory(filter: PriceFilter): Promise<PriceRecord[]>;

  /** Persist a new price record. Returns the stored record with its generated ID. */
  save(record: Omit<PriceRecord, 'id'>): Promise<PriceRecord>;

  /** Retrieve a single price record by its ID. */
  findById(id: PriceId): Promise<PriceRecord | null>;
}
