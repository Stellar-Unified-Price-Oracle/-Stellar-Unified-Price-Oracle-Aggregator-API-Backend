# Post-GA Roadmap Review — 2026 (Issue #798)

A yearly review that scores five outcome dimensions and turns the gaps into a
ranked roadmap. It's generated from `config/roadmap-review.json` by
`scripts/roadmap-review.mjs`. `npm run roadmap-review:check` fails CI when the
config is invalid or this file is stale.

## Owner, cadence, and scope

- **Owner**: economics-sustainability-team (Economics and ecosystem sustainability workstream). **Facilitator**: Economics and Ecosystem Lead
- **Participants**: Platform Operations, Security on-call, Developer Relations Lead, Contract maintainers
- **Cadence**: Full review every 12 months, with KPI checkpoints every 3 months
- **This review**: 2026-11-19. **Next checkpoint**: 2027-02-19. **Next full review**: 2027-11-19
- **Inputs**: Illustrative 2026 inputs. Replace with measured values at the review. Derived KPIs are computed from the committed models.

## Scoring method

Each KPI scores linearly from 0 at its **floor** to 100 at its **target**,
clamped to that range. A missing KPI scores 0 and is listed, so absent evidence
lowers the score rather than being hidden. A dimension's score is the mean of
its KPIs. The overall score is the weighted mean of the dimensions.

† marks a derived KPI: `gross-margin-percent` and `runway-months` come from
`npm run sustainability:model`, and `certified-partners` from
`npm run partner-scorecard`, counting only real partners.

## Outcome scores

**Overall: 69.3 / 100**

| Dimension | Weight | Score | Δ vs. last review | Missing evidence |
| :--- | ---: | ---: | :--- | :--- |
| Adoption | 20% | **41.2** | baseline year | — |
| Reliability | 25% | **90.6** | baseline year | — |
| Security | 25% | **66.1** | baseline year | — |
| Economics | 15% | **100** | baseline year | — |
| Decentralization | 15% | **45.8** | baseline year | — |

### Adoption

| KPI | Floor (0) | Target (100) | Observed | Score | Source |
| :--- | ---: | ---: | ---: | ---: | :--- |
| `paying-keys` | 20 keys | 60 keys | 41 | 52.5 | API key registry (pro + enterprise) |
| `certified-partners` † | 1 partners | 5 partners | 0 | 0 | derived: npm run partner-scorecard |
| `monthly-requests-millions` | 5 M req | 30 M req | 22.8 | 71.2 | usage analytics |

### Reliability

| KPI | Floor (0) | Target (100) | Observed | Score | Source |
| :--- | ---: | ---: | ---: | ---: | :--- |
| `availability-percent` | 99.5 % | 99.95 % | 99.9 | 88.9 | docs/SLO report (npm run slo:report) |
| `p95-latency-ms` | 500 ms | 150 ms | 210 | 82.9 | Prometheus api latency histogram |
| `history-gap-hours` | 24 h | 0 h | 0 | 100 | history-gap-detection workflow |

### Security

| KPI | Floor (0) | Target (100) | Observed | Score | Source |
| :--- | ---: | ---: | ---: | ---: | :--- |
| `open-high-findings` | 5 findings | 0 findings | 1 | 80 | scripts/check-audit-findings.js |
| `months-since-contract-audit` | 18 months | 6 months | 11 | 58.3 | docs/SECURITY_AUDIT.md |
| `secret-rotation-compliance-percent` | 80 % | 100 % | 92 | 60 | rotate-secrets job evidence |

### Economics

| KPI | Floor (0) | Target (100) | Observed | Score | Source |
| :--- | ---: | ---: | ---: | ---: | :--- |
| `gross-margin-percent` † | 20 % | 60 % | 97.8 | 100 | derived: npm run sustainability:model |
| `runway-months` † | 6 months | 12 months | 14.4 | 100 | derived: npm run sustainability:model |

### Decentralization

| KPI | Floor (0) | Target (100) | Observed | Score | Source |
| :--- | ---: | ---: | ---: | ---: | :--- |
| `active-providers` | 3 providers | 6 providers | 4 | 33.3 | aggregator source config |
| `max-provider-share-percent` | 50 % | 25 % | 25 | 100 | aggregation weight report |
| `independent-publishers` | 1 operators | 3 operators | 1 | 0 | contract submitter allow-list |
| `active-regions` | 1 regions | 3 regions | 2 | 50 | k8s/overlays prod-<region> |

## Prioritized roadmap input

Priority = impact × confidence × (1 + gap ÷ 10) ÷ effort. The gap is the largest
weighted shortfall (100 − score) × weight across the item's dimensions, so work
on weak, heavily weighted dimensions rises. The top 3 items are proposed as
commitments for next year's roadmap, the next 2 as stretch goals, and the rest
stay in the backlog.

| Rank | Item | Title | Dimensions | Impact | Confidence | Effort | Gap | Priority | Proposal |
| ---: | :--- | :--- | :--- | ---: | ---: | ---: | ---: | ---: | :--- |
| 1 | `partner-certification-drive` | Run the partner scorecard with current integrators and close Conditional findings | adoption | 4 | 0.8 | 3 | 11.8 | 2.321 | **Commit** |
| 2 | `annual-audit` | Schedule the next external contract audit | security | 4 | 0.9 | 4 | 8.5 | 1.663 | **Commit** |
| 3 | `pricing-experiment` | Run the registered Pro overage pricing experiment | economics, adoption | 2 | 0.5 | 2 | 11.8 | 1.088 | **Commit** |
| 4 | `fifth-provider` | Add a fifth upstream provider to the median | decentralization, reliability | 4 | 0.7 | 5 | 8.1 | 1.015 | **Stretch** |
| 5 | `third-party-publishers` | Onboard independent price publishers to the contract allow-list | decentralization, security | 5 | 0.6 | 8 | 8.5 | 0.693 | **Stretch** |
| 6 | `latency-budget` | Bring p95 latency under 150ms (cache warmers, query plans) | reliability | 3 | 0.7 | 5 | 2.4 | 0.519 | **Backlog** |
| 7 | `third-region` | Promote a third production region | decentralization, reliability | 3 | 0.6 | 8 | 8.1 | 0.408 | **Backlog** |

## Review procedure

1. **Four weeks before**: Owners refresh measured values in `config/roadmap-review.json`, regenerate the
   sustainability model and partner scorecard, and propose candidate items.
2. **Review session**: Participants challenge the KPI values and the impact, confidence, and effort estimates,
   then regenerate this report. The committed diff is the record.
3. **Hand-off**: Items marked Commit become roadmap epics, each with an owner and a target KPI.
   Last year's dimension scores are copied into `observations.previous` to show the trend.
4. **Checkpoints**: Every 3 months, update KPI values only. A dimension that falls more than 10 points
   triggers an out-of-cycle reprioritization.

## Compatibility, monitoring, and operational impact

- **Compatibility**: Offline tooling that reads the existing sustainability and partner models, with no runtime, API, or contract change.
- **Monitoring**: Every KPI names its source. Reliability and security values come from the existing SLO, gap-detection, and audit tooling.
- **Operational impact**: None on the live price path.

## Rollout and rollback guidance

- **Rollout**: Run the first review with the illustrative inputs replaced by measured values. The first year has no trend.
- **Rollback**: Revert the config and the script. Nothing is persisted outside git.
