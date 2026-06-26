import { Pool, Client } from 'pg';
import path from 'path';
import { logger } from '../middleware/logger';

export interface DatabaseConfig {
  url: string;
  poolMin?: number;
  poolMax?: number;
}

let pool: Pool | null = null;

export async function initializeDatabase(config: DatabaseConfig): Promise<Pool> {
  if (pool) {
    return pool;
  }

  pool = new Pool({
    connectionString: config.url,
    min: config.poolMin || 2,
    max: config.poolMax || 10,
  });

  pool.on('error', (err) => {
    logger.error('Unexpected database pool error', { error: err.message });
  });

  try {
    const client = await pool.connect();
    await client.query('SELECT NOW()');
    client.release();
    logger.info('Database connection established');
  } catch (error) {
    logger.error('Failed to connect to database', { error });
    throw error;
  }

  return pool;
}

export function getDatabase(): Pool {
  if (!pool) {
    throw new Error('Database not initialized. Call initializeDatabase first.');
  }
  return pool;
}

export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    logger.info('Database connection closed');
  }
}

export async function runMigrations(databaseUrl: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const migrate = require('node-pg-migrate');
  const migrationsPath = path.join(__dirname, '../../migrations');

  const client = new Client({ connectionString: databaseUrl });

  try {
    await client.connect();
    logger.info('Running database migrations...');

    const migrations = await migrate.default({
      dbClient: client,
      dir: migrationsPath,
      direction: 'up',
      log: (msg: string) => logger.info(msg),
    });

    logger.info(`Applied ${migrations.length} migrations`);
  } catch (error) {
    logger.error('Migration failed', { error });
    throw error;
  } finally {
    await client.end();
  }
}

export async function queryDatabase(
  query: string,
  params?: unknown[],
): Promise<{ rows: unknown[]; rowCount: number }> {
  const db = getDatabase();
  const result = await db.query(query, params);
  return {
    rows: result.rows,
    rowCount: result.rowCount || 0,
  };
}
