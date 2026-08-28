# Threat Model — Mainnet Topology

Covers the current multi-region, post-quantum (PQ), and governance-enabled
architecture. Supersedes any earlier single-region MVP assumptions.

## Trust boundaries

1. **External price sources → aggregation service** — Chainlink, Redstone,
   Band, Reflector, and third-party programmable/WASM feed sources are
   untrusted inputs.
2. **API service → Soroban contract** — the API submits price updates and
   reads contract state over RPC; the contract is the source of truth.
3. **Client → API service** — public HTTP surface, untrusted callers.
4. **Region → region (multi-region/active-active)** — replication and
   failover traffic between deployment regions.
5. **Marketplace plugin authors → plugin runtime** — third-party WASM/DSL
   feed definitions submitted for execution (see
   `docs/SANDBOX_SECURITY_REVIEW.md`).
6. **CI/CD → production** — build and deploy pipeline with the power to ship
   code and, for contracts, deploy immutable on-chain logic.

## Attacker profiles

| Profile | Capability | Primary targets |
|---|---|---|
| Malicious price source | Controls one upstream feed's reported price | Aggregation/median logic, deviation guards |
| Malicious plugin author | Submits a crafted programmable feed / WASM plugin | Plugin sandbox, host resources |
| Network attacker | MITM/DoS on RPC or source connections | Availability, staleness guards |
| Compromised CI credential | Write access to build/deploy pipeline | Supply chain, mainnet contract deploys |
| Malicious/careless contributor | Opens PRs against the repo | Unreviewed code reaching `main` |
| Future quantum adversary | Breaks classical signature schemes | Long-lived signed data, PQ migration window (see `docs/PQ_READINESS.md`) |

## Threats and mitigations

| Threat | Mitigation | Status / tracking |
|---|---|---|
| Single malicious/faulty source skews the reported price | Multi-source aggregation with configurable `minSources`, deviation bounds (`maxDeviationBps`), staleness guards | Implemented (`FeedGuards`) |
| Stale data reported as live | `stalenessSeconds` guard per feed | Implemented |
| Plugin sandbox escape or resource exhaustion | No WASM execution host exists yet; guarantees required before one ships are documented | Tracked — `docs/SANDBOX_SECURITY_REVIEW.md` |
| Unauthorized/unreviewed change merged to `main` | Required PR reviews, CI status checks, CODEOWNERS routing, signed commits | Tracked — `docs/GOVERNANCE.md`, `.github/CODEOWNERS` |
| Compromised deploy credentials push a malicious mainnet contract | Mainnet deploys follow a documented, verifiable runbook; contracts are immutable once deployed, limiting blast radius to a single bad instance | Tracked — `docs/runbooks/mainnet-deployment.md` |
| Region failover injects stale or conflicting state | Active-active replication design | See `docs/active-active-multi-region.md` |
| Classical signatures broken by a future quantum adversary | PQ signature migration plan | See `docs/PQ_READINESS.md` |
| CI/CD compromise ships malicious code | Branch protection + required status checks prevent bypassing CI | Tracked — `docs/GOVERNANCE.md` |

## Review cadence

This document must be reviewed:

- In the run-up to mainnet launch.
- After any major feature addition (e.g. a new region, a new source
  integration, the WASM plugin execution host).

Update the threats table above with new entries and link each to its owning
issue or doc when a control is only partially implemented.
