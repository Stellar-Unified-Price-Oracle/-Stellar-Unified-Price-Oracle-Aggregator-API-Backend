# Tiered Historical Archive Offering (Issue #792)

This document specifies the retention tiers, retrieval objectives, integrity guarantees and
cost boundaries for historical price data products. It is generated from
`config/historical-archive-tiers.json` by `npm run archive:tiers`; do not edit it by hand.

- **Owner**: Economics and ecosystem sustainability workstream (Data Platform team)
- **Last updated**: 2026-11-19 · **Review interval**: 90 days · **Next review**: 2027-02-17

## Retention tiers

| Tier | Age window | Medium | Granularity | Plans |
| :--- | :--- | :--- | :--- | :--- |
| **Hot** (`hot`) | day 0 – 30 | TimescaleDB hypertable (uncompressed chunks) | raw (every poll cycle) | Free, Pro, Enterprise |
| **Warm** (`warm`) | day 30 – 90 | TimescaleDB hypertable (native compressed chunks) | raw (every poll cycle) | Pro, Enterprise |
| **Cold archive** (`cold`) | day 90 – 2555 | gzip NDJSON archives written by persistence/file-archival.ts to object storage | raw (every poll cycle) | Enterprise |

Tiers are contiguous: every age from day 0 to day 2555 maps to exactly one tier, and
data older than day 2555 is deleted. A plan with access to a colder tier always has
access to every warmer tier.

## Retrieval objectives

| Tier | Mode | Objective (p95) | Measured (p95) | Measured on | Evidence |
| :--- | :--- | ---: | ---: | :--- | :--- |
| Hot | online | 500 ms | 180 ms | 2026-11-12 | k6 load-tests/k6 history scenario against /api/v1/history |
| Warm | online | 3.0 s | 1.1 s | 2026-11-12 | k6 history scenario with from/to outside the hot window |
| Cold archive | restore-request | 4.0 h | 45 min | 2026-11-05 | Quarterly restore drill: restore 30 days of archives and replay through scripts/dr |

Online tiers are served by `/api/v1/history`. The cold tier is a restore request: the objective
is the time from an accepted request to the restored range being queryable.

## Integrity guarantees

| Tier | Checksum | Verify on write | Scrub interval | Restore drill | Immutable | Mechanism |
| :--- | :--- | :---: | ---: | ---: | :---: | :--- |
| Hot | sha256 | yes | 7 d | 90 d | no | PostgreSQL data checksums + pgBackRest full/diff backups (repo1-retention-full=7) |
| Warm | sha256 | yes | 14 d | 90 d | no | PostgreSQL data checksums + pgBackRest backups; compressed chunks verified on decompression |
| Cold archive | sha256 | yes | 30 d | 90 d | yes | Per-file SHA-256 manifest written alongside each archive; object lock (WORM) on the bucket |

Archive integrity is checked by `verifyArchiveManifest` in `scripts/historical-archive-tiers.mjs`:
every archive file is re-hashed and compared with its recorded checksum. A mismatch or an
unreadable file is reported as a failure and blocks the restore.

## Cost boundaries

Volume model: 5 assets × one point per 30s × 220 bytes per point.

| Tier | Days held | Points | Compression | Stored | Storage rate | Projected / month | Ceiling / month | Retrieval / asset-year |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Hot | 30 | 432,000 | 1× | 0.0885 GiB | $0.170/GiB | $0.0150 | $5.00 | $0.000000 |
| Warm | 60 | 864,000 | 8× | 0.0221 GiB | $0.170/GiB | $0.0038 | $2.00 | $0.000000 |
| Cold archive | 2465 | 35,496,000 | 10× | 0.7273 GiB | $0.023/GiB | $0.0167 | $1.00 | $0.019384 |
| **Total** | | | | **0.8379 GiB** | | **$0.0355** | **$8.00** | |

Cold-tier retrieval is capped at 50 GiB per consumer per month. Requests above the cap
are queued to the next month or quoted separately.

## Configuration bindings

| Tier | Variable | Required value | Enforcement |
| :--- | :--- | :--- | :--- |
| Hot | `USE_TIMESCALEDB` | `true` | Checked against `.env.example` in CI |
| Warm | `HISTORY_RETENTION_DAYS` | `90` | Set per environment at rollout |
| Cold archive | `FILE_ARCHIVE_AFTER_DAYS` | `90` | Checked against `.env.example` in CI |
| Cold archive | `FILE_ARCHIVAL_ENABLED` | `true` | Set per environment at rollout |
| Cold archive | `FILE_RETENTION_DAYS` | `2555` | Set per environment at rollout |

## Review procedure and completion evidence

- `npm run archive:tiers` regenerates this document.
- `npm run archive:tiers:check` exits non-zero when tiers overlap or leave gaps, a measured retrieval
  p95 breaches its objective, an integrity control is missing or too infrequent, a projected cost
  exceeds its ceiling, a must-match variable drifts from `.env.example`, or this document is stale.
- `scripts/tests/historical-archive-tiers.test.mjs` covers normal, boundary (day 0, tier edges, final
  day) and failure cases (gaps, overlaps, breached objectives, checksum mismatch).
- Retrieval measurements are refreshed after each quarterly restore drill and k6 history run.

## Compatibility, monitoring and operational impact

- **Compatibility**: Additive. The API's `/api/v1/history` contract is unchanged; the hot and warm
  tiers are the existing TimescaleDB hypertable. Plan gating for warm and cold ranges is a
  product decision to be enforced in the API in a follow-up.
- **Monitoring**: Track the existing archival logs (`retention purged N cold file(s)`), TimescaleDB
  chunk compression status, and storage spend through `npm run cost:reconcile`.
- **Operational impact**: None until the rollout settings are applied. Enabling
  `HISTORY_RETENTION_DAYS=90` drops database rows older than 90 days, so the cold archive must be
  enabled and verified first.

## Rollout and rollback

1. Enable `FILE_ARCHIVAL_ENABLED=true` with `FILE_RETENTION_DAYS=2555` and confirm the first archive
   pass writes checksummed files.
2. Run a restore drill and record the measured retrieval time in the config.
3. Only then set `HISTORY_RETENTION_DAYS=90` per environment.

**Rollback**: set `HISTORY_RETENTION_DAYS=0` to stop database pruning and `FILE_ARCHIVAL_ENABLED=false` to
stop archival. Data already archived stays restorable from cold storage. Reverting this commit
removes only the specification, script and document.
