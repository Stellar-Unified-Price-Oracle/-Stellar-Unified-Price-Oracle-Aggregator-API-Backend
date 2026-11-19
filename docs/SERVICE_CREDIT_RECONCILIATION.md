# Service Credit Reconciliation (Issue #794)

An auditable method for associating eligible service incidents with consumer credits, with
every calculation verified against the delivery objectives in [service-sla.md](./service-sla.md).
Generated from `config/service-credits.json` (plan fees from `config/sustainability-model.json`)
by `npm run credits:reconcile`; do not edit by hand.

- **Owner**: Economics and ecosystem sustainability workstream (Reliability + Billing)
- **Period**: 2026-10 (44,640 minutes) · **Next review**: 2026-12-19
- **Ledger digest (SHA-256)**: `911405472d589f6578014e9c8d54df21099fd6ab976501b68c018bf7469dcb07`
- **Total credits issued**: $137.00

## Credit policy

| SLI | Objective | Credit schedule (% of monthly fee) |
| :--- | ---: | :--- |
| API availability (`availability`) | 99.9% | < 99.9% → 10%; < 99.5% → 25%; < 99% → 50% |
| Price freshness (`freshness`) | 99.5% | < 99.5% → 10%; < 99% → 25% |
| API latency (< 1 s) (`latency`) | 99% | < 99% → 5%; < 95% → 10% |

- Eligible plans: pro, enterprise. Credits for one month are capped at 50% of that month's fee.
- Per-SLI credits take the highest matching band and are summed across SLIs before the cap.
- Excluded causes: scheduled-maintenance, customer-caused, force-majeure. Scheduled maintenance is excluded only when announced at least 72h ahead.
- Only resolved incidents count. Each classification must be approved by a second person.

## Method

1. **Classify**: each incident is checked against the exclusion rules (table below).
2. **Scope**: an eligible incident counts against every region it lists (`*` = all regions) for its SLI.
3. **Clip and merge**: incident windows are clipped to the period, and overlapping windows for the
   same region and SLI are merged so concurrent incidents are never counted twice.
4. **Attainment**: `100 × (1 − bad minutes / minutes in period)` per region and SLI.
5. **Reconcile**: the incident-derived attainment must be within ±0.01 percentage points of the
   measured SLO attainment and land in the same credit band. A mismatch means an incident is
   missing or mis-timed, and the check fails.
6. **Ledger**: each consumer's credit comes from their home region's attainment. The ledger is
   hashed so any later edit is detectable.

## Incident classification

| Incident | SLI | Regions | Window (UTC) | Cause | Eligible | Reason | Evidence | Classified / approved |
| :--- | :--- | :--- | :--- | :--- | :---: | :--- | :--- | :--- |
| INC-101 | availability | us-east-1 | 2026-10-03T14:10:00Z → 2026-10-03T15:05:00Z | deploy-regression | yes | eligible cause: deploy-regression | Postmortem PM-2026-10-03 (API 5xx after deploy and DB failover) | oncall-primary / reliability-lead |
| INC-102 | availability | us-east-1 | 2026-10-03T14:50:00Z → 2026-10-03T15:20:00Z | database-failover | yes | eligible cause: database-failover | Postmortem PM-2026-10-03 (API 5xx after deploy and DB failover) | oncall-primary / reliability-lead |
| INC-103 | freshness | * | 2026-10-12T02:00:00Z → 2026-10-12T05:30:00Z | upstream-provider-outage | yes | eligible cause: upstream-provider-outage | Postmortem PM-2026-10-12 (provider quorum loss) | oncall-secondary / reliability-lead |
| INC-104 | availability | eu-west-1 | 2026-10-20T01:00:00Z → 2026-10-20T02:00:00Z | scheduled-maintenance | no | announced 96h ahead (>= 72h) | Maintenance notice MN-2026-10-16 (published 96h ahead) | oncall-primary / reliability-lead |
| INC-105 | availability | ap-southeast-1 | 2026-10-25T03:00:00Z → 2026-10-25T03:40:00Z | scheduled-maintenance | yes | notice 24h is below the 72h minimum | Maintenance notice MN-2026-10-24 (published 24h ahead) | oncall-secondary / reliability-lead |
| INC-106 | latency | eu-west-1 | 2026-10-31T23:00:00Z → 2026-11-01T01:00:00Z | capacity-exhaustion | yes | eligible cause: capacity-exhaustion | Postmortem PM-2026-10-31 (eu-west-1 latency) | oncall-primary / reliability-lead |
| INC-107 | availability | eu-west-1 | 2026-10-28T09:00:00Z → 2026-10-28T09:45:00Z | customer-caused | no | excluded cause: customer-caused | Rate-limit lockout of a single key after an AUP violation | oncall-secondary / reliability-lead |

