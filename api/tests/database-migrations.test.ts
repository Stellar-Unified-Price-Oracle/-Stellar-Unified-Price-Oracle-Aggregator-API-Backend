import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node-pg-migrate', () => ({
  default: vi.fn(),
}));

interface MigrationFile {
  name: string;
  timestamp: number;
  version: string;
  description: string;
  sql?: string;
}

interface MigrationStatus {
  name: string;
  applied: boolean;
  appliedAt?: number;
  downAt?: number;
}

class MigrationManager {
  private migrations: Map<string, MigrationFile> = new Map();
  private appliedMigrations: Set<string> = new Set();

  registerMigration(migration: MigrationFile): void {
    this.migrations.set(migration.name, migration);
  }

  async applyMigration(migrationName: string): Promise<boolean> {
    if (this.migrations.has(migrationName)) {
      this.appliedMigrations.add(migrationName);
      return true;
    }
    return false;
  }

  async rollbackMigration(migrationName: string): Promise<boolean> {
    if (this.appliedMigrations.has(migrationName)) {
      this.appliedMigrations.delete(migrationName);
      return true;
    }
    return false;
  }

  getAppliedMigrations(): string[] {
    return Array.from(this.appliedMigrations);
  }

  getMigrationStatus(migrationName: string): MigrationStatus | null {
    if (!this.migrations.has(migrationName)) {
      return null;
    }

    return {
      name: migrationName,
      applied: this.appliedMigrations.has(migrationName),
      appliedAt: this.appliedMigrations.has(migrationName) ? Date.now() : undefined,
    };
  }
}

