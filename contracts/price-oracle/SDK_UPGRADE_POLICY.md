# Soroban SDK Upgrade Policy

> Issue #384 — control when and how the Soroban SDK version changes.

The `soroban-sdk` dependency is **pinned exactly** in `Cargo.toml`
(`soroban-sdk = "=27.0.6"`), so dependency resolution can never silently float
to a newer SDK.  This is deliberate: SDK releases can change gas metering,
serialization, and host-function behavior, all of which the price-oracle
contract is sensitive to (gas budget for permissionless entry points, storage
key XDR for state migration, event encoding).

## Tracking

| Where | What is tracked |
|-------|-----------------|
| `contracts/price-oracle/Cargo.toml` | Exact pinned version (`=27.0.6`) |
| `contracts/price-oracle/Cargo.lock` | Resolved dependency graph (committed) |
| Release SBOM | `cargo cyclonedx` emits `sbom-contract.cdx.json` (see `.github/workflows/sbom.yml`), which records every crate in the contract's lockfile including the SDK |

Verify the pinned SDK appears in the SBOM with:

```bash
cd contracts/price-oracle
cargo cyclonedx --format json --override-filename /tmp/sbom-contract.cdx
jq '.components[] | select(.name == "soroban-sdk") | .version' /tmp/sbom-contract.cdx.json
```

## Upgrade cadence

- **Quarterly evaluation**: every three months, evaluate whether an SDK bump is
  warranted (new features, security fixes, protocol compatibility).  Record the
  outcome in the release notes even when the decision is "stay on the pinned
  version".
- **Testnet soak required**: a bump only ships to mainnet after at least two
  weeks on testnet with the aggregator submitting prices at the production
  cadence (30 s), plus a full run of the contract test suite
  (`cargo test`) and the gas benchmarks (`cargo test bench_ --lib -- --nocapture`).
  Compare instruction counts against the previous SDK; flag any regression
  > 5% on the hot paths (`submit_price`, `apply_batch_entry`).
- **No silent bumps**: an SDK change must be its own PR with the measured
  before/after gas table and a `StorageLayoutVersion` review (see
  `docs/adr/0003-contract-upgrade-strategy.md` if storage keys change).

## Rollback

If an SDK bump regresses gas, behavior, or serialization after deployment:

1. **Revert the commit** that changed `Cargo.toml`/`Cargo.lock` back to the
   previously pinned version (`=27.0.6`).
2. **Re-run the full test suite and gas benchmarks** locally; confirm the
   regressed numbers return to baseline.
3. **Rebuild the WASM** (`cargo build --release`) and redeploy via the
   documented upgrade path (`ProxyContract::execute_upgrade` after the
   multi-sig quorum and timelock, or the deploy scripts in `scripts/`).
4. If the regression involves storage-key serialization (new/changed
   `DataKey` variants), bump `StorageLayoutVersion` and run
   `cargo test upgrade_migration` to prove state survives the swap.
5. Keep the failed bump documented in the release notes so the next quarterly
   evaluation knows what regressed and why.
