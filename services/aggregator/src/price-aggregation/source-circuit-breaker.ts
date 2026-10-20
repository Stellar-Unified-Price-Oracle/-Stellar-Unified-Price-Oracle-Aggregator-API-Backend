import { logger } from '../observability/logger';

export type CBState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface SourceCBConfig {
  failureThreshold: number;
  cooldownMs: number;
  halfOpenSuccesses: number;
  /**
   * Surge limits applied while a source is in HALF_OPEN (recovery) state.
   * These cap recovery traffic so a recovering provider is not overwhelmed
   * and provider quotas / budgets are not exceeded during failover storms.
   */
  surge?: SurgeLimitConfig;
}

export interface SurgeLimitConfig {
  /** Max concurrent in-flight requests allowed during HALF_OPEN. */
  maxConcurrentHalfOpen: number;
  /** Max requests allowed per rolling window during HALF_OPEN. */
  maxRequestsPerWindow: number;
  /** Rolling window length in ms for maxRequestsPerWindow. */
  windowMs: number;
  /** Fraction (0..1) of the normal rate allowed during HALF_OPEN. */
  halfOpenRateFraction: number;
  /** Estimated cost per request (arbitrary units) used for budget guard. */
  costPerRequest: number;
  /** Max estimated cost allowed per rolling window before degrading. */
  maxCostPerWindow: number;
}

export type SurgeDecision = 'ALLOW' | 'THROTTLE' | 'DEGRADE';

export interface SurgeStatus {
  decision: SurgeDecision;
  inFlight: number;
  requestsInWindow: number;
  costInWindow: number;
  throttled: number;
  degraded: number;
  lastSurgeAlertTime: number | null;
}

export interface SourceCBStatus {
  state: CBState;
  failures: number;
  lastFailureTime: number | null;
  lastStateChange: number;
  totalTrips: number;
  surge: SurgeStatus;
}

interface CBEntry {
  state: CBState;
  failures: number;
  lastFailureTime: number | null;
  lastStateChange: number;
  halfOpenSuccesses: number;
  totalTrips: number;
  inFlight: number;
  windowStart: number;
  requestsInWindow: number;
  costInWindow: number;
  throttled: number;
  degraded: number;
  lastSurgeAlertTime: number | null;
}

const DEFAULT_SURGE: SurgeLimitConfig = {
  maxConcurrentHalfOpen: 2,
  maxRequestsPerWindow: 10,
  windowMs: 10000,
  halfOpenRateFraction: 0.25,
  costPerRequest: 1,
  maxCostPerWindow: 20,
};

export class SourceCircuitBreaker {
  private states: Map<string, CBEntry> = new Map();
  private config: SourceCBConfig;

  constructor(config: SourceCBConfig) {
    this.config = { ...config, surge: { ...DEFAULT_SURGE, ...(config.surge ?? {}) } };
  }

  isAllowed(source: string): boolean {
    return this.evaluateSurge(source).decision === 'ALLOW';
  }

  /**
   * Evaluates surge limits for a source and returns the enforcement decision.
   * - CLOSED: always ALLOW (normal operation).
   * - OPEN: DEGRADE (no traffic).
   * - HALF_OPEN: THROTTLE when concurrency/rate/cost limits are hit, otherwise ALLOW.
   * Callers must invoke `acquire`/`release` (or `recordRequest`) to keep counters accurate.
   */
  evaluateSurge(source: string): SurgeStatus {
    const s = this.getOrCreate(source);
    const now = Date.now();
    this.rollWindow(s, now);
    const surge = this.config.surge!;

    if (s.state === 'OPEN') {
      if (now - (s.lastFailureTime ?? 0) >= this.config.cooldownMs) {
        s.state = 'HALF_OPEN';
        s.lastStateChange = now;
        s.halfOpenSuccesses = 0;
        s.inFlight = 0;
        s.windowStart = now;
        s.requestsInWindow = 0;
        s.costInWindow = 0;
        logger.info(`[circuit-breaker] ${source} transitioning OPEN -> HALF_OPEN`);
      } else {
        return this.buildSurgeStatus(s, 'DEGRADE');
      }
    }

    if (s.state === 'CLOSED') {
      return this.buildSurgeStatus(s, 'ALLOW');
    }

    // HALF_OPEN: enforce surge limits.
    const rateCap = Math.max(1, Math.floor(surge.maxRequestsPerWindow * surge.halfOpenRateFraction));
    const effectiveRateCap = Math.min(surge.maxRequestsPerWindow, rateCap);
    const costCap = surge.maxCostPerWindow;

    if (s.inFlight >= surge.maxConcurrentHalfOpen) {
      s.throttled++;
      this.alertSurge(source, s, now, 'concurrency', s.inFlight, surge.maxConcurrentHalfOpen);
      return this.buildSurgeStatus(s, 'THROTTLE');
    }
    if (s.requestsInWindow >= effectiveRateCap) {
      s.throttled++;
      this.alertSurge(source, s, now, 'rate', s.requestsInWindow, effectiveRateCap);
      return this.buildSurgeStatus(s, 'THROTTLE');
    }
    if (s.costInWindow + surge.costPerRequest > costCap) {
      s.degraded++;
      this.alertSurge(source, s, now, 'cost', s.costInWindow, costCap);
      return this.buildSurgeStatus(s, 'DEGRADE');
    }
    return this.buildSurgeStatus(s, 'ALLOW');
  }

