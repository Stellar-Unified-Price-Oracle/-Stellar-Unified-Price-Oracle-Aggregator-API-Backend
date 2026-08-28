export type CircuitState = 'closed' | 'open' | 'half-open';

/**
 * Sources tracked by the admin circuit-breaker endpoints. The aggregator
 * service owns the real oracle-source breakers; this registry reports the
 * database breaker (live in this process) and tracks manual source resets.
 */
export const KNOWN_SOURCES = ['chainlink', 'redstone', 'band', 'reflector', 'database'];

export interface CircuitBreakerStatus {
  source: string;
  status: CircuitState;
}

export class SourceCircuitBreakerRegistry {
  private manual: Map<string, CircuitState> = new Map();
  private databaseStateProvider: () => CircuitState = () => 'closed';

  /** Wire the live database breaker state (set once at startup). */
  setDatabaseStateProvider(provider: () => CircuitState): void {
    this.databaseStateProvider = provider;
  }

  status(source: string): CircuitState {
    const key = source.toLowerCase();
    if (key === 'database') return this.databaseStateProvider();
    return this.manual.get(key) ?? 'closed';
  }

  statuses(): CircuitBreakerStatus[] {
    return KNOWN_SOURCES.map((source) => ({ source, status: this.status(source) }));
  }

  reset(source: string): boolean {
    const key = source.toLowerCase();
    if (!KNOWN_SOURCES.includes(key)) return false;
    this.manual.set(key, 'closed');
    return true;
  }

  resetAll(): number {
    let reset = 0;
    for (const source of KNOWN_SOURCES) {
      if (this.reset(source)) reset += 1;
    }
    return reset;
  }
}

export const sourceCircuitBreakers = new SourceCircuitBreakerRegistry();
