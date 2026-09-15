import BigNumber from 'bignumber.js';
import { NormalizedPrice } from '../infrastructure/types';

export interface CommonScaleMedian {
  value: BigNumber;
  decimals: number;
}

/**
 * Median of source prices reduced to a single scale.
 *
 * Each source scales its integer by its own `decimals`, so a median taken over
 * the raw integers compares prices denominated in different units and produces
 * a number that matches no asset's actual price. Everything is shifted to the
 * highest precision present first, and the scale is returned alongside the
 * value so callers label the result with the scale they actually used.
 *
 * The result is rounded back to an integer at that scale, preserving the
 * "price is a bigint scaled by `decimals`" contract every consumer relies on.
 */
export function medianOnCommonScale(prices: NormalizedPrice[]): CommonScaleMedian {
  if (prices.length === 0) {
    return { value: new BigNumber(0), decimals: 0 };
  }

  const decimals = prices.reduce((max, p) => Math.max(max, p.decimals), 0);
  const sorted = prices
    .map((p) => toScale(p, decimals))
    .sort((a, b) => a.comparedTo(b) ?? 0);

  const mid = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 0
      ? sorted[mid - 1]
          .plus(sorted[mid])
          .dividedBy(2)
          .decimalPlaces(0, BigNumber.ROUND_HALF_UP)
      : sorted[mid];

  return { value, decimals };
}

/** Re-express a single source price at `decimals`. */
export function toScale(price: NormalizedPrice, decimals: number): BigNumber {
  return new BigNumber(price.price.toString()).shiftedBy(decimals - price.decimals);
}

/**
 * Whether every contributing price carried its own provider-reported
 * observation time. When false, freshness rests on local fetch times and a
 * provider serving cached data would go unnoticed.
 */
export function isAgeVerified(prices: NormalizedPrice[]): boolean {
  return prices.every((p) => p.observedAt !== null && p.observedAt !== undefined);
}
