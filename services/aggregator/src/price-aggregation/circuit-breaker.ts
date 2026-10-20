import BigNumber from 'bignumber.js';
import { NormalizedPrice } from '../infrastructure/types';
import { logger } from '../observability/logger';
import { alertManager } from '../observability/alert-manager';
import { medianOnCommonScale, toScale } from './median';

export interface SurgeLimitConfig {
  // Maximum number of price evaluations allowed per rolling window before
  // the breaker enters degraded (surge-limited) mode.
  maxEvaluationsPerWindow: number;
  // Rolling window length in milliseconds.
  windowMs: number;
  // Maximum number of sources allowed to be in recovery at once. When
  // exceeded, remaining sources stay tripped instead of being retried,
  // preventing a recovery stampede from blowing through provider quotas.
  maxConcurrentRecoveries: number;
  // Fraction (0-1) of the evaluation budget at which a warning alert fires.
  alertThresholdRatio: number;
}

export const DEFAULT_SURGE_LIMITS: SurgeLimitConfig = {
  maxEvaluationsPerWindow: 1000,
  windowMs: 60_000,
  maxConcurrentRecoveries: 5,
  alertThresholdRatio: 0.8,
};

export interface CircuitBreakerConfig {
  deviationThreshold: number; // percentage (e.g., 20 for 20%)
  recoveryRequiredSuccesses: number; // consecutive successes needed to restore
  surgeLimits?: Partial<SurgeLimitConfig>;
}

export interface SurgeState {
  degraded: boolean;
  windowStart: number;
  evaluationsInWindow: number;
  activeRecoveries: number;
  rejectedEvaluations: number;
  alertFired: boolean;
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
  private surgeLimits: SurgeLimitConfig;
  private surgeState: SurgeState = {
    degraded: false,
    windowStart: Date.now(),
    evaluationsInWindow: 0,
    activeRecoveries: 0,
    rejectedEvaluations: 0,
    alertFired: false,
  };

  constructor(config: CircuitBreakerConfig) {
    this.config = config;
    this.surgeLimits = { ...DEFAULT_SURGE_LIMITS, ...(config.surgeLimits ?? {}) };
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

    // Enforce surge limits before doing any work. When the rolling window
    // budget is exhausted we degrade safely: the submission is treated as
    // suspicious (excluded from aggregation) rather than hammering providers.
    if (!this.admitEvaluation()) {
      this.surgeState.rejectedEvaluations++;
      state.suspicious = true;
      state.lastSuspicionTime = Date.now();
      state.consecutiveSuccesses = 0;
      return { isSuspicious: true, deviation: 0 };
    }

    const assetPrices = allPrices.filter((p) => p.asset === price.asset);
    if (assetPrices.length === 0) {
      return { isSuspicious: state.suspicious, deviation: 0 };
    }

    // Deviation has to be measured on one scale. Comparing this source's raw
    // integer against a median of raw integers from sources with different
    // decimals reported a large deviation for a perfectly consistent source,
    // flagging it as suspicious and dropping it from aggregation.
    const { value: median, decimals } = medianOnCommonScale(assetPrices);
    const deviation = this.calculateDeviation(toScale(price, decimals), median);

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
        // Cap concurrent recoveries so a mass failover does not trigger a
        // recovery stampede that exceeds provider quotas or budgets.
        if (this.surgeState.activeRecoveries >= this.surgeLimits.maxConcurrentRecoveries) {
          logger.warn(
            `Recovery deferred for ${key}: ${this.surgeState.activeRecoveries} concurrent recoveries at limit ${this.surgeLimits.maxConcurrentRecoveries}`,
          );
          return { isSuspicious: state.suspicious, deviation };
        }
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
    surge: SurgeState & { limit: SurgeLimitConfig };
  } {
    const suspicious = this.getSuspiciousSources();
    return {
      totalSources: this.sourceStates.size,
      suspiciousSources: suspicious.length,
      suspiciousSourcesList: suspicious.map(({ key, state }) => ({
        key,
        deviations: state.deviations,
      })),
      surge: { ...this.surgeState, limit: this.surgeLimits },
    };
  }

  /**
   * Current surge state (for dashboards and tests).
   */
  getSurgeState(): SurgeState {
    return { ...this.surgeState };
  }

  /**
   * Admit or reject an evaluation against the rolling-window budget.
   * Emits alerts as the budget approaches and reaches its limit.
   */
  private admitEvaluation(): boolean {
    const now = Date.now();
    if (now - this.surgeState.windowStart >= this.surgeLimits.windowMs) {
      this.surgeState.windowStart = now;
      this.surgeState.evaluationsInWindow = 0;
      this.surgeState.degraded = false;
      this.surgeState.alertFired = false;
    }

    const limit = this.surgeLimits.maxEvaluationsPerWindow;
    const used = this.surgeState.evaluationsInWindow;

    if (used >= limit) {
      if (!this.surgeState.degraded) {
        this.surgeState.degraded = true;
        logger.error(
          `Surge limit reached: ${used}/${limit} evaluations in ${this.surgeLimits.windowMs}ms; degrading safely`,
        );
        alertManager.raise({
          severity: 'critical',
          name: 'circuit_breaker_surge_limit_exhausted',
          message: `Circuit breaker evaluation budget exhausted (${used}/${limit}); degrading to exclude new submissions`,
          labels: { component: 'circuit-breaker' },
        });
      }
      return false;
    }

    this.surgeState.evaluationsInWindow = used + 1;

    const threshold = Math.floor(limit * this.surgeLimits.alertThresholdRatio);
    if (!this.surgeState.alertFired && this.surgeState.evaluationsInWindow >= threshold) {
      this.surgeState.alertFired = true;
      logger.warn(
        `Surge limit warning: ${this.surgeState.evaluationsInWindow}/${limit} evaluations used`,
      );
      alertManager.raise({
        severity: 'warning',
        name: 'circuit_breaker_surge_limit_approaching',
        message: `Circuit breaker evaluation budget at ${this.surgeState.evaluationsInWindow}/${limit}`,
        labels: { component: 'circuit-breaker' },
      });
    }

    return true;
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
    this.surgeState = {
      degraded: false,
      windowStart: Date.now(),
      evaluationsInWindow: 0,
      activeRecoveries: 0,
      rejectedEvaluations: 0,
      alertFired: false,
    };
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

  private calculateDeviation(price: BigNumber, median: BigNumber): number {
    if (median.isZero()) {
      return 0;
    }
    const diff = price.minus(median).abs();
    const deviation = diff.dividedBy(median).multipliedBy(100);
    return deviation.toNumber();
  }
}
