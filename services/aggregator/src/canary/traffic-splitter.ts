import { logger } from '../utils/logger';

export interface TrafficSplitConfig {
  canaryWeight: number;  // 0–100 (percent of publish calls routed to canary)
  enabled: boolean;
}

export type PublishTarget = 'stable' | 'canary' | 'both';

export class TrafficSplitter {
  private weight: number;
  private enabled: boolean;
  private callCount = 0;
  private canaryCallCount = 0;

  constructor(cfg: TrafficSplitConfig) {
    this.weight = Math.max(0, Math.min(100, cfg.canaryWeight));
    this.enabled = cfg.enabled;
  }

  selectTarget(): PublishTarget {
    if (!this.enabled || this.weight === 0) return 'stable';
    if (this.weight >= 100) return 'canary';

    this.callCount++;
    // Deterministic round-robin rather than random to guarantee the configured
    // ratio is met over every 100-call window regardless of prng state.
    const slot = this.callCount % 100;
    if (slot < this.weight) {
      this.canaryCallCount++;
      return 'canary';
    }
    return 'stable';
  }

  setWeight(weight: number): void {
    this.weight = Math.max(0, Math.min(100, weight));
    logger.info(`[Canary] Traffic weight updated to ${this.weight}%`);
  }

  disable(): void {
    this.enabled = false;
    logger.info('[Canary] Traffic splitter disabled — all traffic routed to stable');
  }

  enable(): void {
    this.enabled = true;
    logger.info(`[Canary] Traffic splitter enabled at ${this.weight}%`);
  }

  getStats(): { totalCalls: number; canaryCalls: number; weight: number; enabled: boolean } {
    return {
      totalCalls: this.callCount,
      canaryCalls: this.canaryCallCount,
      weight: this.weight,
      enabled: this.enabled,
    };
  }
}
