/* eslint-disable @typescript-eslint/no-explicit-any */
import { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions = {
  id: { type: 'uuid', primaryKey: true, default: 'gen_random_uuid()' },
  createdAt: { type: 'timestamp', notNull: true, default: 'CURRENT_TIMESTAMP' },
  updatedAt: { type: 'timestamp', notNull: true, default: 'CURRENT_TIMESTAMP' },
};

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Enable required extensions
  pgm.createExtension('uuid-ossp', { ifNotExists: true });
  pgm.createExtension('pg_trgm', { ifNotExists: true });

  // Assets table - for supported asset codes
  pgm.createTable('assets', {
    id: { type: 'serial', primaryKey: true },
    code: { type: 'varchar(20)', notNull: true, unique: true, comment: 'Asset code (e.g., XLM, BTC)' },
    name: { type: 'varchar(255)', notNull: true, comment: 'Human-readable asset name' },
    decimals: { type: 'smallint', notNull: true, default: 7, comment: 'Price decimal places' },
    enabled: { type: 'boolean', notNull: true, default: true, comment: 'Whether to track this asset' },
    created_at: { type: 'timestamp', notNull: true, default: 'CURRENT_TIMESTAMP' },
    updated_at: { type: 'timestamp', notNull: true, default: 'CURRENT_TIMESTAMP' },
  });

  pgm.createIndex('assets', 'code');

  // Oracle sources table - for tracking price data sources
  pgm.createTable('oracle_sources', {
    id: { type: 'serial', primaryKey: true },
    code: { type: 'varchar(50)', notNull: true, unique: true, comment: 'Source identifier (e.g., chainlink, redstone)' },
    name: { type: 'varchar(255)', notNull: true, comment: 'Human-readable source name' },
    description: { type: 'text', comment: 'Source description' },
    enabled: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamp', notNull: true, default: 'CURRENT_TIMESTAMP' },
    updated_at: { type: 'timestamp', notNull: true, default: 'CURRENT_TIMESTAMP' },
  });

  pgm.createIndex('oracle_sources', 'code');

  // Price data table - stores the latest price from each source
  pgm.createTable('price_data', {
    id: { type: 'uuid', primaryKey: true, default: 'gen_random_uuid()' },
    asset_id: {
      type: 'integer',
      notNull: true,
      references: 'assets',
      onDelete: 'CASCADE',
    },
    source_id: {
      type: 'integer',
      notNull: true,
      references: 'oracle_sources',
      onDelete: 'CASCADE',
    },
    price: {
      type: 'numeric(24,8)',
      notNull: true,
      comment: 'Price value in USD',
    },
    timestamp: {
      type: 'timestamp',
      notNull: true,
      comment: 'Timestamp when price was published',
    },
    created_at: { type: 'timestamp', notNull: true, default: 'CURRENT_TIMESTAMP' },
  });

  pgm.createIndex('price_data', ['asset_id', 'source_id']);
  pgm.createIndex('price_data', ['created_at']);
  pgm.createIndex('price_data', ['timestamp']);

  // Price history table - stores historical aggregated prices
  pgm.createTable('price_history', {
    id: { type: 'uuid', primaryKey: true, default: 'gen_random_uuid()' },
    asset_id: {
      type: 'integer',
      notNull: true,
      references: 'assets',
      onDelete: 'CASCADE',
    },
    price: {
      type: 'numeric(24,8)',
      notNull: true,
      comment: 'Aggregated median price',
    },
    decimals: {
      type: 'smallint',
      notNull: true,
      comment: 'Price decimal places',
    },
    source_count: {
      type: 'smallint',
      notNull: true,
      comment: 'Number of sources used for aggregation',
    },
    timestamp: {
      type: 'timestamp',
      notNull: true,
      comment: 'Price snapshot timestamp',
    },
    created_at: { type: 'timestamp', notNull: true, default: 'CURRENT_TIMESTAMP' },
  });

  pgm.createIndex('price_history', ['asset_id', 'timestamp']);
  pgm.createIndex('price_history', ['created_at']);

  // Source health table - tracks source health metrics
  pgm.createTable('source_health', {
    id: { type: 'serial', primaryKey: true },
    source_id: {
      type: 'integer',
      notNull: true,
      unique: true,
      references: 'oracle_sources',
      onDelete: 'CASCADE',
    },
    last_successful_fetch: {
      type: 'timestamp',
      comment: 'Timestamp of last successful data fetch',
    },
    last_failed_fetch: {
      type: 'timestamp',
      comment: 'Timestamp of last failed fetch',
    },
    consecutive_failures: {
      type: 'smallint',
      notNull: true,
      default: 0,
    },
    error_message: { type: 'text', comment: 'Last error message' },
    healthy: { type: 'boolean', notNull: true, default: true },
    updated_at: { type: 'timestamp', notNull: true, default: 'CURRENT_TIMESTAMP' },
  });

  // Migrations table is automatically created by node-pg-migrate
  // This table is used to track applied migrations
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('source_health', { ifExists: true });
  pgm.dropTable('price_history', { ifExists: true });
  pgm.dropTable('price_data', { ifExists: true });
  pgm.dropTable('oracle_sources', { ifExists: true });
  pgm.dropTable('assets', { ifExists: true });
}
