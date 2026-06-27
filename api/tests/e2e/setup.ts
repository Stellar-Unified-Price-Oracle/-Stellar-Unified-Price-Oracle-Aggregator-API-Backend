import { Client } from 'pg';
import { startTestContainers, stopTestContainers, getTestContainers } from '../setup/test-containers';
import { initializeDatabase, closeDatabase, queryDatabase } from '../../src/services/database';
import { logger } from '../../src/middleware/logger';

let setupDone = false;
let setupPromise: Promise<void> | null = null;

async function createTablesIfNotExists(): Promise<void> {
  const createTablesSql = `
    -- Assets table
    CREATE TABLE IF NOT EXISTS assets (
      id SERIAL PRIMARY KEY,
      code VARCHAR(20) NOT NULL UNIQUE,
      name VARCHAR(255) NOT NULL,
      decimals SMALLINT NOT NULL DEFAULT 7,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Oracle sources table
    CREATE TABLE IF NOT EXISTS oracle_sources (
      id SERIAL PRIMARY KEY,
      code VARCHAR(50) NOT NULL UNIQUE,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Price data table
    CREATE TABLE IF NOT EXISTS price_data (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      asset_id INTEGER NOT NULL REFERENCES assets ON DELETE CASCADE,
      source_id INTEGER NOT NULL REFERENCES oracle_sources ON DELETE CASCADE,
      price NUMERIC(24,8) NOT NULL,
      timestamp TIMESTAMP NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Price history table
    CREATE TABLE IF NOT EXISTS price_history (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      asset_id INTEGER NOT NULL REFERENCES assets ON DELETE CASCADE,
      price NUMERIC(24,8) NOT NULL,
      decimals SMALLINT NOT NULL,
      source_count SMALLINT NOT NULL,
      timestamp TIMESTAMP NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Source health table
    CREATE TABLE IF NOT EXISTS source_health (
      id SERIAL PRIMARY KEY,
      source_id INTEGER NOT NULL UNIQUE REFERENCES oracle_sources ON DELETE CASCADE,
      last_successful_fetch TIMESTAMP,
      last_failed_fetch TIMESTAMP,
      consecutive_failures SMALLINT NOT NULL DEFAULT 0,
      error_message TEXT,
      healthy BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Create indexes if not exists
    CREATE INDEX IF NOT EXISTS idx_assets_code ON assets(code);
    CREATE INDEX IF NOT EXISTS idx_oracle_sources_code ON oracle_sources(code);
    CREATE INDEX IF NOT EXISTS idx_price_data_asset_source ON price_data(asset_id, source_id);
    CREATE INDEX IF NOT EXISTS idx_price_data_created_at ON price_data(created_at);
    CREATE INDEX IF NOT EXISTS idx_price_data_timestamp ON price_data(timestamp);
    CREATE INDEX IF NOT EXISTS idx_price_history_asset_timestamp ON price_history(asset_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_price_history_created_at ON price_history(created_at);
  `;

  try {
    await queryDatabase(createTablesSql);
    logger.info('Database tables created/verified');
  } catch (error) {
    logger.error('Failed to create tables', { error });
    throw error;
  }
}

export async function setupE2E() {
  if (setupDone) {
    return getTestContainers();
  }

  if (setupPromise) {
    await setupPromise;
    return getTestContainers();
  }

  setupPromise = (async () => {
    try {
      const containers = await startTestContainers();

      await initializeDatabase({
        url: containers.postgresUrl,
        poolMin: 1,
        poolMax: 5,
      });

      await createTablesIfNotExists();

      setupDone = true;
    } finally {
      setupPromise = null;
    }
  })();

  await setupPromise;
  return getTestContainers();
}

export async function teardownE2E() {
  if (setupDone) {
    await closeDatabase();
    await stopTestContainers();
    setupDone = false;
  }
}

export function getE2EContainers() {
  return getTestContainers();
}
