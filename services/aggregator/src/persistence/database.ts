import { Pool, PoolClient } from 'pg';
import { Logger } from 'winston';
import { config } from '../infrastructure/config';

export interface PriceHistory {
  id?: number;
  asset: string;
  price: string;
  decimals: number;
  source: string;
  timestamp: number;
  created_at?: Date;
}

export class DatabaseClient {
  private pool: Pool;
  private logger: Logger;
  private initialized: boolean = false;
  private timescaleEnabled: boolean = false;

  constructor(databaseUrl: string, logger: Logger) {
    this.logger = logger;
    this.pool = new Pool({
      connectionString: databaseUrl,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });

    this.pool.on('error', (err) => {
      this.logger.error('Unexpected error on idle client', err);
    });
  }

  async initialize(): Promise<void> {
    try {
      const client = await this.pool.connect();
      await this.createSchema(client);
      if (config.database.useTimescale) {
        await this.enableTimescale(client);
      }
      client.release();
      this.initialized = true;
      this.logger.info('PostgreSQL database initialized');
    } catch (err) {
      this.logger.error('Failed to initialize database', err);
      throw err;
    }
  }

  private async createSchema(client: PoolClient): Promise<void> {
    // The primary key includes `timestamp` because TimescaleDB requires the
    // partitioning (time) column to be part of every unique index.
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

      -- De-duplicate identical samples so JSON migration can be re-run idempotently.
      CREATE UNIQUE INDEX IF NOT EXISTS uq_price_history_asset_source_ts
        ON price_history(asset, source, timestamp);
    `);
  }

  /**
   * Convert price_history into a TimescaleDB hypertable partitioned on the
   * integer `timestamp` column (issue #42). Falls back gracefully to a plain
   * indexed table when the timescaledb extension is not installed.
   */
  private async enableTimescale(client: PoolClient): Promise<void> {
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE');

      // Integer time dimension: chunk_time_interval is expressed in the same
      // unit as `timestamp` (unix seconds).
      await client.query(
        `SELECT create_hypertable(
           'price_history', 'timestamp',
           chunk_time_interval => $1,
           if_not_exists => TRUE,
           migrate_data => TRUE
         )`,
        [config.database.chunkIntervalSeconds],
      );

      this.timescaleEnabled = true;
      this.logger.info('TimescaleDB hypertable enabled on price_history');

      if (config.database.retentionDays > 0) {
        const retentionSeconds = config.database.retentionDays * 24 * 60 * 60;
        await client.query(
          `SELECT add_retention_policy('price_history', drop_after => $1::bigint, if_not_exists => TRUE)`,
          [retentionSeconds],
        );
        this.logger.info(`TimescaleDB retention policy set to ${config.database.retentionDays} days`);
      }
    } catch (err) {
      this.timescaleEnabled = false;
      this.logger.warn(
        'TimescaleDB not available — continuing with a plain indexed table. ' +
          'Install the timescaledb extension for time-series optimizations.',
        err,
      );
    }
  }

  isTimescaleEnabled(): boolean {
    return this.timescaleEnabled;
  }

  async appendHistoricalPrice(
    asset: string,
    price: string,
    decimals: number,
    source: string,
    timestamp: number,
  ): Promise<void> {
    if (!this.initialized) throw new Error('Database not initialized');

    try {
      await this.pool.query(
        `INSERT INTO price_history (asset, price, decimals, source, timestamp)
         VALUES ($1, $2, $3, $4, $5)`,
        [asset, price, decimals, source, timestamp],
      );
    } catch (err) {
      this.logger.error('Failed to insert price history', err);
      throw err;
    }
  }

  async getHistoricalPrices(
    asset: string,
    from?: number,
    to?: number,
    limit = 100,
  ): Promise<PriceHistory[]> {
    if (!this.initialized) throw new Error('Database not initialized');

    try {
      let query = 'SELECT * FROM price_history WHERE asset = $1';
      const params: any[] = [asset];
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

      const result = await this.pool.query(query, params);
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
      const result = await this.pool.query(`
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
      const result = await this.pool.query(
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

  async clearOldEntries(olderThanDays: number = 30): Promise<number> {
    if (!this.initialized) throw new Error('Database not initialized');

    try {
      const result = await this.pool.query(
        `DELETE FROM price_history WHERE created_at < NOW() - INTERVAL '${olderThanDays} days'`,
      );
      return result.rowCount || 0;
    } catch (err) {
      this.logger.error('Failed to clear old entries', err);
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    await this.pool.end();
    this.logger.info('Database connection pool closed');
  }

  isInitialized(): boolean {
    return this.initialized;
  }
}