## Attainment and reconciliation

Measured source: Prometheus SLO recording rules (monitoring/) for calendar month 2026-10, announced maintenance windows (>= 72h notice) excluded.

| Region | SLI | Bad minutes | Incident-derived | Measured | Δ (pp) | Credit (derived / measured) | Incidents |
| :--- | :--- | ---: | ---: | ---: | ---: | :---: | :--- |
| us-east-1 | availability | 70 | 99.8432% | 99.844% | 0.0008 | 10% / 10% | INC-101, INC-102 |
| us-east-1 | freshness | 210 | 99.5296% | 99.531% | 0.0014 | 0% / 0% | INC-103 |
| us-east-1 | latency | 0 | 100% | 100% | 0 | 0% / 0% | — |
| eu-west-1 | availability | 0 | 100% | 100% | 0 | 0% / 0% | — |
| eu-west-1 | freshness | 210 | 99.5296% | 99.531% | 0.0014 | 0% / 0% | INC-103 |
| eu-west-1 | latency | 60 | 99.8656% | 99.866% | 0.0004 | 0% / 0% | INC-106 |
| ap-southeast-1 | availability | 40 | 99.9104% | 99.911% | 0.0006 | 0% / 0% | INC-105 |
| ap-southeast-1 | freshness | 210 | 99.5296% | 99.531% | 0.0014 | 0% / 0% | INC-103 |
| ap-southeast-1 | latency | 0 | 100% | 100% | 0 | 0% / 0% | — |

Reconciliation result: **all region/SLI pairs agree within tolerance.**

## Credit ledger

| Consumer | Plan | Region | Fee | availability | freshness | latency | Credit % | Credit | Incidents |
| :--- | :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: | :--- |
| c-ent-01 | enterprise | us-east-1 | $1250.00 | 99.8432% → 10% | 99.5296% → 0% | 100% → 0% | 10% | **$125.00** | INC-101, INC-102 |
| c-ent-03 | enterprise | ap-southeast-1 | $1250.00 | 99.9104% → 0% | 99.5296% → 0% | 100% → 0% | 0% | **$0.00** | — |
| c-pro-07 | pro | us-east-1 | $120.00 | 99.8432% → 10% | 99.5296% → 0% | 100% → 0% | 10% | **$12.00** | INC-101, INC-102 |
| c-pro-12 | pro | eu-west-1 | $120.00 | 100% → 0% | 99.5296% → 0% | 99.8656% → 0% | 0% | **$0.00** | — |
| c-free-44 | free | us-east-1 | $0.00 | 99.8432% → 0% | 99.5296% → 0% | 100% → 0% | not eligible | **$0.00** | — |

## Review procedure and completion evidence

1. After the month closes, the on-call primary records every resolved incident with SLI, regions,
   UTC window, cause and evidence; the reliability lead approves the classification.
2. Record the month's measured attainment from the SLO recording rules.
3. Run `npm run credits:reconcile`, commit the regenerated document, and hand the ledger and its
   digest to billing. Billing applies exactly the amounts in the ledger.

`npm run credits:reconcile:check` (run in CI) fails on an invalid or unapproved incident, an open
incident, a reconciliation mismatch, or a stale document. `scripts/tests/service-credits.test.mjs`
covers overlap merging, month-boundary clipping, exact objective boundaries, the maintenance
notice rule, the cap, ineligible plans, a missing incident caught by reconciliation, and ledger
tamper detection.

## Compatibility, monitoring and operational impact

- **Compatibility**: Additive. It does not change the SLOs in service-sla.md; it makes the
  "service credits" section of that document calculable. No API, contract or schema changes.
- **Monitoring**: Inputs come from the existing SLO recording rules and incident postmortems.
  A reconciliation failure is itself the signal that incident records and telemetry disagree.
- **Operational impact**: Adds a monthly close step for on-call and billing (about 30 minutes).

## Rollout and rollback

- **Rollout**: Run the first close in shadow mode (ledger computed, credits not applied) and
  compare it with manual credit decisions. Switch billing to the ledger once one shadow month
  matches.
- **Rollback**: Revert the commit and return to manual credit decisions. Credits already applied
  stay applied; the committed ledgers and digests remain the audit record.
