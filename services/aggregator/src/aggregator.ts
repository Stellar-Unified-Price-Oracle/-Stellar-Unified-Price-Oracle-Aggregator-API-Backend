import BigNumber from 'bignumber.js';
import { NormalizedPrice, AggregatedPrice } from './types';
import { config } from './config';
import { logger } from './utils/logger';

export class PriceAggregator {
  private sources: Map<string, NormalizedPrice> = new Map();

  updateSourcePrice(price: NormalizedPrice): void {
    const key = `${price.source}:${price.asset}`;
    this.sources.set(key, price);
  }

  getLatestForAsset(asset: string): AggregatedPrice | null {
    const normalized = asset.toUpperCase();
    const prices = Array.from(this.sources.values())
      .filter((p) => p.asset === normalized);

    if (prices.length === 0) return null;

    const validPrices = prices.filter(
      (p) => Date.now() - p.timestamp * 1000 < config.stalenessThresholdMs,
    );

    if (validPrices.length === 0) return null;

    const median = this.medianPrice(validPrices);
    const sources = Array.from(new Set(validPrices.map((p) => p.source)));

    return {
      asset: normalized,
      price: median.toString(),
      decimals: validPrices[0].decimals,
      sources,
      timestamp: Math.floor(Date.now() / 1000),
      confidence: validPrices.length / prices.length,
    };
  }

  getAllPrices(): AggregatedPrice[] {
    const assets = Array.from(
      new Set(Array.from(this.sources.values()).map((p) => p.asset)),
    );
    return assets
      .map((asset) => this.getLatestForAsset(asset))
      .filter((p): p is AggregatedPrice => p !== null);
  }

  getSourceCount(): number {
    return Array.from(
      new Set(Array.from(this.sources.values()).map((p) => p.source)),
    ).length;
  }

  private medianPrice(prices: NormalizedPrice[]): BigNumber {
    const sorted = prices
      .map((p) => new BigNumber(p.price.toString()))
      .sort((a, b) => a.comparedTo(b) ?? 0);

    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
      return sorted[mid - 1].plus(sorted[mid]).dividedBy(2);
    }
    return sorted[mid];
  }
}
