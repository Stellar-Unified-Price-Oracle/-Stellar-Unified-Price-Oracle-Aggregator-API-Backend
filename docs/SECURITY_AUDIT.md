# Third-Party Soroban Contract Audit

This document tracks the plan for an independent security audit of
`contracts/price-oracle` ahead of mainnet deployment. Formal verification
(see `docs/formal-verification/`) and fuzzing (`contracts/price-oracle/src/fuzz.rs`)
cover many properties in-repo, but an external auditor adds an adversarial
perspective and strengthens trust for downstream DeFi integrators.

## Scope

The engagement covers the following files in `contracts/price-oracle/src/`:

- `contract.rs` — core contract entry points
- `storage.rs` — on-chain storage layout and access
- `merkle.rs` — Merkle proof verification
- `proxy.rs` — upgrade/proxy pattern
- `governance.rs` — admin and governance operations
- `multisig.rs` — multisig authorization

## Auditor selection criteria

- Demonstrated Soroban/Rust smart-contract audit experience (public reports
  or references).
- No conflict of interest with the project or its integrators.
- Availability to scope and complete the engagement within the target
  mainnet-deployment window.

## Process

1. Request quotes/scoping proposals from candidate auditors against the
   scope above.
2. Select an auditor and formally engage them (contract, NDA if required).
3. Provide the auditor with repo access, the formal verification report
   (`docs/formal-verification/price-oracle-guarantees.md`), and fuzz/test
   coverage as supporting context.
4. On completion, publish the audit report — or a redacted summary if the
   full report can't be made public — under `docs/security-audit/`.
5. File one GitHub issue per finding, labeled with its severity
   (`severity:critical` / `severity:high` / `severity:medium` / `severity:low`),
   and track remediation to closure before mainnet deployment.

## Status

Not yet commissioned. This document defines the scope and process; selecting
and engaging an auditor is a business/procurement action to be carried out
by the project maintainers, tracked against issue #362.
