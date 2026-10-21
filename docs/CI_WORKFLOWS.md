# CI Workflow Inventory

Issue: #627. This is the single entry point for "which workflow owns this
concern, is it a required check, and who owns a red run?".

`npm run check:workflows` (`scripts/check-workflow-inventory.mjs`) fails if a
workflow file is not listed here, is listed twice, or is missing
`name`/`concurrency`. New workflows must be added to the table in the same PR.

## Classifications

- **Blocking gate** — runs on pull requests and must be green before merge
  (branch protection) or is path-filtered CI for the touched area. A red run is
  owned by the listed owner and blocks the PR.
- **Post-merge verification** — runs after merge/tag or on manual dispatch to
  verify or deploy what already landed. Red runs page the owner but do not block
  an unrelated PR.
- **Scheduled drill** — quarterly/weekly exercise of a recovery or rotation path.
  Advisory, not a required check. Every scheduled drill opens a durable
  `drill-outcome` issue and uploads a report artifact; a failure also opens (or
  updates) the issue so it cannot silently accumulate as a red run.
- **Reporting** — automation that collects evidence, files follow-ups, or
  publishes artifacts. Advisory; failures are routed to the owning team.

## Inventory

| Workflow file | Classification | Owner | Authority / purpose | Triggers |
|---|---|---|---|---|
| `backup-restore-test.yml` | Scheduled drill | Data platform | Backup and restore rehearsal; records outcome issue + artifact | weekly, manual |
| `blue-green-deploy.yml` | Post-merge verification | Release engineering | Blue/green deployment path after merge or manual dispatch | push `main`, manual |
| `chaos-engineering.yml` | Scheduled drill | Reliability | Chaos hypotheses against staging; report artifact | path-filtered PR/push, schedule, manual |
| `ci.yml` | Blocking gate | CI maintainers | The authoritative PR gate: cost, price correctness, config contracts, aggregator, API, contract verification, fuzz, kustomize, benchmark | PR, push, nightly |
| `create-actions-from-postmortem.yml` | Reporting | Incident commander | Turns a postmortem checklist into tracked action issues | issue comment |
| `dependabot-auto-merge.yml` | Reporting | Repo maintainers | Enables auto-merge for eligible dependency PRs; does not replace `ci.yml` | PR events |
| `deploy.yml` | Post-merge verification | Release engineering | Builds/signs images and deploys staging; production is manual dispatch | push `main`/`develop`, manual |
| `disaster-recovery-drill.yml` | Scheduled drill | SRE / DR owner | The single DR pipeline: script validation, recovery tiers, and the regional failover scenario (consolidated from `dr-drill.yml`) | path-filtered PR/push, quarterly, manual |
| `egress-allowlist.yml` | Blocking gate | Security / platform | Fails PRs that add unapproved egress destinations; nightly drift check | path-filtered PR/push, nightly |
| `history-gap-detection.yml` | Reporting | Data platform | Detects and reports missing history windows | hourly, manual |
| `incident-to-postmortem.yml` | Reporting | Incident commander | Opens a postmortem from a labelled incident | issue labelled |
| `k8s-validation.yml` | Blocking gate | Platform | Validates Kubernetes manifests and chaos manifests on path-filtered PRs | path-filtered PR/push |
| `load-tests.yml` | Scheduled drill | Performance | k6 load/SLO checks; publishes results | path-filtered PR, schedule, manual |
| `rollback.yml` | Scheduled drill | Release engineering | The single rollback path: manual rollback (dispatch, input-gated) plus the weekly dry-run drill job (consolidated from `rollback-drill.yml`) | weekly, manual |
| `sbom.yml` | Reporting | Security | Publishes an SBOM for releases | release published |
| `sdk-publish.yml` | Post-merge verification | SDK maintainers | Publishes SDK packages from tags | tag `sdk-v*`, manual |
| `sdk-release-compat-gate.yml` | Blocking gate | SDK maintainers | Blocks an SDK tag that breaks the compatibility matrix | tag `sdk-v*`, manual |
| `secret-rotation-drill.yml` | Scheduled drill | Security | Quarterly secret-rotation rehearsal; records outcome issue | quarterly, manual |
| `security-evidence.yml` | Reporting | Compliance | Collects control evidence for an audit period | quarterly, manual |
| `security.yml` | Blocking gate | Security | The single security scanning workflow: audit findings, tenant isolation fuzz, reproducible build, and container build/Trivy scan (consolidated from `security-scan.yml`) | PR, push, nightly, weekly |
| `terraform.yml` | Blocking gate | Platform | Terraform fmt/validate/plan for infrastructure changes | path-filtered PR/push, manual |
| `weekly-review-actions.yml` | Reporting | Incident commander | Reviews open postmortem actions and files follow-ups | weekly |

## Overlaps resolved

| Before | After |
|---|---|
| `security.yml` + `security-scan.yml` | One `security.yml`; container jobs (`container-build-image`, `container-trivy-scan`) live beside the audit and fuzz jobs |
| `disaster-recovery-drill.yml` + `dr-drill.yml` | One `disaster-recovery-drill.yml`; `dr-drill` is a scenario job alongside the tier validation jobs |
| `rollback.yml` + `rollback-drill.yml` | One `rollback.yml`; `rollback-drill` is a scheduled job in the same pipeline as the manual rollback |

## Concurrency and failure routing

- Every workflow declares `concurrency` keyed on `${{ github.ref }}` (or the
  resource it deploys). `cancel-in-progress` is true only for pull-request runs,
  so scheduled and manual drills queue instead of cancelling each other.
- Scheduled drills upload a report artifact (90 days) and open a
  `drill-outcome` issue with status, run URL, and the achieved RTO/TTR values.
  The issue is the durable outcome record; see
  [`docs/operations/DRILL_LOG.md`](./operations/DRILL_LOG.md).
- A red blocking gate is owned by the table owner and must be fixed or the PR
  is not merged. A red post-merge/reporting job opens a follow-up in the owning
  team's queue; it is not ignored because "the other workflow covers it".

## Adding a workflow

1. Add the file with a `name` and `concurrency` block.
2. Add one row to the inventory with a classification and owner.
3. For a scheduled drill, add the outcome-issue step
   (`actions/github-script` with the `drill-outcome` label).
4. Run `npm run check:workflows`.

Rollout: merge the inventory and check first; existing workflows are already
covered. Rollback: revert the workflow and its inventory row together — the
check fails if only one side is reverted.
