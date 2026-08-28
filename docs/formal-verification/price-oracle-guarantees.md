# Stellar Price Oracle formal guarantees

The verification model in `specs/PriceOracle.tla` defines the expected safety behavior for the Soroban price oracle under arbitrary transaction ordering.

The current model covers these properties:

- No loss of funds: the oracle contract does not transfer or escrow token balances in the modeled operations.
- Price non-negativity: stored submitted prices are zero or positive.
- Access control: admin-only source-management operations require the initialized admin.
- Write-once initialization: after initialization, the admin cannot be overwritten by another initialize call.
- Price monotonicity per source: source-asset timestamps are non-decreasing.
- Bounded storage: price history per asset is capped by `MAX_HISTORY_LEN`.

SMT invariants live in `verification/smt/price-oracle-invariants.smt2`. They encode storage preservation checks for price non-negativity, timestamp monotonicity, and admin authorization.

Property-style Rust tests live in `contracts/price-oracle/src/fuzz.rs` and are run by `cargo test`. CI generates `verification/reports/latest.md` for each pull request and uploads it as an artifact.

Independent verification:

1. Run `cargo test` in `contracts/price-oracle`.
2. Run `z3 verification/smt/price-oracle-invariants.smt2` if Z3 is installed; every query should return `unsat`.
3. Run `node scripts/generate-verification-report.mjs` from the repository root.
