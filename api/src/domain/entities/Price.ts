import {
  AssetPair,
  PriceDecimal,
  TimestampMs,
  OracleSourceId,
  PriceId,
} from '../../types/branded';
import type { PriceRecord } from '../ports/IPriceRepository';

/**
 * Price — domain entity representing an aggregated price at a point in time.
 *
 * Encapsulates validity rules and exposes factory methods so that only
 * well-formed Price objects can be constructed.
 */
export class Price {
  private constructor(
    public readonly id: PriceId,
    public readonly pair: AssetPair,
    public readonly price: PriceDecimal,
    public readonly source: OracleSourceId,
    public readonly fetchedAt: TimestampMs,
    public readonly confidence: number,
  ) {}

  /** Create a Price from a raw repository record. */
  static fromRecord(record: PriceRecord): Price {
    if (record.confidence < 0 || record.confidence > 1) {
      throw new RangeError(`Price confidence must be 0–1, got ${record.confidence}`);
    }
    return new Price(
      record.id,
      record.pair,
      record.price,
      record.source,
      record.fetchedAt,
      record.confidence,
    );
  }

  /** Determine whether this price is older than `maxAgeMs` milliseconds. */
  isStale(nowMs: number, maxAgeMs: number): boolean {
    return nowMs - this.fetchedAt > maxAgeMs;
  }

  /** Return the price as a plain number (use only for display/logging). */
  toNumber(): number {
    return parseFloat(this.price);
  }

  toJSON(): PriceRecord {
    return {
      id: this.id,
      pair: this.pair,
      price: this.price,
      source: this.source,
      fetchedAt: this.fetchedAt,
      confidence: this.confidence,
    };
  }
}
