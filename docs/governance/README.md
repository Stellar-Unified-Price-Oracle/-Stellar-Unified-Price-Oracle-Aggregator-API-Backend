# Governance transparency

Operational and methodological documentation for the governance/decentralization
workstream. Each document names an owner, the published scope, the measurement
or review procedure, and the rollout/rollback path for the corresponding
surface.

| Document | Issue | Owner | Published surface |
|---|---|---|---|
| [Governance health](./GOVERNANCE_HEALTH.md) | #777 | Governance Working Group | `GET /api/v1/governance/health` |
| [Community release review windows](./COMMUNITY_RELEASE_REVIEW.md) | #779 | Release Management + Governance Working Group | `GET /api/v1/governance/release-windows` |
| [Testnet governance rehearsal](./TESTNET_REHEARSAL.md) | #780 | Governance Working Group | `GET /api/v1/governance/rehearsals/latest` |
| [Treasury transparency](./TREASURY_TRANSPARENCY.md) | #781 | Treasury Committee | `GET /api/v1/governance/treasury`, `/portal/governance/treasury.html` |

All four surfaces are read-only, unauthenticated (rate-limited like every other
API path), and served under `/api/v1/governance`. They are mounted **before**
the admin proposal router, so governance publication never depends on an admin
key — and never exposes one.

## Published artifacts

The API reads four JSON artifacts from `GOVERNANCE_TRANSPARENCY_DIR`
(default `api/data/governance`):

| File | Producer | Consumed by |
|---|---|---|
| `governance-snapshot.json` | nightly governance snapshot job | `GET /governance/health` |
| `treasury-snapshot.json` | treasury reconciliation job | `GET /governance/treasury` |
| `release-review.json` | release calendar owners | `GET /governance/release-windows`, `check:release-windows` |
| `rehearsal-report.json` | rehearsal runner | `GET /governance/rehearsals/latest` |

Artifacts are validated with Zod on read. A missing artifact returns
`404 GOVERNANCE_DATA_UNAVAILABLE`, a malformed one returns
`422 GOVERNANCE_DATA_INVALID`; neither is reported as a healthy empty result.

## Privacy posture

The health report is the only surface with a privacy methodology. It publishes
aggregates only — never voter, delegator, or delegate addresses, individual
voting power, or delegation edges — and suppresses any distribution statistic
backed by fewer than `k = 10` members. The treasury and release surfaces
publish the ledger and calendar entries that are already public on-chain or
publicly announced.
