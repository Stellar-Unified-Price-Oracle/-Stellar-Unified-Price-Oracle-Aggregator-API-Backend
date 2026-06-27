import { Pool, PoolClient } from 'pg';
import { Logger } from 'winston';

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

  async query(sql: string, params?: any[]): Promise<{ rows: any[]; rowCount?: number | null }> {
    return this.pool.query(sql, params);
  }

  async initialize(): Promise<void> {
    try {
      const client = await this.pool.connect();
      await this.createSchema(client);
      client.release();
      this.initialized = true;
      this.logger.info('PostgreSQL database initialized');
    } catch (err) {
      this.logger.error('Failed to initialize database', err);
      throw err;
    }
  }

  private async createSchema(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS price_history (
        id SERIAL PRIMARY KEY,
        asset VARCHAR(50) NOT NULL,
        price VARCHAR(255) NOT NULL,
        decimals INTEGER NOT NULL,
        source VARCHAR(100) NOT NULL,
        timestamp BIGINT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_price_history_asset ON price_history(asset);
      CREATE INDEX IF NOT EXISTS idx_price_history_timestamp ON price_history(timestamp);
      CREATE INDEX IF NOT EXISTS idx_price_history_asset_timestamp ON price_history(asset, timestamp);
    `);
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

  async disconnect(): Promise<void> {
    await this.pool.end();
    this.logger.info('Database connection pool closed');
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
