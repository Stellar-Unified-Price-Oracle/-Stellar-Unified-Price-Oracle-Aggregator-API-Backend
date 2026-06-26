import { logger } from '../middleware/logger';

let dbAvailable = false;
let pgPool: any = null;

export interface DatabaseConfig {
  enabled: boolean;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export function getDatabaseConfig(): DatabaseConfig {
  return {
    enabled: process.env.DATABASE_ENABLED !== 'false' && !!process.env.DATABASE_URL,
    host: process.env.DATABASE_HOST || 'localhost',
    port: parseInt(process.env.DATABASE_PORT || '5432', 10),
    database: process.env.DATABASE_NAME || 'stellar_oracle',
    user: process.env.DATABASE_USER || 'postgres',
    password: process.env.DATABASE_PASSWORD || '',
  };
}

export async function initializeDatabase(): Promise<void> {
  const config = getDatabaseConfig();

  if (!config.enabled) {
    logger.info('Database disabled — using file-based storage');
    dbAvailable = false;
    return;
  }

  try {
    // Lazy load pg only if needed (optional dependency)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    let Pool: any;
    try {
      // @ts-ignore - pg is an optional dependency
      // eslint-disable-next-line global-require
      const pg = require('pg');
      Pool = pg.Pool;
    } catch (importError) {
      logger.warn('PostgreSQL driver not installed. To enable database support, run: npm install pg');
      dbAvailable = false;
      return;
    }

    pgPool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });

    // Test connection
    const client = await pgPool.connect();
    await client.query('SELECT NOW()');
    client.release();

    await createSchema();
    dbAvailable = true;
    logger.info('Database connection established');
  } catch (error) {
    logger.error('Failed to initialize database:', error);
    dbAvailable = false;
  }
}

export function isDbAvailable(): boolean {
  return dbAvailable && pgPool !== null;
}

export async function getDb() {
  if (!pgPool) {
    throw new Error('Database not initialized');
  }
  return pgPool;
}

export async function createSchema(): Promise<void> {
  if (!isDbAvailable()) return;

  try {
    const db = await getDb();

    // Price history table
    await db.query(`
      CREATE TABLE IF NOT EXISTS price_history (
        id SERIAL PRIMARY KEY,
        asset VARCHAR(56) NOT NULL,
        price NUMERIC(30, 18) NOT NULL,
        decimals INTEGER NOT NULL,
        source VARCHAR(50) NOT NULL,
        timestamp INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (asset, source, timestamp)
      )
    `).catch(() => { /* table might exist */ });

    // Source metadata table
    await db.query(`
      CREATE TABLE IF NOT EXISTS source_metadata (
        id SERIAL PRIMARY KEY,
        source VARCHAR(50) NOT NULL UNIQUE,
        name VARCHAR(100),
        type VARCHAR(50),
        website VARCHAR(255),
        last_update TIMESTAMP,
        is_active BOOLEAN DEFAULT true
      )
    `).catch(() => { /* table might exist */ });

    // Aggregator state table
    await db.query(`
      CREATE TABLE IF NOT EXISTS aggregator_state (
        id SERIAL PRIMARY KEY,
        asset VARCHAR(56) NOT NULL UNIQUE,
        latest_price NUMERIC(30, 18),
        latest_timestamp INTEGER,
        confidence NUMERIC(5, 2),
        active_sources TEXT,
        last_update TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `).catch(() => { /* table might exist */ });

    // Create indexes
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_price_history_asset_timestamp
      ON price_history(asset, timestamp DESC)
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_price_history_source_timestamp
      ON price_history(source, timestamp DESC)
    `);

    logger.info('Database schema created/verified');
  } catch (error) {
    logger.error('Failed to create schema:', error);
    throw error;
  }
}

export async function closeDatabase(): Promise<void> {
  if (pgPool) {
    await pgPool.end();
    pgPool = null;
    dbAvailable = false;
  }
}
