# Runbook: Disaster Recovery

**Severity:** P0

This runbook covers recovery procedures for catastrophic failure scenarios: database loss, a bad contract deployment, key compromise, and data corruption.

## 1. Database restore from backup

**Symptoms:** PostgreSQL/TimescaleDB instance is unreachable, corrupted, or has been dropped.

1. Confirm the outage is unrecoverable (see [database-issues.md](database-issues.md) for transient connectivity problems first).
2. Identify the latest known-good backup:
   ```bash
   # Managed Postgres (e.g. RDS/Cloud SQL) — list available snapshots
   aws rds describe-db-snapshots --db-instance-identifier stellar-oracle-db --query 'DBSnapshots[].[DBSnapshotIdentifier,SnapshotCreateTime]' --output table
   ```
3. Restore into a new instance rather than overwriting the failed one:
   ```bash
   aws rds restore-db-instance-from-db-snapshot \
     --db-instance-identifier stellar-oracle-db-restored \
     --db-snapshot-identifier <snapshot-id>
   ```
4. Point `DATABASE_URL` at the restored instance and restart the API and aggregator services.
5. Verify `USE_TIMESCALEDB` hypertables and continuous aggregates rebuilt correctly (`SELECT * FROM timescaledb_information.hypertables;`).
6. Backfill the gap between the backup timestamp and the outage start from oracle source history if sources retain it, otherwise document the gap.

## 2. Contract rollback to previous implementation

**Symptoms:** A newly deployed Soroban contract version is rejecting valid submissions, corrupting on-chain state, or behaving unexpectedly.

1. Freeze writes: pause the aggregator's push loop (`make dev-aggregator` off, or scale the aggregator deployment to 0 replicas) so no further submissions hit the bad contract.
2. Identify the previous working WASM hash from the deployment history / release tags.
3. Redeploy the previous contract version to a new contract ID (Soroban contracts are immutable once deployed):
   ```bash
   soroban contract deploy \
     --wasm target/wasm32-unknown-unknown/release/price_oracle_<previous-tag>.wasm \
     --source $ADMIN_SECRET_KEY \
     --network testnet
   ```
4. Update `CONTRACT_ID` in the environment config for the API and aggregator to the new deployment.
5. Re-authorize oracle sources on the restored contract (`add_oracle_source`) — authorization state does not carry over between deployments.
6. Resume the aggregator's push loop and verify prices are flowing via `GET /api/v1/prices`.
7. File a follow-up issue for the root cause before re-attempting the failed upgrade.

## 3. Key rotation emergency

**Symptoms:** `ADMIN_SECRET_KEY` or an oracle source's signing key is suspected compromised.

1. Immediately revoke the compromised source's authorization on-chain if it is an oracle source key:
   ```bash
   soroban contract invoke --id $CONTRACT_ID --source $ADMIN_SECRET_KEY -- remove_oracle_source --source <compromised-address>
   ```
2. If the **admin** key itself is compromised, this cannot be remediated on the existing contract (admin is fixed at `initialize`). Follow the contract rollback procedure (§2) to redeploy under a new admin key.
3. Generate a new key pair and store it in the secrets manager (never commit to `.env` or version control).
4. Rotate the key in all deployment environments (dev/staging/prod) and restart affected services.
5. Audit recent on-chain activity for unauthorized submissions made with the compromised key before it was revoked.

## 4. Data corruption recovery

**Symptoms:** Price history contains impossible values (negative prices, zero timestamps, decimals mismatches) not caused by a live source outage.

1. Identify the corrupted range:
   ```sql
   SELECT asset, timestamp, price, decimals FROM price_history
   WHERE price <= 0 OR timestamp <= 0
   ORDER BY timestamp DESC;
   ```
2. Quarantine (do not delete) affected rows into a `price_history_quarantine` table for post-incident analysis.
3. Restore the affected time range from the most recent clean backup (see §1) or recompute from raw source responses if request/response logging was enabled.
4. Re-run any downstream aggregates or caches covering the corrupted range so consumers don't see stale/bad derived data (`CACHE_TTL_MS`, `HISTORY_CACHE_TTL_MS` windows).
5. Add a regression check for the specific corruption pattern found (e.g. a `CHECK (price > 0)` constraint) so recurrence is caught at write time.

---

See also: [database-issues.md](database-issues.md), [contract-failures.md](contract-failures.md), [post-mortem-template.md](post-mortem-template.md).
