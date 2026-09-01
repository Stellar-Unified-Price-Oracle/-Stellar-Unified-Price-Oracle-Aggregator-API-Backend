# DR Drills

Drills prove the recovery scripts in [recovery-procedures.md](recovery-procedures.md)
actually work, on a schedule, before a real disaster forces you to find out otherwise.

## Cadence

- **Automated**: quarterly, first Sunday of January/April/July/October at 05:00 UTC, via
  [`disaster-recovery-drill.yml`](../../.github/workflows/disaster-recovery-drill.yml)
  against `staging`.
- **Manual**: any time after a change to `scripts/dr/**`, the backup service, or the
  k8s TimescaleDB manifests — run it before merging, not just after.

## Success criteria

A drill passes when all of the following hold:

| Check | Threshold |
|---|---|
| Recovery completes without manual intervention | required |
| Measured RTO (drill start → health checks green) | < 1 hour |
| Measured RPO (age of restored data vs. drill start) | < 5 minutes |
| Post-restore health check (`/api/v1/health`, `/metrics`) | passing |
| Data integrity spot-check (row counts, latest price timestamp) | matches pre-drill snapshot within RPO window |

`scripts/dr/run-drill.sh` enforces these automatically and exits non-zero (failing the CI
job) if any threshold is missed.

## Pre-drill checklist

- [ ] Confirm target is `staging`, never `production`
- [ ] Verify namespace: `kubectl get ns stellar-oracle-staging`
- [ ] Notify `#stellar-oracle-ops` with start/end window
- [ ] Open Grafana dashboards for `dr_rpo_seconds`, API health, DB pool state
- [ ] Assign roles: **facilitator**, **operator**, **verifier** (see
      [README.md#roles](README.md#roles))
- [ ] Confirm a recent backup exists: `GET /api/v1/admin/dr/status`

## Running a drill

```bash
export CHAOS_TARGET_ENV=staging   # safety guard, matches chaos-engineering convention
./scripts/dr/run-drill.sh staging
```

The script:

1. Records a pre-drill fingerprint (row counts, latest `observed_at`, current image tags).
2. Simulates the disaster by scaling `timescaledb` to 0 and, for the Tier 1 variant,
   deliberately corrupting a scratch table so the restore has something real to fix.
3. Invokes `scripts/dr/recover.sh staging` (Tier 2) or `scripts/dr/restore-pitr.sh staging latest`
   (Tier 1) depending on `--tier` (default: alternate tiers quarter to quarter so both
   paths get exercised at least twice a year).
4. Measures elapsed time and data recency, checks against the thresholds above.
5. Writes `docs/disaster-recovery/reports/drill-<date>.md` with the outcome.

## Post-drill

- If the drill failed any threshold: file an issue immediately, treat closing it as a
  blocker for the next release, and re-run once fixed — do not wait for next quarter.
- If it passed: link the generated report from this file's drill log below.
- For any unexpected behavior (even if the drill technically passed), complete
  [runbooks/post-mortem-template.md](../runbooks/post-mortem-template.md).

## Drill log

| Date | Environment | Tier | RTO | RPO | Result | Report |
|---|---|---|---|---|---|---|
| _(none yet — first scheduled run populates this table)_ | | | | | | |
