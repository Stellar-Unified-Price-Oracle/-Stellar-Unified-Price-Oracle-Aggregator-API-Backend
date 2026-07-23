# Recovery Procedures

Detailed, scenario-by-scenario recovery steps. Read [README.md](README.md) first for the
tier overview and recovery targets (RTO < 1h, RPO < 5min).

All commands assume `kubectl` is configured against the target cluster/namespace
(`stellar-oracle-<env>`) and you have an admin API key for the backend
(`ADMIN_API_KEY`).

## Before you start

1. **Declare the incident** — confirm with the incident commander this is a DR event, not
   something the [runbooks](../runbooks/README.md) already cover (check
   [database-issues.md](../runbooks/database-issues.md) first — most connectivity/pool
   problems are not a DR event and self-heal via the circuit breaker).
2. **Freeze writes** — scale the aggregator to 0 so nothing writes to the database mid-restore:
   ```bash
   kubectl -n stellar-oracle-<env> scale deployment aggregator --replicas=0
   ```
3. **Record T0** — the timestamp recovery started. Every script in `scripts/dr/` prints
   elapsed time on exit; the drill report captures it automatically.

---

## Scenario: Data corruption / accidental delete (Tier 1 — PITR)

**Symptoms**: bad rows/tables, a migration or admin action that shouldn't have run,
`data-consistency` alerts firing with no infrastructure fault.

```bash
# 1. Identify the target recovery time (just before the bad event)
TARGET_TIME="2026-07-23T14:32:00Z"

# 2. Run the PITR restore
./scripts/dr/restore-pitr.sh <env> "$TARGET_TIME"

# 3. Script handles: scale down writers, snapshot current (bad) state for forensics,
#    provision a recovery pod from the latest base backup, replay WAL to $TARGET_TIME,
#    promote, verify readiness, scale writers back up.
```

**Verification**:
```bash
kubectl -n stellar-oracle-<env> exec -it statefulset/timescaledb -- \
  psql -U oracle -d stellar_oracle -c "SELECT max(observed_at) FROM price_history;"
# Confirm the corrupted rows are gone and the max timestamp is just before $TARGET_TIME
curl -sf https://<env>.api/api/v1/health
```

**Estimated RTO**: 10–20 minutes. **RPO**: ≤ 60 seconds of data between the corruption and
the last archived WAL segment.

---

## Scenario: Database pod/PVC failure, cluster otherwise healthy (Tier 1)

**Symptoms**: `timescaledb-0` won't start, PVC shows `FailedAttachVolume` or filesystem
corruption in pod logs.

```bash
# If the PVC itself is unreadable, skip straight to Tier 2 (below).
# Otherwise:
./scripts/dr/restore-pitr.sh <env> latest
```
`latest` replays WAL to the most recent archived segment instead of a specific timestamp
— minimal data loss, no manual timestamp needed.

---

## Scenario: Full cluster / namespace / all-PVCs loss (Tier 2 — full recovery)

**Symptoms**: namespace deleted, all PVCs gone, region-level outage, or Tier 1's
`wal-archive`/`base-backups` volumes are also unavailable.

```bash
./scripts/dr/recover.sh <env>
```

This orchestrates:

1. Re-applies all k8s manifests for `<env>` (`kustomize build k8s/overlays/<env> | kubectl apply`)
   — recreates namespace, StatefulSet, Deployments, Services from version control.
2. Waits for the new `timescaledb` pod to become ready (fresh, empty database).
3. Fetches the latest encrypted snapshot via `POST /api/v1/admin/backup/list`, downloads
   it, and restores via `POST /api/v1/admin/backup/restore`.
4. Redeploys the last known-good API/aggregator images
   (same image-resolution logic as [`rollback.yml`](../../.github/workflows/rollback.yml)).
5. Runs health checks against `/api/v1/health` and `/metrics` until they pass or the
   script times out (default 45 minutes).

**Manual fallback** (if the admin API itself is unreachable because the API tier is also
down): run steps 3–4 by hand using `scripts/deploy-k8s.sh <env> <api-image> <aggregator-image>`
to bring the API back first, then call the `/admin/backup/*` endpoints directly with `curl`.

**Estimated RTO**: 30–45 minutes. **RPO**: bounded by `BACKUP_INTERVAL_MS` — see
[Tier 2 configuration](#tier-2-configuration) below.

### Tier 2 configuration

`BackupService`'s snapshot cadence is controlled by `BACKUP_INTERVAL_MS`
(`api/src/config.ts`, default `86400000` = 24h). To keep Tier 2 alone under the 5-minute
RPO target — i.e. even if Tier 1's WAL archive is unavailable — set:

```bash
BACKUP_ENABLED=true
BACKUP_INTERVAL_MS=300000   # 5 minutes
BACKUP_ENCRYPTION_KEY=<64-char hex>
```

This is a tradeoff: more frequent `pg_dump` runs cost more I/O and storage. In practice
Tier 1 (WAL + hourly base backups) is the primary path and gets you RPO ≤ 60s; the 5-minute
Tier 2 interval is a defense-in-depth backstop for the case where both the primary volume
*and* the WAL archive are lost simultaneously (e.g. whole-cluster deletion).

---

## Scenario: Backup storage itself is lost or corrupted

**Symptoms**: `GET /api/v1/admin/dr/status` shows no recent backups, or
`POST /api/v1/admin/backup/test-restore` fails.

1. Page immediately — this means the DR safety net itself has a hole; treat as P1 even if
   the live system is healthy.
2. Check `dr_rpo_seconds` in Grafana to see how long backups have been silently failing.
3. Fix the underlying cause (disk full, PVC detached, encryption key rotated without
   updating `BACKUP_ENCRYPTION_KEY`, etc).
4. Trigger `POST /api/v1/admin/backup/run` manually and confirm
   `POST /api/v1/admin/backup/test-restore` passes before standing down.
5. File a post-mortem regardless of whether an actual disaster occurred — a silent backup
   gap is a near-miss.

---

## Scenario: Credential / secret compromise

**Symptoms**: leaked `ADMIN_SECRET_KEY`, database credentials, or `BACKUP_ENCRYPTION_KEY`.

1. Rotate the affected secret(s) in the k8s secret store
   (`kubectl -n stellar-oracle-<env> create secret ... --dry-run=client -o yaml | kubectl apply -f -`).
2. Restart affected deployments to pick up the new secret:
   ```bash
   kubectl -n stellar-oracle-<env> rollout restart deployment api-stable aggregator
   ```
3. If `BACKUP_ENCRYPTION_KEY` was compromised: re-encrypt existing backups with a new key
   before the old key is discarded (decrypt with old key, re-encrypt with new — see
   `BackupService`'s `readAndDecrypt`/`createBackup`), otherwise historical backups become
   unrestorable once the old key is gone.
4. Audit `audit-logger` output for the affected window to scope any unauthorized access.

---

## Scenario: Region / cloud-provider outage

The current deployment topology is single-cluster (see [DEPLOY.md](../../DEPLOY.md)) —
there is no automated cross-region failover today. Until multi-region is implemented:

1. Treat as Tier 2 full recovery, targeting a cluster in a healthy region.
2. Point `kubectl` context at the new cluster and run `scripts/dr/recover.sh <env>`.
3. Update DNS/load balancer targets to the new cluster's ingress once health checks pass.
4. This scenario's RTO will exceed the 1-hour target until multi-region standby is in
   place — track as a roadmap item, not a gap in the automated tooling.
