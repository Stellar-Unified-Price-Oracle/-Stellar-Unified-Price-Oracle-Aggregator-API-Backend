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
| _add on each drill_ | Load tests (`load-tests.yml`) | | p95 / p99 / error rate | n/a | |
| 2026-10-26 | Load tests (`load-tests.yml`) | **Failed — not measured.** `npm ci` rejected `package-lock.json` (missing `@stellar-oracle/sdk-bindings`); k6 never ran. Remediation: #867 (lockfile), #869 (workflow build/auth/tier fixes). | n/a | n/a | [run 40284092271](https://github.com/Stellar-Unified-Price-Oracle/-Stellar-Unified-Price-Oracle-Aggregator-API-Backend/actions/runs/40284092271) / #869 |
| 2026-11-02 | Load tests (`load-tests.yml`) | **Failed — not measured.** Same root cause as 2026-10-26. | n/a | n/a | [run 41413679663](https://github.com/Stellar-Unified-Price-Oracle/-Stellar-Unified-Price-Oracle-Aggregator-API-Backend/actions/runs/41413679663) / #903 |
| 2026-11-09 | Load tests (`load-tests.yml`) | **Failed — not measured.** Same root cause as 2026-10-26. | n/a | n/a | [run 42588451219](https://github.com/Stellar-Unified-Price-Oracle/-Stellar-Unified-Price-Oracle-Aggregator-API-Backend/actions/runs/42588451219) / #932 |
| 2026-11-16 | Load tests (`load-tests.yml`) | **Failed — not measured.** Same root cause as 2026-10-26. | n/a | n/a | [run 43833447136](https://github.com/Stellar-Unified-Price-Oracle/-Stellar-Unified-Price-Oracle-Aggregator-API-Backend/actions/runs/43833447136) / #961 |

Load-test drills record latency and error rate rather than RTO/RPO; the four
runs above failed during dependency install, before any traffic was sent, so
there is no achieved value to record. Because the same root cause failed four
consecutive drills, rule 3 applies: track it as a reliability action until a
scheduled run reaches the k6 step.

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
