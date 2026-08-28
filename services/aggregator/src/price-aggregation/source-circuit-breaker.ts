import { logger } from '../observability/logger';

export type CBState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface SourceCBConfig {
  failureThreshold: number;
  cooldownMs: number;
  halfOpenSuccesses: number;
}

export interface SourceCBStatus {
  state: CBState;
  failures: number;
  lastFailureTime: number | null;
  lastStateChange: number;
  totalTrips: number;
}

interface CBEntry {
  state: CBState;
  failures: number;
  lastFailureTime: number | null;
  lastStateChange: number;
  halfOpenSuccesses: number;
  totalTrips: number;
}

export class SourceCircuitBreaker {
  private states: Map<string, CBEntry> = new Map();
  private config: SourceCBConfig;

  constructor(config: SourceCBConfig) {
    this.config = config;
  }

  isAllowed(source: string): boolean {
    const s = this.getOrCreate(source);
    if (s.state === 'CLOSED') return true;
    if (s.state === 'OPEN') {
      if (Date.now() - (s.lastFailureTime ?? 0) >= this.config.cooldownMs) {
        s.state = 'HALF_OPEN';
        s.lastStateChange = Date.now();
        s.halfOpenSuccesses = 0;
        logger.info(`[circuit-breaker] ${source} transitioning OPEN -> HALF_OPEN`);
        return true;
      }
      return false;
    }
    return true;
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
      });
    }
    return this.states.get(source)!;
  }
}

export const sourceCircuitBreaker = new SourceCircuitBreaker({
  failureThreshold: parseInt(process.env.CB_FAILURE_THRESHOLD || '3', 10),
  cooldownMs: parseInt(process.env.CB_COOLDOWN_MS || '30000', 10),
  halfOpenSuccesses: parseInt(process.env.CB_HALF_OPEN_SUCCESSES || '2', 10),
});
