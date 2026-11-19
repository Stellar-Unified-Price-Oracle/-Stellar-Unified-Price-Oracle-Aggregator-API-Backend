# Ecosystem Partner Scorecard (Issue #797)

This scorecard defines what "ready" means for an ecosystem partner, meaning any
protocol, wallet, SDK, or service that consumes the oracle in production. It
covers integration quality, operational readiness, security, and support. This
document is generated from `config/partner-scorecard.json` by
`scripts/partner-scorecard.mjs`. `npm run partner-scorecard:check` fails CI
when the criteria are invalid or this file is stale.

## Owner and scope

- **Owner**: economics-sustainability-team (Economics and ecosystem sustainability workstream)
- **Reviewers**: Developer Relations Lead, Security on-call, Platform Operations
- **In scope**: Partners consuming production feeds through the REST/WS API or on-chain contract
- **Out of scope**: Upstream oracle providers, which are covered by docs/PROVIDER_ECOSYSTEM_READINESS.md

## Scoring

Each category score is the weighted share of its criteria that pass. The overall
score is the category-weighted average (0–100). Missing evidence counts as a
failure. A partner that fails any **critical** criterion can't be rated above
**Not ready**, whatever its score.

| Rating | Minimum score | All critical criteria must pass |
| :--- | ---: | :---: |
| **Certified** | 85 | yes |
| **Conditional** | 70 | yes |
| **Not ready** | 0 | no |

## Criteria

### Integration quality (weight 30%)

| Criterion | Metric | Pass when | Weight | Critical | Evidence |
| :--- | :--- | :--- | ---: | :---: | :--- |
| `staleness-guard` | `rejectsStalePrices` | yes | 3 | yes | Code review or test showing prices older than the feed heartbeat are rejected |
| `decimals-normalized` | `normalizesDecimals` | yes | 3 | yes | Integration test reading `decimals` per response instead of assuming a scale |
| `readiness-probe` | `readinessProbePassRatePercent` | ≥ 99 | 2 |  | `scripts/integrator-readiness-probe.mjs` pass rate over 30 days |
| `supported-sdk` | `onSupportedSdkVersion` | yes | 1 |  | SDK version vs. docs/integrators/sdk-release-compatibility.md |
| `deprecated-usage` | `deprecatedEndpointTrafficPercent` | ≤ 5 | 1 |  | Usage analytics: share of requests to deprecated routes |

### Operational readiness (weight 25%)

| Criterion | Metric | Pass when | Weight | Critical | Evidence |
| :--- | :--- | :--- | ---: | :---: | :--- |
| `rate-limit-hygiene` | `throttledRequestPercent` | ≤ 2 | 2 |  | Share of requests answered 429 over 30 days |
| `fallback-path` | `hasFallbackOrCircuitBreaker` | yes | 3 | yes | Documented behaviour when the oracle is unavailable or stale |
| `staleness-alerting` | `alertsOnStaleness` | yes | 2 |  | Partner alert rule or dashboard screenshot |
| `incident-response` | `incidentContactResponseMinutes` | ≤ 60 | 2 |  | Measured response time from the last contact drill |

### Security (weight 30%)

| Criterion | Metric | Pass when | Weight | Critical | Evidence |
| :--- | :--- | :--- | ---: | :---: | :--- |
| `key-storage` | `apiKeyInSecretManager` | yes | 3 | yes | Attestation that keys are not in source, client bundles or logs |
| `key-rotation` | `keyRotationDays` | ≤ 90 | 2 | yes | Key age from the API key registry |
| `open-critical-vulns` | `openCriticalVulnerabilities` | ≤ 0 | 3 | yes | Partner disclosure plus dependency scan |
| `recent-audit` | `monthsSinceSecurityAudit` | ≤ 18 | 2 |  | Audit report date for contracts consuming the feed |

### Support (weight 15%)

| Criterion | Metric | Pass when | Weight | Critical | Evidence |
| :--- | :--- | :--- | ---: | :---: | :--- |
| `named-contact` | `hasNamedTechnicalContact` | yes | 3 | yes | Contact registered and reachable within 7 days of the request |
| `deprecation-notices` | `subscribedToDeprecationNotices` | yes | 2 |  | Subscription to release notes / deprecation channel |
| `ticket-resolution` | `medianTicketResolutionHours` | ≤ 72 | 1 |  | Median resolution of joint support tickets (docs/integrators/support-expectations.md) |

## Review process

1. **Intake**: The partner registers a named technical contact and submits evidence for every metric.
   Evidence goes into `config/partner-scorecard.json` through a PR.
2. **Measurement**: Reviewers verify the evidence. Usage-derived metrics (429 rate, deprecated traffic,
   probe pass rate) come from our own analytics, not the partner's self-report.
3. **Scoring**: `npm run partner-scorecard` regenerates this report. The PR diff is the review record.
4. **Decision**: All reviewers sign off within 10 business days. **Conditional** partners get an
   action list from the findings below and a re-review date no later than 90 days out.
5. **Re-review**: Full review every 12 months, or sooner after major SDK upgrade, new production feed consumed, security incident, two consecutive missed SLOs.
6. **Appeal**: A partner may supply new evidence at any time. The score is recomputed on the same criteria.

## Current results

| Partner | Integration quality | Operational readiness | Security | Support | Overall | Rating | Next review |
| :--- | ---: | ---: | ---: | ---: | ---: | :--- | :--- |
| `example-lending-protocol` | 100 | 100 | 100 | 100 | **100** | **Certified** | 2027-11-19 |
| `example-wallet-dashboard` | 60 | 77.8 | 60 | 100 | **70.4** | **Not ready** | 2027-11-19 |

## Findings

### `example-lending-protocol`

_Worked example with synthetic evidence. Not a real partner._

- All criteria met.

### `example-wallet-dashboard`

_Worked example with synthetic evidence. Not a real partner._

- `readiness-probe`: observed 97
- `supported-sdk`: observed false
- `deprecated-usage`: observed 12
- `staleness-alerting`: observed false
- `key-rotation` (critical): observed 120
- `recent-audit`: no evidence supplied

## Compatibility, monitoring, and operational impact

- **Compatibility**: Offline review tooling with no change to the API, the aggregator, or the contract. Ratings don't change rate limits or access by themselves.
- **Monitoring**: The usage metrics behind the scorecard already exist (usage analytics, 429 counters, readiness probe). Reviewers pull them at each review.
- **Operational impact**: None on the live price path.

## Rollout and rollback guidance

- **Rollout**: Score existing production partners first, without consequences, for one cycle. After that, use the rating for listing and support-priority decisions.
- **Rollback**: Revert the config and the script. Ratings are advisory and leave no persisted state.
