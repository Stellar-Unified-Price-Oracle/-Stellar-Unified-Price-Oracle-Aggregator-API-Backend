import BigNumber from 'bignumber.js';
import { NormalizedPrice } from './types';
import { logger } from './utils/logger';

export interface CircuitBreakerConfig {
  deviationThreshold: number; // percentage (e.g., 20 for 20%)
  recoveryRequiredSuccesses: number; // consecutive successes needed to restore
}

export interface SourceState {
  suspicious: boolean;
  consecutiveSuccesses: number;
  lastSuspicionTime: number | null;
  deviations: number; // total deviations detected
}

export class CircuitBreaker {
  private sourceStates: Map<string, SourceState> = new Map();
  private trailingMedians: Map<string, BigNumber[]> = new Map();
  private medianHistorySize: number = 10;
  private config: CircuitBreakerConfig;

  constructor(config: CircuitBreakerConfig) {
    this.config = config;
  }

  /**
   * Evaluate a price submission and update circuit breaker state
   */
  evaluatePrice(price: NormalizedPrice, allPrices: NormalizedPrice[]): {
    isSuspicious: boolean;
    deviation: number;
  } {
    const key = `${price.asset}:${price.source}`;
    const state = this.getOrCreateSourceState(key);

    const assetPrices = allPrices.filter((p) => p.asset === price.asset);
    if (assetPrices.length === 0) {
      return { isSuspicious: state.suspicious, deviation: 0 };
    }

    const median = this.calculateMedian(assetPrices);
    const deviation = this.calculateDeviation(new BigNumber(price.price.toString()), median);

    // Update trailing median history
    const medianKey = price.asset;
    if (!this.trailingMedians.has(medianKey)) {
      this.trailingMedians.set(medianKey, []);
    }
    const history = this.trailingMedians.get(medianKey)!;
    history.push(median);
    if (history.length > this.medianHistorySize) {
      history.shift();
    }

    const isDeviation = deviation > this.config.deviationThreshold;

    if (isDeviation) {
      // Mark as suspicious if deviation is beyond threshold
      if (!state.suspicious) {
        logger.warn(
          `Circuit breaker triggered for ${key}: deviation ${deviation.toFixed(2)}% exceeds threshold ${this.config.deviationThreshold}%`,
        );
      }
      state.suspicious = true;
      state.lastSuspicionTime = Date.now();
      state.consecutiveSuccesses = 0;
      state.deviations++;
    } else {
      // Successful submission
      if (state.suspicious) {
        state.consecutiveSuccesses++;
        if (state.consecutiveSuccesses >= this.config.recoveryRequiredSuccesses) {
          logger.info(
            `Circuit breaker recovered for ${key} after ${state.consecutiveSuccesses} consecutive successes`,
          );
          state.suspicious = false;
          state.consecutiveSuccesses = 0;
        }
      }
    }

    return { isSuspicious: state.suspicious, deviation };
  }

  /**
   * Get the current state of a source
   */
  getSourceState(key: string): SourceState | null {
    return this.sourceStates.get(key) || null;
  }

  /**
   * Get all suspicious sources
   */
  getSuspiciousSources(): Array<{ key: string; state: SourceState }> {
    return Array.from(this.sourceStates.entries())
      .filter(([, state]) => state.suspicious)
      .map(([key, state]) => ({ key, state }));
  }

  /**
   * Get metrics for monitoring
   */
  getMetrics(): {
    totalSources: number;
    suspiciousSources: number;
    suspiciousSourcesList: Array<{ key: string; deviations: number }>;
  } {
    const suspicious = this.getSuspiciousSources();
    return {
      totalSources: this.sourceStates.size,
      suspiciousSources: suspicious.length,
      suspiciousSourcesList: suspicious.map(({ key, state }) => ({
        key,
        deviations: state.deviations,
      })),
    };
  }

  /**
   * Reset the circuit breaker for a source (admin function)
   */
  resetSource(key: string): void {
    this.sourceStates.delete(key);
    logger.info(`Circuit breaker reset for ${key}`);
  }

  /**
   * Reset all circuit breakers (admin function)
   */
  resetAll(): void {
    this.sourceStates.clear();
    logger.info('All circuit breakers reset');
  }

  private getOrCreateSourceState(key: string): SourceState {
    if (!this.sourceStates.has(key)) {
      this.sourceStates.set(key, {
        suspicious: false,
        consecutiveSuccesses: 0,
        lastSuspicionTime: null,
        deviations: 0,
      });
    }
    return this.sourceStates.get(key)!;
  }

  private calculateMedian(prices: NormalizedPrice[]): BigNumber {
    const sorted = prices
      .map((p) => new BigNumber(p.price.toString()))
      .sort((a, b) => a.comparedTo(b) ?? 0);

    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
      return sorted[mid - 1].plus(sorted[mid]).dividedBy(2);
    }
    return sorted[mid];
  }

  private calculateDeviation(price: BigNumber, median: BigNumber): number {
    if (median.isZero()) {
      return 0;
    }
    const diff = price.minus(median).abs();
    const deviation = diff.dividedBy(median).multipliedBy(100);
    return deviation.toNumber();
  }
}
