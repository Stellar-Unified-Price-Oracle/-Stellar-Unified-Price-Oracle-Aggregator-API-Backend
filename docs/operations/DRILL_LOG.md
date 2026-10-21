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
