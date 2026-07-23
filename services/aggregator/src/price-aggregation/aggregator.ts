import BigNumber from 'bignumber.js';
import { NormalizedPrice, AggregatedPrice, DegradationLevel } from '../infrastructure/types';
import { config } from '../infrastructure/config';
import { logger } from '../observability/logger';
import { CircuitBreaker, CircuitBreakerConfig } from './circuit-breaker';
import { anomalyDetector } from './anomaly-detector';

export class PriceAggregator {
  private sources: Map<string, NormalizedPrice> = new Map();
  private circuitBreaker: CircuitBreaker;

  constructor(cbConfig?: CircuitBreakerConfig) {
    const circuitBreakerConfig: CircuitBreakerConfig = {
      deviationThreshold: 20, // 20% deviation threshold
      recoveryRequiredSuccesses: 3, // 3 consecutive successes to recover
      ...cbConfig,
    };
    this.circuitBreaker = new CircuitBreaker(circuitBreakerConfig);
  }

  updateSourcePrice(price: NormalizedPrice): void {
    const key = `${price.source}:${price.asset}`;
    this.sources.set(key, price);

    // Evaluate with circuit breaker
    const allPrices = Array.from(this.sources.values());
    const evaluation = this.circuitBreaker.evaluatePrice(price, allPrices);

    if (evaluation.isSuspicious) {
      logger.warn(
        `Source ${price.source} is suspicious for ${price.asset} (deviation: ${evaluation.deviation.toFixed(2)}%)`,
      );
    }
  }

  getLatestForAsset(asset: string): AggregatedPrice | null {
    const normalized = asset.toUpperCase();
    const prices = Array.from(this.sources.values())
      .filter((p) => p.asset === normalized);

    if (prices.length === 0) return null;

    const totalSources = prices.length;
    const validPrices = prices.filter(
      (p) => Date.now() - p.timestamp * 1000 < config.stalenessThresholdMs,
    );
    const stale = validPrices.length === 0;

    // Fall back to all prices (stale) rather than returning null for degraded mode
    const activePrices = stale ? prices : validPrices;

    // Filter out suspicious sources
    const trustedPrices = activePrices.filter((p) => {
      const state = this.circuitBreaker.getSourceState(`${p.source}:${p.asset}`);
      return !state || !state.suspicious;
    });

    const pricesToUse = trustedPrices.length > 0 ? trustedPrices : activePrices;

    const median = this.medianPrice(pricesToUse);
    const sources = Array.from(new Set(pricesToUse.map((p) => p.source)));
    const confidence = pricesToUse.length / Math.max(totalSources, 1);

    const degradationLevel = this.computeDegradationLevel(pricesToUse.length, totalSources, stale);

    const medianFloat = parseFloat(median.toString()) / Math.pow(10, pricesToUse[0].decimals);
    const anomaly = anomalyDetector.detect(normalized, medianFloat) ?? undefined;

    return {
      asset: normalized,
      price: median.toString(),
      decimals: pricesToUse[0].decimals,
      sources,
      timestamp: Math.floor(Date.now() / 1000),
      confidence,
      degradationLevel,
      stale,
      anomaly,
    };
  }

  private computeDegradationLevel(activeCount: number, totalCount: number, stale: boolean): DegradationLevel {
    if (stale || activeCount === 0) return 'critical';
    const ratio = activeCount / Math.max(totalCount, 1);
    if (ratio < 0.5) return 'critical';
    if (ratio < 1.0) return 'degraded';
    return 'healthy';
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

  getCircuitBreakerMetrics() {
    return this.circuitBreaker.getMetrics();
  }

  getSuspiciousSources() {
    return this.circuitBreaker.getSuspiciousSources();
  }

  resetCircuitBreaker(sourceKey?: string) {
    if (sourceKey) {
      this.circuitBreaker.resetSource(sourceKey);
    } else {
      this.circuitBreaker.resetAll();
    }
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