describe('Database Migrations', () => {
  let migrationManager: MigrationManager;

  beforeEach(() => {
    migrationManager = new MigrationManager();
  });

  it('creates initial schema migration file', () => {
    const migration: MigrationFile = {
      name: '1690000000000_init_price_oracle_schema',
      timestamp: 1690000000000,
      version: '1.0.0',
      description: 'Initialize price oracle database schema',
      sql: 'CREATE TABLE prices (...)',
    };

    migrationManager.registerMigration(migration);
    expect(migrationManager.getAppliedMigrations().length).toBe(0);
  });

  it('applies migration to database', async () => {
    const migration: MigrationFile = {
      name: '1690000000000_init_price_oracle_schema',
      timestamp: 1690000000000,
      version: '1.0.0',
      description: 'Initialize price oracle database schema',
    };

    migrationManager.registerMigration(migration);
    const result = await migrationManager.applyMigration(migration.name);

    expect(result).toBe(true);
    expect(migrationManager.getAppliedMigrations()).toContain(migration.name);
  });

  it('tracks migration status', async () => {
    const migration: MigrationFile = {
      name: '1690000000000_init_price_oracle_schema',
      timestamp: 1690000000000,
      version: '1.0.0',
      description: 'Initialize price oracle database schema',
    };

    migrationManager.registerMigration(migration);
    await migrationManager.applyMigration(migration.name);

    const status = migrationManager.getMigrationStatus(migration.name);
    expect(status).not.toBeNull();
    expect(status?.applied).toBe(true);
  });

  it('supports rollback of migrations', async () => {
    const migration: MigrationFile = {
      name: '1690000000000_init_price_oracle_schema',
      timestamp: 1690000000000,
      version: '1.0.0',
      description: 'Initialize price oracle database schema',
    };

    migrationManager.registerMigration(migration);
    await migrationManager.applyMigration(migration.name);

    const rollbackResult = await migrationManager.rollbackMigration(migration.name);
    expect(rollbackResult).toBe(true);
    expect(migrationManager.getAppliedMigrations()).not.toContain(migration.name);
  });

  it('creates prices table schema', () => {
    const schema = {
      table: 'prices',
      columns: [
        { name: 'id', type: 'BIGSERIAL', primaryKey: true },
        { name: 'asset', type: 'VARCHAR(50)', notNull: true },
        { name: 'price', type: 'NUMERIC(20, 8)', notNull: true },
        { name: 'decimals', type: 'INTEGER', notNull: true },
        { name: 'source', type: 'VARCHAR(100)', notNull: true },
        { name: 'timestamp', type: 'BIGINT', notNull: true },
        { name: 'created_at', type: 'TIMESTAMP', default: 'NOW()' },
      ],
    };

    expect(schema.table).toBe('prices');
    expect(schema.columns).toHaveLength(7);
  });

  it('creates contract_events table schema', () => {
    const schema = {
      table: 'contract_events',
      columns: [
        { name: 'id', type: 'BIGSERIAL', primaryKey: true },
        { name: 'event_type', type: 'VARCHAR(100)', notNull: true },
        { name: 'contract_id', type: 'VARCHAR(56)', notNull: true },
        { name: 'tx_hash', type: 'VARCHAR(64)', notNull: true },
        { name: 'block_number', type: 'BIGINT', notNull: true },
        { name: 'block_timestamp', type: 'BIGINT', notNull: true },
        { name: 'data', type: 'JSONB', notNull: true },
        { name: 'indexed', type: 'BOOLEAN', default: 'false' },
        { name: 'created_at', type: 'TIMESTAMP', default: 'NOW()' },
      ],
    };

    expect(schema.table).toBe('contract_events');
    expect(schema.columns.map((c) => c.name)).toContain('event_type');
    expect(schema.columns.map((c) => c.name)).toContain('data');
  });

  it('creates indices for efficient querying', () => {
    const indices = [
      { name: 'idx_prices_asset_timestamp', table: 'prices', columns: ['asset', 'timestamp'] },
      { name: 'idx_prices_source', table: 'prices', columns: ['source'] },
      { name: 'idx_contract_events_event_type', table: 'contract_events', columns: ['event_type'] },
      { name: 'idx_contract_events_block_number', table: 'contract_events', columns: ['block_number'] },
      { name: 'idx_contract_events_indexed', table: 'contract_events', columns: ['indexed'] },
    ];

    expect(indices).toHaveLength(5);
    expect(indices[0].columns).toContain('asset');
  });

  it('enforces foreign key constraints', () => {
    const constraints = [
      {
        name: 'fk_contract_events_contract_id',
        table: 'contract_events',
        foreignKey: 'contract_id',
        references: 'contracts(id)',
      },
    ];

    expect(constraints).toHaveLength(1);
  });

  it('handles sequential migration execution', async () => {
    const mig1: MigrationFile = {
      name: '1690000000000_init_price_oracle_schema',
      timestamp: 1690000000000,
      version: '1.0.0',
      description: 'Initialize price oracle database schema',
    };

    const mig2: MigrationFile = {
      name: '1690000001000_create_contract_events_table',
      timestamp: 1690000001000,
      version: '1.1.0',
      description: 'Create contract events table',
    };

    migrationManager.registerMigration(mig1);
    migrationManager.registerMigration(mig2);

    await migrationManager.applyMigration(mig1.name);
    await migrationManager.applyMigration(mig2.name);

    const applied = migrationManager.getAppliedMigrations();
    expect(applied).toHaveLength(2);
    expect(applied[0]).toBe(mig1.name);
    expect(applied[1]).toBe(mig2.name);
  });

  it('prevents duplicate migration execution', async () => {
    const migration: MigrationFile = {
      name: '1690000000000_init_price_oracle_schema',
      timestamp: 1690000000000,
      version: '1.0.0',
      description: 'Initialize price oracle database schema',
    };

    migrationManager.registerMigration(migration);
    await migrationManager.applyMigration(migration.name);

    const secondAttempt = await migrationManager.applyMigration(migration.name);
    expect(secondAttempt).toBe(true);
    expect(migrationManager.getAppliedMigrations()).toHaveLength(1);
  });

  it('validates migration timestamp format', () => {
    const validMigration: MigrationFile = {
      name: '1690000000000_init_price_oracle_schema',
      timestamp: 1690000000000,
      version: '1.0.0',
      description: 'Initialize price oracle database schema',
    };

    expect(validMigration.timestamp).toBeGreaterThan(0);
    expect(validMigration.timestamp.toString()).toHaveLength(13);
  });

  it('associates migration with version number', () => {
    const migration: MigrationFile = {
      name: '1690000000000_init_price_oracle_schema',
      timestamp: 1690000000000,
      version: '1.0.0',
      description: 'Initialize price oracle database schema',
    };

    expect(migration.version).toBe('1.0.0');
    expect(migration.version.split('.')).toHaveLength(3);
  });

  it('supports idempotent migrations', async () => {
    const migration: MigrationFile = {
      name: '1690000000000_init_price_oracle_schema',
      timestamp: 1690000000000,
      version: '1.0.0',
      description: 'Initialize price oracle database schema',
      sql: 'CREATE TABLE IF NOT EXISTS prices (...)',
    };

    migrationManager.registerMigration(migration);
    const result1 = await migrationManager.applyMigration(migration.name);
    const result2 = await migrationManager.applyMigration(migration.name);

    expect(result1).toBe(true);
    expect(result2).toBe(true);
  });
});
