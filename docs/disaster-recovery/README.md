# Disaster Recovery Plan — Stellar Unified Price Oracle

This is the authoritative disaster recovery (DR) plan for the API/aggregator backend. It
defines recovery targets, the mechanisms used to hit them, and where to find the detailed
procedures and drill process.

Related: [runbooks](../runbooks/README.md) (day-to-day incident response) and
[chaos engineering](../chaos-engineering/README.md) (resilience validation under partial
failure). This plan is scoped to **catastrophic failure** — scenarios where the runbooks'
mitigations aren't enough and data or infrastructure must be recovered from backups.

## Recovery targets

| Metric | Target | Definition |
|---|---|---|
| **RTO** (Recovery Time Objective) | **< 1 hour** | Maximum time from disaster declaration to service restored and serving traffic |
| **RPO** (Recovery Point Objective) | **< 5 minutes** | Maximum acceptable data loss, measured as time between the disaster and the last recoverable transaction |

Targets apply to the `production` environment. `staging`/`dev` use the same mechanisms but
are not held to the same SLA — they exist partly to rehearse recovery for production.

## Recovery tiers

Two independent recovery paths exist, matched to blast radius. The plan is layered
deliberately: Tier 1 covers the common case cheaply, Tier 2 is the backstop when Tier 1's
prerequisites (an intact volume) are gone too.

### Tier 1 — Point-in-time recovery (PITR), database intact volume lost or corrupted

Covers: bad migration, accidental `DELETE`/`DROP`, application bug that corrupts data,
single-pod database failure where the underlying PVC survives.

- **Mechanism**: continuous WAL archiving (`archive_timeout=60s`) to a dedicated
  `wal-archive` volume, plus hourly physical base backups (`pg_basebackup`) via
  [`base-backup-cronjob.yaml`](../../k8s/base/timescaledb/base-backup-cronjob.yaml).
- **RPO achieved**: ≤ 60 seconds (bounded by `archive_timeout`; typically lower since WAL
  segments flush on commit).
- **RTO achieved**: ~10–20 minutes (restore latest base backup, replay WAL to target time).
- **Automation**: [`scripts/dr/restore-pitr.sh`](../../scripts/dr/restore-pitr.sh).

### Tier 2 — Full recovery, cluster/namespace/volume loss

Covers: PVC loss, cluster deletion, region outage, complete infrastructure loss.

- **Mechanism**: daily (configurable down to `BACKUP_INTERVAL_MS`) AES-256-GCM encrypted
  `pg_dump` snapshots via [`BackupService`](../../api/src/services/backup.ts), stored
  outside the database's own volume, plus full redeploy from the versioned k8s manifests
  in [`k8s/`](../../k8s).
- **RPO achieved**: bounded by `BACKUP_INTERVAL_MS` (default 24h; set to 5 minutes in
  production — see [recovery-procedures.md](recovery-procedures.md#tier-2-configuration)
  to stay inside the < 5 minute target even when Tier 1's volumes are gone too).
- **RTO achieved**: ~30–45 minutes (redeploy manifests + restore latest snapshot + verify).
- **Automation**: [`scripts/dr/recover.sh`](../../scripts/dr/recover.sh).

## Architecture summary

```
                     ┌─────────────────────────┐
                     │   TimescaleDB (primary)  │
                     │   PVC: data               │
                     └───────────┬───────────────┘
                 WAL (60s max)   │   pg_dump (BACKUP_INTERVAL_MS)
              ┌──────────────────┼──────────────────────┐
              ▼                                          ▼
   ┌─────────────────────┐                   ┌───────────────────────────┐
   │ wal-archive PVC      │                   │ Encrypted offsite snapshots│
   │ + hourly base backup │                   │ (BackupService, data/backups)│
   │ (base-backups PVC)   │                   └───────────────────────────┘
   └─────────────────────┘
        Tier 1: PITR restore                  Tier 2: full restore + redeploy
        scripts/dr/restore-pitr.sh            scripts/dr/recover.sh
```

Application tier (API + aggregator) is stateless and horizontally scaled behind k8s
Deployments (`k8s/base/api`, `k8s/base/aggregator`); recovery for that tier is a redeploy
from the versioned manifests via [`scripts/deploy-k8s.sh`](../../scripts/deploy-k8s.sh),
the same mechanism [`rollback.yml`](../../.github/workflows/rollback.yml) already uses.

## Readiness monitoring

`GET /api/v1/admin/dr/status` (admin-authenticated) reports live recovery readiness:

- Age of the most recent backup vs. the RPO target
- Whether `BackupService`'s weekly restore-integrity test is passing
- Timing and result of the last DR drill (see [drills.md](drills.md))

Prometheus gauges `dr_rpo_seconds`, `dr_rpo_target_seconds`, and
`dr_last_drill_rto_seconds` are exported for alerting — page if `dr_rpo_seconds` exceeds
`dr_rpo_target_seconds`, since that means the backup pipeline has silently stopped.

## Roles

| Role | Responsibility |
|---|---|
| **Incident commander** | Declares the disaster, owns the decision to invoke Tier 1 vs Tier 2, communicates status |
| **Recovery operator** | Runs the recovery scripts, verifies each step before proceeding |
| **Verifier** | Independently confirms data integrity and service health before declaring recovery complete |

For P0 incidents these roles follow the same on-call rotation and escalation path defined
in [runbooks/README.md](../runbooks/README.md#escalation-path).

## Documents in this plan

| Document | Purpose |
|---|---|
| [recovery-procedures.md](recovery-procedures.md) | Step-by-step procedure per disaster scenario |
| [drills.md](drills.md) | Quarterly DR drill process and success criteria |
| [reports/](reports/) | Historical drill reports (generated by `scripts/dr/run-drill.sh`) |

## Post-incident

Any real DR invocation (not a drill) requires a post-mortem using
[runbooks/post-mortem-template.md](../runbooks/post-mortem-template.md) within 48 hours,
including actual RTO/RPO achieved vs. target.
