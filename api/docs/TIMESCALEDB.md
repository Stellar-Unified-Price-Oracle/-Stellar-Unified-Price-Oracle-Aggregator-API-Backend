# TimescaleDB Time-Series Storage (#42)

Historical price data is stored in PostgreSQL/TimescaleDB instead of JSON files.
TimescaleDB was selected over InfluxDB because the stack already uses PostgreSQL
(`pg`), so it reuses the existing connection pooling, SQL queries, and migration
tooling while adding hypertable partitioning, chunk exclusion, and retention
policies.

## Schema

The `price_history` table is partitioned into a hypertable on the integer
`timestamp` column (unix seconds) — the same column that time-range queries
filter on, so queries benefit from **chunk exclusion**:

```sql
CREATE TABLE price_history (
  id          BIGSERIAL,
  asset       VARCHAR(50)  NOT NULL,
  price       VARCHAR(255) NOT NULL,
  decimals    INTEGER      NOT NULL,
  source      VARCHAR(100) NOT NULL,
  timestamp   BIGINT       NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id, timestamp)
);

SELECT create_hypertable('price_history', 'timestamp',
  chunk_time_interval => 604800, migrate_data => TRUE, if_not_exists => TRUE);
```

Indexes optimized for the common access patterns:

- `idx_price_history_asset_timestamp (asset, timestamp DESC)` — latest/recent
  prices per asset and time-range scans.
- `idx_price_history_timestamp (timestamp DESC)` — global recent queries.
- `uq_price_history_asset_source_ts (asset, source, timestamp)` — idempotent
  inserts (used by the migration and `ON CONFLICT DO NOTHING`).

The PK includes `timestamp` because TimescaleDB requires the partitioning column
to be part of every unique index.

## Why it's faster than JSON

- **Chunk exclusion**: time-range queries only scan the chunks covering the
  requested window instead of reading and parsing the entire JSON file.
- **Indexed lookups**: per-asset and per-time indexes replace full-array scans.
- **No full-file rewrites**: appends are single-row inserts rather than reading,
  parsing, and rewriting the whole file on every poll.

## Graceful fallback

If the `timescaledb` extension is not installed, the services log a warning and
continue with a plain indexed PostgreSQL table (same schema, no hypertable).
Set `USE_TIMESCALEDB=false` to skip the hypertable step entirely.

## Migrating existing JSON data

```bash
# Requires DATABASE_URL to be set
tsx scripts/migrate-history-to-timescale.ts [optionalDataDir]
```

The migration:

- Scans `history-<asset>.json` files (repo `data/`, `services/aggregator/data/`,
  `api/data/`, or a directory you pass as an argument).
- Transparently decrypts files encrypted at rest (see SECURITY.md / #41).
- Inserts idempotently via `ON CONFLICT (asset, source, timestamp) DO NOTHING`,
  so it can be re-run without duplicating data.

## Backward compatibility

API responses are unchanged. `GET /api/v1/history/:asset` and
`GET /api/v1/prices` return the same shape; the storage layer
(`api/src/services/price-store.ts`) reads from the database when available and
falls back to JSON files otherwise.

## Configuration

```
DATABASE_URL=postgresql://user:password@localhost:5432/stellar_oracle
USE_TIMESCALEDB=true
TIMESCALE_CHUNK_INTERVAL_SECONDS=604800   # 7 days
HISTORY_RETENTION_DAYS=0                    # 0 = keep forever
```
