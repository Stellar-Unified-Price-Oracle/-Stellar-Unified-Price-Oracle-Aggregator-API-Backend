# Drill Outcome Log

Issue: #627. Scheduled drills record durable outcomes as `drill-outcome` GitHub
issues (status, run URL, achieved RTO/TTR) and keep the full report artifact for
90 days. This page is the human index and the place to record the values that
matter to recovery objectives.

| Date | Drill | Result | RTO / TTR achieved | RPO achieved | Run / issue |
|---|---|---|---|---|---|
| _add on each drill_ | Regional failover (`disaster-recovery-drill.yml`) | | | | |
| _add on each drill_ | Rollback (`rollback.yml`) | | | n/a | |
| _add on each drill_ | Backup/restore (`backup-restore-test.yml`) | | | | |
| _add on each drill_ | Secret rotation (`secret-rotation-drill.yml`) | | n/a | n/a | |
| 2026-10-25 | Backup/restore (`backup-restore-test.yml`) | failure | not measured | not measured | [run 40165774400](https://github.com/Stellar-Unified-Price-Oracle/-Stellar-Unified-Price-Oracle-Aggregator-API-Backend/actions/runs/40165774400) / #861 |
| 2026-11-01 | Backup/restore (`backup-restore-test.yml`) | failure | not measured | not measured | [run 41282975752](https://github.com/Stellar-Unified-Price-Oracle/-Stellar-Unified-Price-Oracle-Aggregator-API-Backend/actions/runs/41282975752) / #896, same root cause as #861, fixed by #983 |
| 2026-11-19 | Backup/restore, remediation re-run (local, not scheduled) | pass | 0.9 s | 0 rows lost | PR closing #861 |
| _add on each drill_ | Chaos engineering (`chaos-engineering.yml`) | | | n/a | |
| 2026-10-25 | Chaos engineering (`chaos-engineering.yml`) | failure | not measured | n/a | [run 40178881197](https://github.com/Stellar-Unified-Price-Oracle/-Stellar-Unified-Price-Oracle-Aggregator-API-Backend/actions/runs/40178881197) / #862 |
| 2026-11-01 | Chaos engineering (`chaos-engineering.yml`) | failure | not measured | n/a | [run 41300387625](https://github.com/Stellar-Unified-Price-Oracle/-Stellar-Unified-Price-Oracle-Aggregator-API-Backend/actions/runs/41300387625) / #898, remediated by #862 |

### 2026-10-25 backup/restore failure (#861)

- **What failed:** `npm ci` stopped the job before any backup or restore ran,
  because `package-lock.json` was missing the `@stellar-oracle/sdk-bindings`
  workspace. RTO and RPO were therefore never measured.
- **Repeated root cause:** the same failure hit the 2026-11-01, 2026-11-08 and
  2026-11-15 runs (rule 3); the 2026-11-01 run is #896. The PR closing #861
  (#983) is the tracked action.
- **Latent defects found once install passed:**
  1. `observability/metrics.ts` registered the feed-catalog metrics twice, so
     loading the restore tester threw `A metric with the name
     feed_policy_saved_total has already been registered`.
  2. `BackupService.restore()` passed the SQL as `input` to async `execFile`,
     which ignores that option. `psql` waited on stdin indefinitely, so the
     drill would have hung until the job timed out.
  3. `RestoreTester` restored into the source database rather than the
     temporary database it then asserted on.
  4. `npm run build` type-checks the whole API, so unrelated type errors
     blocked the drill. The drill now compiles only the backup/restore modules;
     `ci.yml` still owns whole-API type checking.
- **Remediation re-run:** the drill steps from the workflow were executed
  against `postgres:16` on 2026-11-19. All three restore tests passed; the
  TimescaleDB restore of the 5-row fixture into the temporary database took
  889 ms and recovered 5 of 5 rows (5 of 5 assets). These figures come from the
  CI fixture, not production-sized data, and only confirm the drill works end
  to end. Record the next scheduled run here.

### 2026-11-25 load tests failure (run 42588451219)

- **What failed:** `record-outcome` declared `needs: [load-test-pr, load-test-full]`.
  On a `schedule` trigger `load-test-pr` is skipped (its `if` condition requires
  `pull_request`). GitHub Actions propagates a skipped dependency to any dependent
  job even when that job has `if: always()`, so `record-outcome` was silently
  skipped on every scheduled run. No drill-outcome issue was opened and no RTO/RPO
  figures were recorded.
- **Root cause:** `needs` lists both tier jobs unconditionally. The fix removes
  `load-test-pr` from `record-outcome`'s `needs`; on a schedule only
  `load-test-full` runs and `record-outcome` only needs to observe its result.
- **RTO/RPO:** not measured; k6 never ran because the job was skipped before
  setup. Record figures from the next successful scheduled run.
- **Remediation:** `load-tests.yml` updated — `record-outcome` now needs only
  `load-test-full`.

### 2026-10-25 chaos engineering failure (#862)

- **What failed:** `scripts/validate-k8s.sh` rejected `api-stable` and
  `aggregator` in staging, prod-us-east-1 and prod-eu-west-1 with "writable
  mounts missing /tmp, /app/data, /app/logs". No experiment ran, so no RTO was
  measured. A merge after `b0f2629` had removed the `volumeMounts` from both
  base Deployments while keeping their `emptyDir` volumes and
  `readOnlyRootFilesystem: true`, so those pods could not write data, logs or
  temporary files.
- **Repeated root cause:** every scheduled run back to 2026-08-30 failed. From
  2026-10-25 on, every failure was at this manifest check (rule 3). The PR
  closing #862 is the tracked action.
- **Second blocker:** once validation passed, `generate-report.sh` would have
  failed too. Under `set -o pipefail` a failing `kubectl get` (no cluster, or a
  Chaos Mesh CRD not installed) aborted the script despite its fallbacks.
- **Remediation re-run:** on 2026-11-19, `validate-k8s.sh`, the weekly schedule
  check and `generate-report.sh` all exit 0 locally. Without a cluster, the
  report now states `Cluster reachable: false` and carries no evidence, so an
  empty report cannot be read as a passing experiment.

### 2026-11-01 chaos engineering failure (#898)

- **What failed:** the same `scripts/validate-k8s.sh` check as #862 rejected
  `api-stable` and `aggregator` in all three overlays with "writable mounts
  missing /tmp, /app/data, /app/logs". `generate-report` was skipped, so no
  experiment ran and no RTO was measured.
- **Root cause:** identical to the 2026-10-25 failure (rule 3); the run used
  commit `7771173`, before the `volumeMounts` were restored. The PR closing
  #862 is the remediation, and chaos runs on `main` after it have passed
  manifest validation. Record the next scheduled run here.

## Rules

1. The workflow opens the `drill-outcome` issue automatically; the drill owner
   adds the achieved RTO/RPO (or TTR) to the issue and to this table.
2. A failed drill is not closed by "the other workflow is green". Link the
   remediation PR/issue in the same row.
3. If the same root cause fails two consecutive drills, open a tracked
   reliability action and add it to `weekly-review-actions.yml`.
4. Artifacts are retained for 90 days; this table and the issues are permanent.

Owners: SRE/DR owner for regional failover and backup/restore, release
engineering for rollback, security for secret rotation. See
[CI workflow inventory](../CI_WORKFLOWS.md).
