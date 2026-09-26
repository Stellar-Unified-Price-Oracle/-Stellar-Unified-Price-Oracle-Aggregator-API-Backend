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

## Permissionless batch-apply rationale (Issue #570)

`apply_batch_entry` is callable by anyone without a signed source credential.
The authorization happened at commit time: `submit_batch` requires an
authorized source to sign the transaction containing the Merkle root.  After
that, the cryptographic proof is the authorization — only the committed root
can produce a valid proof, and the root was signed by a registered source.

**Why the apply entrypoint is permissionless:**

* Requiring re-authorization per `apply_batch_entry` would cost the same as
  `submit_price` (account lookup + simulation + full auth check + nonce), which
  defeats the purpose of the batch path.  The commit-and-prove model is the
  entire reason batching is cheaper.
* The alternative — applying all entries inside `submit_batch` — would require
  the full batch payload to be included in one transaction, hitting the Stellar
  transaction-size limit for large batches.

**Compensating controls (as of issue #570):**

1. **Deviation threshold** — `apply_batch_entry` now enforces the configured
   threshold against the last on-chain price, the same as `submit_price`.  A
   batch entry that jumps more than the threshold is rejected with
   `PriceDeviationTooLarge`, not silently applied.
2. **Replay resistance** — each `(batch_nonce, leaf_index)` pair can be applied
   exactly once (`mark_batch_leaf_applied`).  Repeated proof submissions are
   rejected with `BatchEntryAlreadyApplied`.
3. **Batch-size enforcement** — `leaf_index >= batch_size` is rejected with
   `BatchIndexOutOfRange`, closing the phantom-slot exploit from issue #567.
4. **Root expiry** — only the last `RETAINED_BATCH_ROOTS` (16) batches are
   retained.  Proofs for expired batches are rejected with `BatchRootNotFound`.
5. **Source reputation** — `apply_batch_entry` now calls `update_reputation` so
   sources that exclusively use the batch path accumulate accuracy history and
   can be ranked down if their prices drift.
6. **Emergency pause** — `ContractPaused` halts both `submit_batch` and
   `apply_batch_entry`; a paused batch cannot be applied after the freeze is
   lifted.

**Residual risk:** An authorized source can commit a batch that passes
deviation at commit time but whose individual entries would individually
violate the threshold by the time they are applied (because another source
updated the reference price in between).  The deviation check in
`apply_batch_entry` uses the *latest* on-chain price at apply time, which is
the most conservative baseline available without locking the reference price at
commit time.
