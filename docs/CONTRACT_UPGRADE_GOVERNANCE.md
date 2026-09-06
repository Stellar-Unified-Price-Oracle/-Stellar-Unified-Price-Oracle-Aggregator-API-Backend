# Contract Upgrade Governance

This document describes how upgrades to the oracle, governance, and multi-sig
Soroban contracts are proposed, approved, and deployed, and how to respond to
an emergency that requires an out-of-band change.

## Proposal lifecycle

1. **Draft** — the proposer opens a `MultiSigProposal` or token-governance
   proposal via `api/src/governance/proposal-service.ts`, targeting one of the
   `ProposalAction` variants defined in `proposal-types.ts` (e.g.
   `TransferAdmin`, `SetAdmin`, `UpdateGovernanceConfig`).
2. **Review** — signers/token-holders inspect the proposal through
   `proposal-routes.ts` endpoints. For contract-code upgrades, the proposal
   description must link the exact WASM hash and a diff/changelog against the
   currently deployed contract.
3. **Approval** — multi-sig proposals require `threshold` approvals from
   `MultiSigConfig.signers`; token-governance proposals require the configured
   quorum and majority under `GovernanceConfig`.
4. **Execution** — once thresholds are met, the proposal is executed on-chain,
   invoking the corresponding contract entrypoint (e.g. admin transfer,
   signer/threshold change, or the proxy's upgrade entrypoint with the new
   WASM hash).
5. **Verification** — after execution, confirm the on-chain contract state
   (admin, signer set, WASM hash) matches the proposal before announcing the
   upgrade as complete.

## Multi-sig administration

- Signer membership changes (`AddSigner` / `RemoveSigner`) and threshold
  changes (`SetThreshold`) are themselves proposals, subject to the same
  approval flow as any other action — no single signer can unilaterally alter
  the signer set.
- Admin transfer (`TransferAdmin` / `SetAdmin`) must be proposed and approved
  the same way; it is never performed via a direct, unproposed transaction.
- Signer keys should be custodied per `docs/KEY_MANAGEMENT.md`.
- For the complete operator runbook — signer setup, threshold guidance, the
  create → approve → execute lifecycle, emergency guardian procedures, and
  troubleshooting — see [Multi-Sig Administration & Operations](./MULTISIG_ADMINISTRATION.md).

## Proxy upgrade procedure

1. Build and test the new contract WASM in isolation (unit + integration
   tests, plus a testnet deployment).
2. Submit an `UpdateGovernanceConfig`-style or dedicated upgrade proposal
   referencing the new WASM hash.
3. Once approved, invoke the proxy's upgrade entrypoint with the new WASM
   hash. Do not skip the approval step, even for hotfixes — use the emergency
   protocol below instead.
4. Re-run the read-only contract invariants (admin address, source list,
   thresholds) against the upgraded contract to confirm state was preserved.

## Storage migration steps

- Before upgrading a contract whose storage layout changes, write a migration
  note describing old vs. new storage keys/shapes.
- Deploy the new WASM to testnet first and run a full read/write cycle to
  confirm existing storage entries deserialize correctly.
- If a migration function is required, it must be a proposal-gated
  entrypoint (never callable by an arbitrary address) and should be
  idempotent so a retry after partial failure is safe.
- After a mainnet migration, verify a sample of pre-upgrade storage entries
  against their expected post-upgrade values before closing out the change.

## Emergency response protocol

- Emergency changes (e.g. pausing source ingestion, rotating a compromised
  signer) still go through the proposal flow, but signers should treat them
  as highest priority for approval.
- If a signer key is suspected compromised, propose `RemoveSigner` for that
  key and `AddSigner` for its replacement in the same review cycle, and
  rotate the underlying key per `docs/KEY_MANAGEMENT.md`.
- Document every emergency action after the fact in an incident note under
  `docs/runbooks/`, including the proposal ID, approving signers, and
  timeline.
