# Zero-Downtime Schema Migrations

The migration framework models every change as a reversible script with a monotonic `schema_version`, `up`, `down`, and compatibility check. It supports add field, remove field, rename field, type change, and restructure migrations.

Rollout policy:

1. Deploy the migration in dark-read mode for at least `SCHEMA_DARK_READ_HOURS`, default 24.
2. Parse records through the legacy and candidate readers.
3. Compare results and checksums without serving candidate results.
4. Roll back automatically if error rate exceeds 1%, p99 latency regresses by more than 10%, or integrity checks mismatch.
5. Run throttled compaction after activation, retaining old-format data for the configured retention window.

CI should run representative forward migration, rollback, and checksum verification samples before enabling a migration in production.
