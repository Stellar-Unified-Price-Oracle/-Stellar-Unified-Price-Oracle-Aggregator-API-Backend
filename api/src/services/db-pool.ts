import { Pool, PoolClient, PoolConfig, QueryResult, QueryResultRow } from 'pg';
import { Logger } from 'winston';
import { withRetry, RetryOptions } from './db-retry';
import { DbCircuitBreaker, DbCircuitBreakerConfig } from './db-circuit-breaker';
import {
  dbPoolTotalConnections,
  dbPoolIdleConnections,
  dbPoolWaitingCount,
  dbPoolMaxConnections,
  dbQueryDuration,
  dbQueryErrorsTotal,
  dbRetriesTotal,
  dbCircuitBreakerState,
} from '../middleware/metrics';

export interface ManagedPoolOptions {
  name: string;
  connectionString: string;
  poolMin: number;
  poolMax: number;
  idleTimeoutMs: number;
  connectionTimeoutMs: number;
  statementTimeoutMs: number;
  retry: RetryOptions;
  circuitBreaker: DbCircuitBreakerConfig;
}

export interface PoolStats {
  name: string;
  total: number;
  idle: number;
  waiting: number;
  max: number;
  circuitState: string;
}

/**
 * A pg Pool wrapped with connection pooling (configurable min/max), retry with
 * exponential backoff, a circuit breaker, and Prometheus instrumentation
 * (issue #44). Used for both the primary and each read replica (issue #45).
 */
export class ManagedPool {
  readonly name: string;
  private readonly pool: Pool;
  private readonly breaker: DbCircuitBreaker;
  private readonly retry: RetryOptions;
  private readonly logger: Logger;
  private readonly max: number;

  constructor(opts: ManagedPoolOptions, logger: Logger) {
    this.name = opts.name;
    this.logger = logger;
    this.retry = opts.retry;
    this.max = opts.poolMax;

    const poolConfig: PoolConfig = {
      connectionString: opts.connectionString,
      min: opts.poolMin,
      max: opts.poolMax,
      idleTimeoutMillis: opts.idleTimeoutMs,
      connectionTimeoutMillis: opts.connectionTimeoutMs,
      // Bound how long a single statement may run server-side.
      statement_timeout: opts.statementTimeoutMs,
    };

    this.pool = new Pool(poolConfig);
    this.pool.on('error', (err) => {
      this.logger.error(`Unexpected error on idle client in pool "${this.name}"`, err);
    });

    this.breaker = new DbCircuitBreaker(this.name, opts.circuitBreaker, logger);
    dbPoolMaxConnections.set({ pool: this.name }, opts.poolMax);
  }

  async query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[],
    operation = 'query',
  ): Promise<QueryResult<R>> {
    const endTimer = dbQueryDuration.startTimer({ pool: this.name, operation });
    let attempts = 0;
    try {
      const result = await this.breaker.execute(() =>
        withRetry(
          () => {
            attempts++;
            return this.pool.query<R>(sql, params as unknown[]);
          },
          this.retry,
          this.logger,
          `pool "${this.name}"`,
        ),
      );
      if (attempts > 1) dbRetriesTotal.inc({ pool: this.name }, attempts - 1);
      return result;
    } catch (err) {
      dbQueryErrorsTotal.inc({ pool: this.name, operation });
      throw err;
    } finally {
      endTimer();
      dbCircuitBreakerState.set({ pool: this.name }, this.breaker.getStateCode());
    }
  }

  /**
   * Check out a raw client. Used for one-off multi-statement work such as
   * schema setup at startup; callers must release().
   */
  connect(): Promise<PoolClient> {
    return this.pool.connect();
  }

  /** Lightweight liveness probe used by replica health monitoring. */
  async ping(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  /** Snapshot pool utilisation and publish it to Prometheus. */
  collectMetrics(): PoolStats {
    const total = this.pool.totalCount;
    const idle = this.pool.idleCount;
    const waiting = this.pool.waitingCount;
    dbPoolTotalConnections.set({ pool: this.name }, total);
    dbPoolIdleConnections.set({ pool: this.name }, idle);
    dbPoolWaitingCount.set({ pool: this.name }, waiting);
    dbCircuitBreakerState.set({ pool: this.name }, this.breaker.getStateCode());
    return {
      name: this.name,
      total,
      idle,
      waiting,
      max: this.max,
      circuitState: this.breaker.getState(),
    };
  }

  getCircuitState(): string {
    return this.breaker.getState();
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}
