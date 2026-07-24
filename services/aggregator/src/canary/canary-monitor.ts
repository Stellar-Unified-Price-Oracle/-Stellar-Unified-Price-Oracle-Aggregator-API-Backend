import BigNumber from 'bignumber.js';
import { logger } from '../utils/logger';

export interface CanaryPublishResult {
  asset: string;
  stablePrice: string;
  canaryPrice: string;
  decimals: number;
  timestamp: number;
  stableTxHash: string | null;
  canaryTxHash: string | null;
  canaryFailed: boolean;
  deviationBps: number;
}

export interface CanaryMonitorConfig {
  maxDeviationBps: number;      // auto-rollback if canary price deviates > this from stable
  maxConsecutiveFailures: number; // auto-rollback after N consecutive canary tx failures
  rollbackCallback: () => void;  // called when auto-rollback is triggered
}

export class CanaryMonitor {
  private results: CanaryPublishResult[] = [];
  private consecutiveFailures = 0;
  private rolledBack = false;
  private cfg: CanaryMonitorConfig;

  constructor(cfg: CanaryMonitorConfig) {
    this.cfg = cfg;
  }

  record(result: CanaryPublishResult): void {
    this.results.push(result);
    if (this.results.length > 500) this.results.shift();

    if (result.canaryFailed) {
      this.consecutiveFailures++;
      logger.warn(`[Canary] TX failed for ${result.asset} (consecutive failures: ${this.consecutiveFailures})`);
    } else {
      this.consecutiveFailures = 0;
    }

    if (!result.canaryFailed && result.deviationBps > this.cfg.maxDeviationBps) {
      logger.error(
        `[Canary] Price deviation too large for ${result.asset}: ` +
        `${result.deviationBps} bps (max: ${this.cfg.maxDeviationBps} bps). ` +
        `Stable=${result.stablePrice} Canary=${result.canaryPrice}`,
      );
      this.triggerRollback(`price deviation ${result.deviationBps} bps > ${this.cfg.maxDeviationBps} bps on ${result.asset}`);
      return;
    }

    if (this.consecutiveFailures >= this.cfg.maxConsecutiveFailures) {
      this.triggerRollback(`${this.consecutiveFailures} consecutive canary TX failures`);
    }
  }

  private triggerRollback(reason: string): void {
    if (this.rolledBack) return;
    this.rolledBack = true;
    logger.error(`[Canary] Auto-rollback triggered — ${reason}`);
    this.cfg.rollbackCallback();
  }

  isRolledBack(): boolean {
    return this.rolledBack;
  }

  reset(): void {
    this.rolledBack = false;
    this.consecutiveFailures = 0;
    logger.info('[Canary] Monitor state reset');
  }

  getMetrics(): {
    totalSamples: number;
    failedSamples: number;
    maxDeviationBps: number;
    avgDeviationBps: number;
    consecutiveFailures: number;
    rolledBack: boolean;
  } {
    const failed = this.results.filter((r) => r.canaryFailed).length;
    const deviations = this.results.filter((r) => !r.canaryFailed).map((r) => r.deviationBps);
    const maxDev = deviations.length > 0 ? Math.max(...deviations) : 0;
    const avgDev =
      deviations.length > 0
        ? deviations.reduce((a, b) => a + b, 0) / deviations.length
        : 0;

    return {
      totalSamples: this.results.length,
      failedSamples: failed,
      maxDeviationBps: maxDev,
      avgDeviationBps: Math.round(avgDev),
      consecutiveFailures: this.consecutiveFailures,
      rolledBack: this.rolledBack,
    };
  }
}

export function calcDeviationBps(stablePrice: string, canaryPrice: string, decimals: number): number {
  const base = new BigNumber(stablePrice);
  if (base.isZero()) return 0;
  const diff = new BigNumber(canaryPrice).minus(base).abs();
  return diff.multipliedBy(10000).dividedBy(base).integerValue(BigNumber.ROUND_CEIL).toNumber();
}
