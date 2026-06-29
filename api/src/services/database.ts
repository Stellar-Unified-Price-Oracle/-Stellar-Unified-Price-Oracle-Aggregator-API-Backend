import { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { Logger } from 'winston';
import { config } from '../config';
import { ManagedPool, ManagedPoolOptions, PoolStats } from './db-pool';
import { dbReplicaHealthy, dbReplicaLagSeconds } from '../middleware/metrics';

export interface PriceHistory {
  id?: number;
  asset: string;
  price: string;
  decimals: number;
  source: string;
  timestamp: number;
  created_at?: Date;
}

interface ReplicaEntry {
  pool: ManagedPool;
  url: string;
  healthy: boolean;
  lagSeconds: number;
}

export class DatabaseClient {
  private primary: ManagedPool;
  private replicas: ReplicaEntry[] = [];
  private logger: Logger;
  private initialized = false;
  private timescaleEnabled = false;
  private replicaCursor = 0;
  private healthTimer?: NodeJS.Timeout;
  private metricsTimer?: NodeJS.Timeout;

  constructor(databaseUrl: string, logger: Logger) {
    this.logger = logger;

    const base = (name: string, connectionString: string): ManagedPoolOptions => ({
      name,
      connectionString,
      poolMin: config.db.poolMin,
      poolMax: config.db.poolMax,
      idleTimeoutMs: config.db.idleTimeoutMs,
      connectionTimeoutMs: config.db.connectionTimeoutMs,
      statementTimeoutMs: config.db.statementTimeoutMs,
      retry: config.db.retry,
      circuitBreaker: config.db.circuitBreaker,
    });

    this.primary = new ManagedPool(base('primary', databaseUrl), logger);

    config.db.replica.urls.forEach((url, i) => {
      this.replicas.push({
        pool: new ManagedPool(base(`replica-${i}`, url), logger),
        url,
        healthy: true,
        lagSeconds: 0,
      });
    });

    if (this.replicas.length > 0) {
      this.logger.info(`Configured ${this.replicas.length} read replica(s) for read scaling`);
    }
  }

  /**
   * Execute against the primary. Use for all writes (issue #45).
   */
  async query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<R>> {
    return this.primary.query<R>(sql, params, 'write');
  }

  /**
   * Execute a read. Reads are distributed across healthy replicas and fall back
   * to the primary when no replica is available or within lag tolerance.
   */
  async readQuery<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<R>> {
    const replica = this.pickReplica();
    if (!replica) {
      return this.primary.query<R>(sql, params, 'read');
    }
    try {
      return await replica.pool.query<R>(sql, params, 'read');
    } catch (err) {
      // A replica failure should not fail the request — degrade to the primary.
      this.logger.warn(`Read on ${replica.pool.name} failed, falling back to primary`, err);
      replica.healthy = false;
      dbReplicaHealthy.set({ replica: replica.pool.name }, 0);
      return this.primary.query<R>(sql, params, 'read');
    }
  }

  /**
   * Round-robin selection across healthy replicas that satisfy the configured
   * staleness tolerance. Returns null to signal "use the primary".
   */
  private pickReplica(): ReplicaEntry | null {
    const maxLagMs = config.db.replica.maxLagMs;
    const candidates = this.replicas.filter(
      (r) => r.healthy && (maxLagMs === 0 || r.lagSeconds * 1000 <= maxLagMs),
    );
    if (candidates.length === 0) return null;
    const replica = candidates[this.replicaCursor % candidates.length];
    this.replicaCursor = (this.replicaCursor + 1) % candidates.length;
    return replica;
  }

  async initialize(): Promise<void> {
    try {
      const client = await this.primary.connect();
      try {
        await this.createSchema(client);
        if (config.useTimescale) {
          await this.enableTimescale(client);
        }
      } finally {
        client.release();
      }
      this.initialized = true;
      this.startReplicaHealthMonitor();
      this.startMetricsCollector();
      this.logger.info('PostgreSQL database initialized');
    } catch (err) {
      this.logger.error('Failed to initialize database', err);
      throw err;
    }
  }

  private async createSchema(client: PoolClient): Promise<void> {
    // PK includes `timestamp` so the table can become a TimescaleDB hypertable
    // partitioned on that integer time column (issue #42).
    await client.query(`
      CREATE TABLE IF NOT EXISTS price_history (
        id BIGSERIAL,
        asset VARCHAR(50) NOT NULL,
        price VARCHAR(255) NOT NULL,
        decimals INTEGER NOT NULL,
        source VARCHAR(100) NOT NULL,
        timestamp BIGINT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id, timestamp)
      );

      CREATE INDEX IF NOT EXISTS idx_price_history_asset ON price_history(asset);
      CREATE INDEX IF NOT EXISTS idx_price_history_timestamp ON price_history(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_price_history_asset_timestamp ON price_history(asset, timestamp DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_price_history_asset_source_ts
        ON price_history(asset, source, timestamp);
    `);
  }

  /**
   * Enable the TimescaleDB hypertable for price_history, falling back to a
   * plain indexed table when the extension is unavailable (issue #42).
   */
  private async enableTimescale(client: PoolClient): Promise<void> {
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE');
      await client.query(
        `SELECT create_hypertable(
           'price_history', 'timestamp',
           chunk_time_interval => 604800,
           if_not_exists => TRUE,
           migrate_data => TRUE
         )`,
      );
      this.timescaleEnabled = true;
      this.logger.info('TimescaleDB hypertable enabled on price_history');
    } catch (err) {
      this.timescaleEnabled = false;
      this.logger.warn('TimescaleDB not available — using a plain indexed table', err);
    }
  }

  isTimescaleEnabled(): boolean {
    return this.timescaleEnabled;
  }

  // ── Replica health monitoring & pool metrics (issues #44, #45) ─────────────

  private startReplicaHealthMonitor(): void {
    if (this.replicas.length === 0) return;
    const interval = config.db.replica.healthCheckIntervalMs;
    const check = async (): Promise<void> => {
      for (const replica of this.replicas) {
        const healthy = await replica.pool.ping();
        replica.healthy = healthy;
        dbReplicaHealthy.set({ replica: replica.pool.name }, healthy ? 1 : 0);
        if (healthy && config.db.replica.maxLagMs > 0) {
          replica.lagSeconds = await this.measureLag(replica);
          dbReplicaLagSeconds.set({ replica: replica.pool.name }, replica.lagSeconds);
        }
      }
    };
    void check();
    this.healthTimer = setInterval(() => void check(), interval);
    this.healthTimer.unref?.();
  }

  /** Best-effort replication lag estimate in seconds. */
  private async measureLag(replica: ReplicaEntry): Promise<number> {
    try {
      const res = await replica.pool.query<{ lag: string | null }>(
        `SELECT EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))::float8 AS lag`,
        [],
        'lag-check',
      );
      const lag = res.rows[0]?.lag;
      return lag == null ? 0 : Math.max(0, Number(lag));
    } catch {
      return 0;
    }
  }

  private startMetricsCollector(): void {
    const collect = (): void => {
      this.primary.collectMetrics();
      this.replicas.forEach((r) => r.pool.collectMetrics());
    };
    collect();
    this.metricsTimer = setInterval(collect, 5000);
    this.metricsTimer.unref?.();
  }

  /** Pool utilisation snapshot for admin/health endpoints. */
  getPoolStats(): { primary: PoolStats; replicas: PoolStats[] } {
    return {
      primary: this.primary.collectMetrics(),
      replicas: this.replicas.map((r) => r.pool.collectMetrics()),
    };
  }

  // ── Read helpers (routed to replicas) ──────────────────────────────────────

  async getHistoricalPrices(
    asset: string,
    from?: number,
    to?: number,
    limit = 100,
  ): Promise<PriceHistory[]> {
    if (!this.initialized) throw new Error('Database not initialized');

    try {
      let query = 'SELECT * FROM price_history WHERE asset = $1';
      const params: unknown[] = [asset];
      let paramIndex = 2;

      if (from) {
        query += ` AND timestamp >= $${paramIndex}`;
        params.push(from);
        paramIndex++;
      }

      if (to) {
        query += ` AND timestamp <= $${paramIndex}`;
        params.push(to);
        paramIndex++;
      }

      query += ` ORDER BY timestamp DESC LIMIT $${paramIndex}`;
      params.push(limit);

      const result = await this.readQuery(query, params);
      return result.rows
        .reverse()
        .map((row) => ({
          id: row.id,
          asset: row.asset,
          price: row.price,
          decimals: row.decimals,
          source: row.source,
          timestamp: row.timestamp,
          created_at: row.created_at,
        }));
    } catch (err) {
      this.logger.error('Failed to query price history', err);
      throw err;
    }
  }

  async getAllLatestPrices(): Promise<PriceHistory[]> {
    if (!this.initialized) throw new Error('Database not initialized');

    try {
      const result = await this.readQuery(`
        SELECT DISTINCT ON (asset) * FROM price_history
        ORDER BY asset, timestamp DESC
      `);
      return result.rows.map((row) => ({
        id: row.id,
        asset: row.asset,
        price: row.price,
        decimals: row.decimals,
        source: row.source,
        timestamp: row.timestamp,
        created_at: row.created_at,
      }));
    } catch (err) {
      this.logger.error('Failed to fetch all latest prices', err);
      throw err;
    }
  }

  async getLatestPrice(asset: string): Promise<PriceHistory | null> {
    if (!this.initialized) throw new Error('Database not initialized');

    try {
      const result = await this.readQuery(
        `SELECT * FROM price_history WHERE asset = $1 ORDER BY timestamp DESC LIMIT 1`,
        [asset],
      );
      if (result.rows.length === 0) return null;
      const row = result.rows[0];
      return {
        id: row.id,
        asset: row.asset,
        price: row.price,
        decimals: row.decimals,
        source: row.source,
        timestamp: row.timestamp,
        created_at: row.created_at,
      };
    } catch (err) {
      this.logger.error('Failed to fetch latest price', err);
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.metricsTimer) clearInterval(this.metricsTimer);
    await this.primary.end();
    await Promise.all(this.replicas.map((r) => r.pool.end()));
    this.logger.info('Database connection pools closed');
  }

  isInitialized(): boolean {
    return this.initialized;
  }
}

let _dbInstance: DatabaseClient | null = null;
let _dbAvailable = false;

export function setDb(db: DatabaseClient): void {
  _dbInstance = db;
  _dbAvailable = true;
}

export async function getDb(): Promise<DatabaseClient> {
  if (!_dbInstance) throw new Error('Database not initialized');
  return _dbInstance;
}

export function isDbAvailable(): boolean {
  return _dbAvailable;
}
