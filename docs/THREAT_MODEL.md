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
| Merkle tree second-preimage attack (internal node forged as leaf) | Domain separation (RFC 6962 pattern): prefix leaf hashes with 0x00 tag and internal node hashes with 0x01 tag; max co-path bounded to 64 siblings | Implemented (Issue #566) |

## Merkle tree construction & proof soundness rules (Issue #566)

To prevent second-preimage attacks where an internal node hash could be presented as a valid leaf preimage in `apply_batch_entry`, the contract verifier (`contracts/price-oracle/src/merkle.rs`) and the off-chain builder (`services/aggregator/src/infrastructure/merkle.ts`) adhere to strict domain separation:

1. **Leaf Domain Tag (`0x00`)**:
   `hash_leaf(entry) = SHA-256(0x00 || asset_bytes || 0x00 || price_be16 || decimals_be4 || timestamp_be8 || source_bytes)`
2. **Internal Node Domain Tag (`0x01`)**:
   `hash_pair(left, right) = SHA-256(0x01 || left || right)`
3. **Co-Path Length Bounding**:
   Proofs with sibling lists longer than `MAX_PROOF_SIBLINGS = 64` are rejected immediately prior to hashing.
4. **Drift Prevention**:
   Any modification to the leaf layout or hashing domain tags must be made simultaneously in both the Rust contract and TypeScript aggregator builder, with formal invariant checks verified in `verification/smt/price-oracle-invariants.smt2`.

## Whitelist — fee-exempt consumer allowlist (issue #561)

The `Whitelist(Address)` storage key and the `set_whitelist` / `is_whitelisted`
entrypoints implement a **fee-exempt consumer allowlist**.  The semantics are:

- When the query fee (`QueryFee`) is zero the `get_price` endpoint is open to
  all callers.  The whitelist has no effect.
- When the query fee is non-zero, `get_price` returns `NotWhitelisted` for any
  caller that is not on the list.  The list is managed exclusively by the admin
  via `set_whitelist(admin, addr, true|false)`.
- `is_whitelisted(addr)` is a read-only query so operators can verify the
  current state without re-reading raw storage.

### What the whitelist does NOT protect against

- **Submission authorization** — `submit_price`, `submit_batch`, and
  `apply_batch_entry` authorize through `is_authorized_source` (the
  `Source(Address)` storage key), not the whitelist.  A whitelisted address
  that is not an authorized source will still be rejected by every submission
  path.
- **Emergency pause** — the pause flag halts all submissions regardless of
  whitelist status.
- **Staking / slashing** — unrelated to the whitelist.
- **Admin operations** — all admin-only entrypoints require `verify_admin` on
  top of `require_auth`; whitelist status confers no elevated privilege.

## Review cadence

This document must be reviewed:

- In the run-up to mainnet launch.
- After any major feature addition (e.g. a new region, a new source
  integration, the WASM plugin execution host).

Update the threats table above with new entries and link each to its owning
issue or doc when a control is only partially implemented.
