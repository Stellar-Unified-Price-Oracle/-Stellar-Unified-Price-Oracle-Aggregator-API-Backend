# Governance Accountability & Decentralization Reporting

Owner: governance working group (`@stellar-oracle/governance`).
Operator surface: `/api/v1/governance/decentralization` (admin key required).

This surface turns the governance/decentralization roadmap items into
repeatable measurements and published reports instead of ad-hoc spreadsheets:

| Concern | Issue | Endpoint group |
|---|---|---|
| Multisig signer independence | #782 | `/signers`, `/signers/independence` |
| Decentralization stage gates | #783 | `/stage-gates`, `/stage-gates/snapshots`, `/stage-gates/transition` |
| Proposal execution reconciliation | #784 | `/execution-audit` |
| Grant outcomes against objectives | #785 | `/grants`, `/grants/outcomes/report` |

All mutating calls are written to the tamper-evident audit log
(`governance.*` events), so a report can be tied to the operator who produced
it.

## 1. Signer independence (#782)

`PUT /signers` registers the multisig roster plus a policy; the response (and
`GET /signers/independence`) is a scored report.

Each signer is assessed on four operational criteria:

- **Custody** — a custody type on the policy's `disallowedCustody` list (by
  default `software`) fails.
- **Rotation** — keys older than `rotationIntervalDays` (default 180) fail.
- **Availability** — trailing availability below `minAvailabilityPct`
  (default 99%) fails.
- **Conflicts** — every declared conflict needs a written mitigation.

A signer that fails any criterion is reported but is not counted towards the
quorum. The **maximum independent quorum** is then computed as a maximum
bipartite matching between organizations and custody providers: each counted
signer consumes one distinct organization *and* one distinct provider, so any
two counted signers are independent by construction. Quorum independence is
therefore not "how many signers exist" but "how many signers can act at once
without sharing a custodian or employer".

The report also surfaces:

- custody and organization concentration against policy caps,
- undeclared shared control (two signers in one organization, neither of whom
  declares the other),
- duplicate addresses, future rotation timestamps and unmitigated conflicts
  (which fail closed rather than being silently ignored).

`verdict` is `pass` only when the independent quorum is reachable and no
critical finding exists. Rotation/availability findings are visible without
turning an otherwise independent quorum red.

## 2. Decentralization stage gates (#783)

`POST /stage-gates/snapshots` records a measurement of four dimensions:

| Dimension | Weight source |
|---|---|
| `provider` | accepted submissions per oracle provider |
| `signer` | approvals per multisig signer |
| `governance` | voting power per voter |
| `region` | signers/providers per deployment region |

For each dimension the report publishes HHI (`sum(share²) × 10 000`, 0–10 000),
top-1 share and the **Nakamoto coefficient** (entities needed to exceed 50%).
Snapshots are append-only and must be chronological; duplicates, negative
weights, empty dimensions and all-zero weights are rejected so a bad input can
never be mistaken for healthy decentralization.

Stages are absolute thresholds, from `stage-0` (baseline) to `stage-3`
(decentralized), with stricter gates at each step (see
`DECENTRALIZATION_STAGES` in `stage-gates.ts`). A stage advances only when the
next stage's gates pass on **three consecutive snapshots**
(`POST /stage-gates/transition`); skipping stages is rejected, and rolling back
is always allowed. The report includes:

