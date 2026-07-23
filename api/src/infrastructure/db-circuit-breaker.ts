import { Logger } from 'winston';

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface DbCircuitBreakerConfig {
  enabled: boolean;
  failureThreshold: number; // consecutive failures before opening
  successThreshold: number; // consecutive successes in half-open before closing
  openMs: number; // how long to stay open before probing again
}

export class CircuitOpenError extends Error {
  constructor(name: string) {
    super(`Database circuit breaker "${name}" is open`);
    this.name = 'CircuitOpenError';
  }
}

/**
 * A classic three-state circuit breaker for database operations. When the DB
 * starts failing it trips open and fails fast instead of letting every request
 * pile up new connections against an unhealthy server (thundering herd, #44).
 */
export class DbCircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private successes = 0;
  private openedAt = 0;
  private now: () => number;

  constructor(
    private readonly name: string,
    private readonly config: DbCircuitBreakerConfig,
    private readonly logger?: Logger,
    now: () => number = Date.now,
  ) {
    this.now = now;
  }

  getState(): CircuitState {
    return this.state;
  }

  /** Numeric encoding for Prometheus: 0=closed, 1=half-open, 2=open. */
  getStateCode(): number {
    return this.state === 'closed' ? 0 : this.state === 'half-open' ? 1 : 2;
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.config.enabled) {
      return operation();
    }

    if (this.state === 'open') {
      if (this.now() - this.openedAt >= this.config.openMs) {
        this.transitionTo('half-open');
      } else {
        throw new CircuitOpenError(this.name);
      }
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess(): void {
    if (this.state === 'half-open') {
      this.successes++;
      if (this.successes >= this.config.successThreshold) {
        this.transitionTo('closed');
      }
    } else {
      this.failures = 0;
    }
  }

  private onFailure(): void {
    if (this.state === 'half-open') {
      // A failure while probing immediately re-opens the circuit.
      this.transitionTo('open');
      return;
    }
    this.failures++;
    if (this.failures >= this.config.failureThreshold) {
      this.transitionTo('open');
    }
  }

  private transitionTo(state: CircuitState): void {
    if (this.state === state) return;
    this.state = state;
    this.failures = 0;
    this.successes = 0;
    if (state === 'open') {
      this.openedAt = this.now();
      this.logger?.error(`Database circuit breaker "${this.name}" opened`);
    } else if (state === 'half-open') {
      this.logger?.warn(`Database circuit breaker "${this.name}" half-open (probing)`);
    } else {
      this.logger?.info(`Database circuit breaker "${this.name}" closed`);
    }
  }
}
