# Feed onboarding decision log

**Owner:** Governance steward (rotating; see `.github/CODEOWNERS`)
**Scope:** every proposal to add, change, suspend, or remove a price feed.
**Status:** Adopted

Every feed decision is recorded as one versioned Markdown file in
[`feed-onboarding-decisions/`](./feed-onboarding-decisions/), named
`YYYY-MM-DD-<feed-id>-<proposal|review>.md`. Records are append-only: a
decision is never edited after merge except to add a `Review outcomes` entry or
a `Superseded by` pointer. Corrections are new records.

## Required fields

| Field | Content |
| --- | --- |
| Decision ID | `FOD-YYYY-NNN`, unique and sequential |
| Feed | Feed identifier and asset pair |
| Proposer | GitHub handle or organization |
| Status | `proposed`, `accepted`, `rejected`, `deferred`, `suspended`, `removed` |
| Evidence reviewed | Links to source list, liquidity/volume data, decimals check, latency and uptime measurements |
| Conflicts of interest | Declared by proposer and each approver, or `none declared` |
| Rationale | Why the decision was taken, including dissenting views |
| Approvers | Handles and date of approval (minimum 2, neither being the proposer) |
| Review date | When the decision is re-examined (default 90 days after activation) |
| Review outcomes | Dated entries appended after each later review |
| Rollout / rollback | Activation steps and the exact steps to disable the feed |

## Process

1. Proposer opens a PR adding a record with status `proposed`.
2. Reviewers add evidence links and declare conflicts in PR comments; the record is updated before merge.
3. Two approvers who are not the proposer approve. An approver with a declared conflict recuses and does not count.
4. The PR merges with status `accepted` or `rejected`. Activation follows the normal deploy runbook.
5. At the review date a steward appends a `Review outcomes` entry (`retained`, `modified`, `suspended`, `removed`).

## Measurable completion evidence

- Every active feed has exactly one `accepted` record (checked by `scripts/check-feed-decision-log.mjs`).
- Every record contains all required fields and at least two distinct non-proposer approvers.
- Records past their review date without an outcome entry are reported by the same script.

Run `node scripts/check-feed-decision-log.mjs` (no dependencies). Exit code 1 on invalid records; overdue reviews are warnings.

## Compatibility and operations

Documentation and a read-only check only: no runtime, API, or contract behavior changes. Monitoring: the weekly review job may run the check and surface overdue reviews. Rollback: revert the record PR; a feed's operational rollback is documented per record.

## Failure and boundary cases

- Fewer than two approvers, proposer self-approval, missing conflict declaration, or unknown status fails the check.
- A review date in the past with no outcome is a warning, not a failure.
- Rejected records are retained so the same proposal is not silently re-litigated.