- baseline measures (the first snapshot),
- target measures (the next stage's gates),
- per-criterion `actual`/`required`/`passed`,
- `regression: true` when the current stage's gates stop passing,
- `findings` with the exact criterion and gap.

## 3. Execution reconciliation (#784)

`POST /execution-audit` takes an approved-proposal set, a baseline state and
the observed on-chain/off-chain state. It:

1. Derives the expected effect of every `Executed` proposal (signers,
   threshold, admin, oracle sources, trusted assets, deviation threshold,
   governance config, reputation resets).
2. Applies those effects to the baseline in execution order.
3. Diffs expected against observed, including keys present in only one side.

Every difference is a discrepancy with a kind and severity:

| Kind | Meaning | Severity |
|---|---|---|
| `unapproved_change` | observed state no approved proposal authorises | critical |
| `inconsistent_proposal` | `Executed` without an execution timestamp | critical |
| `mismatch` | observed value differs from the approved effect | high |
| `missing_change` | approved effect never landed | high |
| `unverifiable_effect` | action has no reconciliation mapping | high |
| `overdue_execution` | approved but unexecuted past the deadline (default 30 days) | medium |

Array values (signers, sources, trusted assets) compare order-insensitively.
Reports are stored and every discrepancy carries a remediation status.
`POST /execution-audit/:reportId/remediation` records `open`, `in_progress`,
`resolved` or `accepted_risk` plus owner/note, and the status is carried into
the next reconciliation. Untriaged discrepancies are reported explicitly, so
"no status" cannot be mistaken for "resolved".

## 4. Grant outcomes (#785)

`POST /grants` refuses a grant that is not measurable:

- at least one objective with a description, metric, unit, numeric target and
  direction (`min` or `max`),
- at least one milestone with acceptance criteria and a due date,
- explicit conflict disclosure (a denial that still lists conflicts is
  rejected; every disclosed conflict needs a mitigation),
- verified evidence with an http(s) URI and a pinned sha256 digest; verified
  evidence is immutable.

Evidence is submitted per milestone. A grant cannot be completed until every
milestone has verified evidence. Once completed, a single post-completion
outcome report must cover **every** published objective (no partial reports,
no unknown objective ids); a `min` objective is met at or above target, a `max`
objective at or below.

`GET /grants/outcomes/report` aggregates completion rate, evidence coverage,
objective attainment, disclosure compliance and **overdue outcomes** (completed
more than `outcomeWindowDays`, default 30, without a report). The program
verdict fails when any outcome is overdue or any disclosure is incomplete.

## Measurement cadence

| Activity | Cadence | Owner |
|---|---|---|
| Concentration snapshot | monthly, and after any provider/signer/region change | governance analyst |
| Stage transition review | after three consecutive qualifying snapshots | governance council |
| Execution reconciliation | quarterly, and after every governance execution window | governance council + security |
| Grant evidence review | at each milestone; outcome report within 30 days of completion | grant owner + reviewer |

Cadence is manual in this change (the endpoints are idempotent and audited).
Automating it with a scheduled job is tracked separately; do not add a timer to
the API process.

## Monitoring and alerting

The API exports:

- `oracle_decentralization_top1_share{dimension}`
- `oracle_decentralization_nakamoto_coefficient{dimension}`
- `oracle_decentralization_stage_gate_passed{stage}`
- `oracle_governance_audit_discrepancies{kind,severity}` (unresolved only)
- `oracle_grant_objective_attainment_ratio`
- `oracle_grant_outcomes_overdue`

Suggested alerts: `oracle_decentralization_stage_gate_passed == 0` for the
current stage; `oracle_governance_audit_discrepancies{severity="critical"} > 0`;
`oracle_grant_outcomes_overdue > 0`.

## Compatibility, rollout and rollback

- Additive only: new admin-only routes, no changes to existing governance
  routes, response shapes, contract storage or env vars. A deployment without
  any calls leaves behaviour unchanged.
- State is in-memory per API replica, consistent with the existing proposal
  service. Until it is persisted, run reporting against one replica (or pin
  admin traffic to one) and treat a restart as a reset; this is documented as a
  follow-up rather than hidden.
- Rollback: remove the `/api/v1/governance/decentralization` mount and redeploy.
  No migration or data cleanup is required; nothing outside the API reads the
  stored reports.

## Known gaps / follow-ups

- Reports are not persisted across restarts or replicas (needs a Postgres
  table plus retention).
- Snapshot inputs are supplied by the caller; wiring them directly to the
  aggregator's source metrics and the contract's signer set is a follow-up.
- The public transparency portal should mirror published reports via a
  read-only, redacted projection instead of exposing signer addresses.
