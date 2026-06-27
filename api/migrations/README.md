# Database Migrations

This directory contains all database schema migrations for the Stellar Price Oracle API.

## Running Migrations

### Automatic Migration (Recommended)

Migrations are automatically run during application startup if the `DATABASE_URL` environment variable is set.

### Manual Migration

Run migrations manually using the migration CLI:

```bash
# Run all pending migrations
npm run migrate:up

# Revert the last migration
npm run migrate:down

# Check migration status
npm run migrate:status
```

## Creating a New Migration

To create a new migration file:

```bash
npm run migrate:create -- <migration_name>
```

This will create a new migration file in this directory with the timestamp prefix.

### Migration File Structure

Each migration file exports `up()` and `down()` functions:

```typescript
export async function up(pgm: MigrationBuilder): Promise<void> {
  // Create tables, indexes, columns, etc.
  pgm.createTable('my_table', { /* columns */ });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Rollback changes
  pgm.dropTable('my_table');
}
```

## Schema Overview

### Core Tables

- **assets** - Supported asset codes (XLM, BTC, ETH, etc.)
- **oracle_sources** - Price data sources (Chainlink, Redstone, etc.)
- **price_data** - Latest price from each source
- **price_history** - Historical aggregated prices
- **source_health** - Source health tracking

## Environment Variables

Ensure the following is set in your `.env`:

```
DATABASE_URL=postgresql://user:password@localhost:5432/stellar_oracle
DATABASE_POOL_MIN=2
DATABASE_POOL_MAX=10
```

## Troubleshooting

If migrations fail:

1. Check database connectivity: `psql $DATABASE_URL -c "SELECT 1"`
2. Verify PostgreSQL extensions are installed
3. Check application logs for detailed error messages
4. Review the migration files for syntax errors
