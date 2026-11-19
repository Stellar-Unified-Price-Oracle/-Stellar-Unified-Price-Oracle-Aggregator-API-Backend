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
| 2026-11-19 | Backup/restore, remediation re-run (local, not scheduled) | pass | 0.9 s | 0 rows lost | PR closing #861 |

### 2026-10-25 backup/restore failure (#861)

- **What failed:** `npm ci` stopped the job before any backup or restore ran,
  because `package-lock.json` was missing the `@stellar-oracle/sdk-bindings`
  workspace. RTO and RPO were therefore never measured.
- **Repeated root cause:** the same failure hit the 2026-11-01, 2026-11-08 and
  2026-11-15 runs (rule 3). The PR closing #861 is the tracked action.
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
