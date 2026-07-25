import type { AssetPair, OracleSourceId, PriceDecimal, TimestampMs } from '../../types/branded';

/**
 * PriceFetched — domain event emitted when a new price tick is retrieved
 * from an oracle provider, before validation and persistence.
 */
export interface PriceFetched {
  readonly type: 'PriceFetched';
  readonly pair: AssetPair;
  readonly price: PriceDecimal;
  readonly source: OracleSourceId;
  readonly fetchedAt: TimestampMs;
  readonly confidence: number;
}

/**
 * PricePublished — domain event emitted after a price has been validated
 * and persisted to the store, signalling it is safe to broadcast.
 */
export interface PricePublished {
  readonly type: 'PricePublished';
  readonly pair: AssetPair;
  readonly price: PriceDecimal;
  readonly source: OracleSourceId;
  readonly publishedAt: TimestampMs;
}

export type DomainEvent = PriceFetched | PricePublished;