  /**
   * Marks a request as started. Returns false if surge limits reject it,
   * in which case the caller must not issue the request.
   */
  acquire(source: string): boolean {
    const status = this.evaluateSurge(source);
    if (status.decision !== 'ALLOW') return false;
    const s = this.getOrCreate(source);
    s.inFlight++;
    s.requestsInWindow++;
    s.costInWindow += this.config.surge!.costPerRequest;
    return true;
  }

  /** Marks a previously acquired request as finished. */
  release(source: string): void {
    const s = this.getOrCreate(source);
    if (s.inFlight > 0) s.inFlight--;
  }

  private rollWindow(s: CBEntry, now: number): void {
    const windowMs = this.config.surge!.windowMs;
    if (now - s.windowStart >= windowMs) {
      s.windowStart = now;
      s.requestsInWindow = 0;
      s.costInWindow = 0;
    }
  }

  private alertSurge(
    source: string,
    s: CBEntry,
    now: number,
    reason: 'concurrency' | 'rate' | 'cost',
    current: number,
    limit: number,
  ): void {
    // Rate-limit alerts to once per window to avoid alert storms.
    if (s.lastSurgeAlertTime !== null && now - s.lastSurgeAlertTime < this.config.surge!.windowMs) {
      return;
    }
    s.lastSurgeAlertTime = now;
    logger.warn(
      `[circuit-breaker] surge limit hit for ${source} (${reason}): ${current}/${limit} during HALF_OPEN recovery`,
    );
  }

  private buildSurgeStatus(s: CBEntry, decision: SurgeDecision): SurgeStatus {
    return {
      decision,
      inFlight: s.inFlight,
      requestsInWindow: s.requestsInWindow,
      costInWindow: s.costInWindow,
      throttled: s.throttled,
      degraded: s.degraded,
      lastSurgeAlertTime: s.lastSurgeAlertTime,
    };
  }

  recordSuccess(source: string): void {
    const s = this.getOrCreate(source);
    if (s.state === 'HALF_OPEN') {
      s.halfOpenSuccesses++;
      if (s.halfOpenSuccesses >= this.config.halfOpenSuccesses) {
        s.state = 'CLOSED';
        s.failures = 0;
        s.lastStateChange = Date.now();
        logger.info(`[circuit-breaker] ${source} recovered HALF_OPEN -> CLOSED`);
      }
    } else if (s.state === 'CLOSED') {
      s.failures = 0;
    }
  }

  recordFailure(source: string): void {
    const s = this.getOrCreate(source);
    s.failures++;
    s.lastFailureTime = Date.now();
    if (s.state === 'HALF_OPEN') {
      s.state = 'OPEN';
      s.lastStateChange = Date.now();
      s.totalTrips++;
      logger.warn(`[circuit-breaker] ${source} tripped HALF_OPEN -> OPEN`);
    } else if (s.state === 'CLOSED' && s.failures >= this.config.failureThreshold) {
      s.state = 'OPEN';
      s.lastStateChange = Date.now();
      s.totalTrips++;
      logger.warn(`[circuit-breaker] ${source} tripped CLOSED -> OPEN (${s.failures} failures)`);
    }
  }

  getStatus(source: string): SourceCBStatus {
    const s = this.getOrCreate(source);
    return {
      state: s.state,
      failures: s.failures,
      lastFailureTime: s.lastFailureTime,
      lastStateChange: s.lastStateChange,
      totalTrips: s.totalTrips,
      surge: this.buildSurgeStatus(s, s.state === 'OPEN' ? 'DEGRADE' : 'ALLOW'),
    };
  }

  getAllStatuses(): Record<string, SourceCBStatus> {
    const result: Record<string, SourceCBStatus> = {};
    for (const [source] of this.states) {
      result[source] = this.getStatus(source);
    }
    return result;
  }

  private getOrCreate(source: string): CBEntry {
    if (!this.states.has(source)) {
      this.states.set(source, {
        state: 'CLOSED',
        failures: 0,
        lastFailureTime: null,
        lastStateChange: Date.now(),
        halfOpenSuccesses: 0,
        totalTrips: 0,
        inFlight: 0,
        windowStart: Date.now(),
        requestsInWindow: 0,
        costInWindow: 0,
        throttled: 0,
        degraded: 0,
        lastSurgeAlertTime: null,
      });
    }
    return this.states.get(source)!;
  }
}

export const sourceCircuitBreaker = new SourceCircuitBreaker({
  failureThreshold: parseInt(process.env.CB_FAILURE_THRESHOLD || '3', 10),
  cooldownMs: parseInt(process.env.CB_COOLDOWN_MS || '30000', 10),
  halfOpenSuccesses: parseInt(process.env.CB_HALF_OPEN_SUCCESSES || '2', 10),
  surge: {
    maxConcurrentHalfOpen: parseInt(process.env.CB_SURGE_MAX_CONCURRENT || '2', 10),
    maxRequestsPerWindow: parseInt(process.env.CB_SURGE_MAX_REQUESTS || '10', 10),
    windowMs: parseInt(process.env.CB_SURGE_WINDOW_MS || '10000', 10),
    halfOpenRateFraction: parseFloat(process.env.CB_SURGE_RATE_FRACTION || '0.25'),
    costPerRequest: parseFloat(process.env.CB_SURGE_COST_PER_REQUEST || '1'),
    maxCostPerWindow: parseFloat(process.env.CB_SURGE_MAX_COST || '20'),
  },
});
