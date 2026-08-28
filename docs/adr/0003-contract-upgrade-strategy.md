# ADR-0003: Proxy-based upgradeability over an immutable core

**Status:** Accepted

**Date:** 2026-08-27

**Authors:** @rejoicetukura-blip

---

## Context

`contracts/price-oracle` currently ships two live upgrade mechanisms side by
side without a recorded decision between them:

- `ProxyContract` (`contracts/price-oracle/src/proxy.rs`) — an admin-gated,
  in-place WASM swap (`upgrade_wasm`) plus a logical implementation pointer
  (`upgrade`) and a `StorageLayoutVersion` counter for migrations.
- `PriceOracleContract` (`contracts/price-oracle/src/contract.rs`) — the
  oracle's core read/write surface, deployable and usable directly without
  ever going through the proxy.

Nothing in the repo states which of these is the supported production path.
Auditors reviewing the contract and integrators picking a contract ID to
point at have no documented answer, and the two paths have quietly diverged
(e.g. `ProxyContract::submit_price` does not apply the price-history cap that
`PriceOracleContract::submit_price` does).

## Decision

Adopt **proxy-based upgradeability** as the supported strategy for
production and testnet deployments. Concretely:

- `ProxyContract` is the contract ID that source publishers, the API, and
  integrators are given. `PriceOracleContract` is upgraded *through* the
  proxy's `upgrade_wasm` (WASM hash swap, storage preserved in place) or
  `upgrade` (logical implementation-pointer swap), never redeployed as a
  fresh, un-migrated contract ID.
- `StorageLayoutVersion` (`ProxyContract::get_storage_layout_version` /
  `set_storage_layout_version`) must be bumped whenever a change adds or
  reinterprets a `DataKey` variant, so migration code introduced in a future
  upgrade can detect which layout it is running against.
- Upgrades that change authorization or state (adding sources, pausing,
  transferring admin) go through the existing multi-sig proposal flow
  (`init_multisig` / `create_proposal` / `apply_proposal_action` in
  `contract.rs`) rather than a bare admin call, consistent with issue #379's
  emergency-pause guard.
- `contracts/price-oracle/src/upgrade_migration_test.rs` (issue #381) is the
  regression gate: it re-registers the running contract implementation at a
  fixed contract ID — the same effect `upgrade_wasm` has on testnet/mainnet —
  and asserts prices, sources, batch nonce, and multi-sig config all survive.

### Migration path for existing testnet deployments

Any testnet deployment currently pointing directly at a bare
`PriceOracleContract` ID (bypassing the proxy) should migrate as follows:

1. Deploy a fresh `ProxyContract` instance, calling `initialize(admin,
   implementation)` with `implementation` set to the existing
   `PriceOracleContract` ID.
2. Re-point aggregator/API config (`CONTRACT_ID` in `.env`, `k8s` configmaps)
   at the new proxy ID.
3. Re-submit any oracle-source authorizations against the proxy ID — the
   proxy's storage starts empty; it does not inherit the old contract's
   `DataKey` state, since it is a distinct contract instance.
4. Retire the old bare `PriceOracleContract` ID once traffic has fully moved
   (do not upgrade it in place — it was never the supported upgrade target).

Deployments already created through `scripts/deploy-soroban.js` targeting a
proxy ID need no migration; they upgrade in place via `upgrade_wasm` with
zero data movement.

## Consequences

### Positive

- One documented, tested upgrade path — no more guessing which contract ID
  is safe to upgrade in place.
- The upgrade migration test (issue #381) gives every future upgrade a
  concrete regression check instead of manual testnet verification.
- Multi-sig-gated upgrades and pauses share one authorization model.

### Negative / Trade-offs

- An extra cross-contract hop (proxy → implementation) versus a fully
  immutable, single-address contract, at a small gas cost per call.
- `ProxyContract` and `PriceOracleContract` currently duplicate oracle logic
  rather than one delegating to the other via cross-contract call; the
  history-cap divergence noted above is a pre-existing symptom of that
  duplication and is tracked separately — this ADR does not resolve it.

## Alternatives considered

| Alternative | Why rejected |
|-------------|--------------|
| Fully immutable core, no upgrade path | Any bug or new requirement (e.g. issue #379's pause) would require a full re-deploy and re-migration of every integrator; unacceptable operational risk for a live price feed. |
| Immutable core + external migrator contract | Adds a second contract integrators must trust and re-authorize against on every upgrade, with no clear advantage over the proxy pattern already implemented. |

## References

- Issues #379, #380, #381
- `contracts/price-oracle/src/proxy.rs`
- `contracts/price-oracle/src/upgrade_migration_test.rs`
- `DEPLOY.md` §3 (Soroban Contract deployment)
