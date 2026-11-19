# Pricing Experiment Safeguards (Issue #796)

Pricing experiments on the Service vary only commercial terms: base fee, overage
rate, or included requests. They never vary the data, rate limits, or service
levels a consumer receives. This document defines the bounds every experiment
must stay within. It's generated from `config/pricing-experiments.json` by
`scripts/pricing-experiments.mjs`, and `npm run pricing-experiments:check`
fails CI when an experiment breaks a safeguard or this file is stale.

## Owner and scope

- **Owner**: economics-sustainability-team (Economics and ecosystem sustainability workstream)
- **Approvers**: Economics and Ecosystem Lead, Developer Relations Lead (both must sign off before `startDate`)
- **In scope**: free and pro tiers; levers `baseFeeMonthlyUsd`, `overagePer1kRequestsUsd`, `includedMonthlyRequests`
- **Out of scope**: Enterprise contracts (negotiated rates) and keys tagged `internal`, `partner-sandbox`, `enterprise-contract`

## Experiment bounds

| Bound | Limit |
| :--- | :--- |
| Max consumer cost increase | 15% |
| Max consumer cost decrease | 30% |
| Treatment cohort | ≤ 20% of tier, ≥ 5 keys |
| Holdout | ≥ 5% |
| Duration | 14–60 days |
| Concurrent experiments per tier | 1 |
| Protected guarantees (never varied) | `rateLimit`, `dataFreshness`, `sla`, `feedCoverage` |

Fewer included requests is treated as a price increase.

## Consent and notice

- Cost increases need **30 days'** notice. Decreases need 0.
- Increases above **10%** require explicit opt-in.
- Opt-out is always available and returns the key to control pricing at the next cycle.
- Notice goes out through `developer-portal`, `billing-email`, `release-notes`.
- **Billing protection**: Treatment charges never exceed the control price for the cycle in which a consumer opts out or a rollback fires; any excess is credited.

## Cohort isolation

- Assignment: `sha256(salt + ':' + apiKeyId) bucket in [0, 10000)`. Buckets below the cohort share are treatment, the next band is holdout, and the rest is control.
- Assignment is sticky. A key stays in its cohort for the whole experiment.
- Experiments in the same tier may not overlap in time, so no key is ever in two treatments.

## Rollback triggers

Any one trigger firing rolls the treatment back to control pricing at the next
billing cycle, and the billing protection credits any excess.

| Metric | Fires when | Meaning |
| :--- | :--- | :--- |
| `churnRateDeltaPp` | > 2 | Treatment churn exceeds control by more than 2 percentage points |
| `downgradeRateDeltaPp` | > 3 | Treatment tier downgrades exceed control by more than 3 percentage points |
| `billingComplaintsPer100Keys` | > 3 | Billing support tickets per 100 treatment keys |
| `revenueDeltaPercent` | < -10 | Treatment revenue per key falls more than 10% below control |
| `optOutRatePercent` | > 20 | More than 20% of the treatment cohort opted out |

A missing metric yields `INSUFFICIENT_EVIDENCE`. An experiment can't be
declared successful without every metric.

## Experiment register and outcome report

| Experiment | Tier | Change | Cost Δ | Treatment / holdout | Window | Decision |
| :--- | :--- | :--- | ---: | :--- | :--- | :--- |
| `exp-2026q4-pro-overage` | pro | `overagePer1kRequestsUsd` $0.2 → $0.17 | -15% | 20% / 10% | 2026-11-20 → 2027-01-15 | **CONTINUE** |

### `exp-2026q4-pro-overage`

- **Hypothesis**: Lowering the Pro overage rate from $0.20 to $0.17 per 1k requests increases metered volume enough to keep revenue per key within 5% of control.
- **Validation**: passes all safeguards
- **Treatment cohort**: 7 key(s) of 35; notice 0 day(s); opt-in not required
- **Evidence**: Worked example with synthetic observations. Replace with measured values before reporting a real outcome.
- **Audit digest (sha256)**: `1629ac33f78c0496cfd37ddb9d32476accfd749af4ef45afa5a13607bdb23a7a`

| Rollback trigger | Fires when | Observed | Status |
| :--- | :--- | ---: | :--- |
| `churnRateDeltaPp` | > 2 | 0.4 | ok |
| `downgradeRateDeltaPp` | > 3 | 0 | ok |
| `billingComplaintsPer100Keys` | > 3 | 0 | ok |
| `revenueDeltaPercent` | < -10 | -3.1 | ok |
| `optOutRatePercent` | > 20 | 0 | ok |

**Decision: CONTINUE**

## Compatibility, monitoring, and operational impact

- **Compatibility**: Offline policy tooling with no change to the API, the aggregator, or the contract. Rate limits and data paths are identical across cohorts by construction.
- **Monitoring**: Trigger metrics come from usage counters and billing reconciliation (`npm run cost:reconcile`), reviewed weekly while an experiment runs.
- **Operational impact**: None on the live price path.

## Rollout and rollback guidance

- **Rollout**: Add the experiment to `config/pricing-experiments.json`, run `npm run pricing-experiments`, and get both approvers' sign-off on the PR. Send notice, then start.
- **Rollback**: Set the treatment back to control pricing at the next billing cycle and credit any excess. Record the observations and commit the regenerated report as the audit record.
