# MiCA / EU crypto-asset service assessment

## Scope and role

The oracle service acts as a data and price-distribution infrastructure layer for DeFi integrations. It does not custody customer funds and does not act as a broker or exchange operator on its own; however, it does provide price data relied upon by trading logic and protocol risk controls.

This means the service should be evaluated as a crypto-asset-related infrastructure provider under the evolving MiCA framework, with emphasis on transparency, disclosures, and governance controls.

## Current assessment

- Oracle inputs are normalized and aggregated from multiple providers before publication.
- Source methodology is documented and can be surfaced to consumers via the compliance report endpoints.
- Historical price and usage data are retained according to the retention policy and audit logs.
- Public disclosures should clearly explain operational responsibilities, source concentration risk, and data retention boundaries.

## Required disclosures

1. disclose the list of data sources and normalization methodology
2. publish the latency and staleness thresholds used for source health and source exclusion
3. document historical data retention, archive procedures, and deletion controls
4. explain where governance, access control, and incident response responsibilities sit
5. call out material operational risks, including dependency concentration among external price feeds

## Monitoring and review cadence

- review the MiCA obligations quarterly with legal and compliance stakeholders
- re-check source and data-processing disclosures whenever new oracle providers or downstream integrations are added
- re-run the compliance dashboard after any contract or operational change with material impact on price integrity or consumer-facing disclosures

## Immediate next steps

- keep source methodology and transparency statements in the published API documentation
- add a dedicated disclosure section to the public README and developer docs
- file any material operations or legal gaps as tracked compliance issues for review and closure

This assessment is intentionally conservative and aimed at a minimal control set rather than a full legal opinion.
