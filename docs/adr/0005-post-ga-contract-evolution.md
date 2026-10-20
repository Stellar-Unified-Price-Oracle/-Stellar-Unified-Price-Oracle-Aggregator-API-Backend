# ADR-0005: Post-GA contract evolution strategy

**Status:** Accepted

**Date:** 2026-10-19

**Authors:** @stellar-oracle-contract-team

---

## Context

The `contracts/price-oracle` Soroban contract is now generally available
(GA). Integrators have written dApps against `get_price`,
`get_price_history`, `get_assets`, and related entrypoints, usually through
the proxy contract ID established in ADR-0003. The contract is live on
testnet and mainnet with real stake, real price submissions, and real
downstream consumers.

ADR-0003 chose proxy-based upgradeability as the supported path, and
CONTRACT_VERSIONING.md defined additive vs. breaking change rules and the
`API_VERSION` counter. What was missing: a single decision record for the
**post-GA** era that states the evolution strategy, upgrade constraints,
compatibility guarantees, and explicit decision gates for the next protocol
version.

## Decision

### Supported evolution strategy

The contract evolves through **proxy-based, state-preserving WASM upgrades**
(ADR-0003), governed by the existing multi-sig proposal flow
(`init_multisig` / `create_proposal` / `apply_proposal_action`). The proxy
contract ID remains the stable integration point; `PriceOracleContract` is
never redeployed as a fresh, un-migrated contract ID.

Every upgrade:

- Preserves storage in place (instance + persistent storage survives the
  WASM swap).
- Runs through `ProxyContract::upgrade_wasm` (WASM hash swap) or
  `ProxyContract::upgrade` (logical implementation-pointer swap), never a
  bare re-deploy.
- Is gated by multi-sig when it changes authorization or state
  (adding sources, pausing, transferring admin, setting query fees).

### Upgrade constraints

| Change class | `API_VERSION` bump? | Gate | Example |
|---|---|---|---|
| Additive — new entrypoint | No | Multi-sig only if it touches auth/state | `get_price_history_since` |
| Additive — new struct field appended at end | No | Multi-sig only if it touches auth/state | `price_usd` on `AssetPrice` |
| Additive — new enum variant appended | No | Multi-sig only if it touches auth/state | New `DegradationLevel` |
| Additive — loosening a constraint | No | Multi-sig only if it touches auth/state | Wider decimals range accepted |
| Breaking — remove/rename entrypoint | **Yes** | Multi-sig + deprecation window + canary | Dropping `get_query_fee` |
| Breaking — change argument types/arity | **Yes** | Multi-sig + deprecation window + canary | `submit_price(asset, price, ...)` → new order |
| Breaking — change field meaning/order | **Yes** | Multi-sig + deprecation window + canary | Reordering `AssetPrice` fields |
| Breaking — tighten constraints | **Yes** | Multi-sig + deprecation window + canary | Newly rejecting previously-valid decimals |
| Breaking — add auth to existing entrypoint | **Yes** | Multi-sig + deprecation window + canary | `get_price` now requires `require_auth` |
| Breaking — change event topics | **Yes** | Multi-sig + deprecation window + canary | New `PriceSubmitted` topic layout |
| Storage layout change (`DataKey` variant) | No* | Migration code + `StorageLayoutVersion` bump | Adding a new `DataKey` |

\* `StorageLayoutVersion` is bumped whenever a change adds or reinterprets a
`DataKey` variant, so migration code can detect which layout it is running
against. This does not affect `API_VERSION` because it is not an interface
change.

### Compatibility guarantees

1. **`API_VERSION` stability.** `get_api_version()` returns the exported ABI
   version. It is stable across all non-breaking upgrades. Consumers can gate
   integrations on it: if the on-chain value differs from the version they
   compiled against, the interface may no longer be valid.

2. **Additive changes are invisible.** Additive changes (new entrypoints,
   appended fields, appended enum variants, loosened constraints) never break
   existing consumers. Old clients continue to receive the same struct shape
   they expect; unknown trailing fields are ignored.

3. **Breaking changes have a deprecation window.** Before any `API_VERSION`
   bump lands on mainnet, the old interface is kept alive wherever practical
   (thin shim behind a `Deprecated` changelog entry) and the break is
   announced in `contracts/price-oracle/CHANGELOG.md` and via
   `docs/runbooks/mainnet-deployment.md`. Where gas/storage costs make a shim
   impractical, the deprecation is still announced before the bump.

4. **State survives upgrades.** Every upgrade is state-preserving. Prices,
   sources, stake, multi-sig config, and batch nonces all survive a WASM
   swap at a fixed contract ID. This is regression-gated by
   `contracts/price-oracle/src/upgrade_migration_test.rs`.

5. **The proxy is the integration point.** Integrators point at the proxy
   contract ID, never a bare `PriceOracleContract` ID (ADR-0003).

### Decision gates for the next protocol version

A proposal to evolve the contract (bump `API_VERSION` or introduce a
protocol-level change) must pass all of the following gates before it is
submitted as a multi-sig proposal:

| Gate | Requirement | Evidence |
|---|---|---|
| G1 — Compatibility analysis | Document which v1 consumers break and how they migrate | Changelog `### Removed` / `### Changed` entry + migration path |
| G2 — Deprecation window | Old interface kept alive (shim or announced sunset) | `docs/runbooks/mainnet-deployment.md` note + changelog |
| G3 — Canary validation | New version exercised on a canary contract with traffic share | `docs/CANARY_DEPLOYMENTS.md` canary report |
| G4 — Regression tests | `compat_test.rs` extended with new expectations + break comment | `cargo test` passes including compat suite |
| G5 — Multi-sig approval | Proposal approved by the configured threshold signers | Multi-sig proposal record on-chain |
| G6 — Operator rollout plan | Rollout + rollback steps documented for mainnet | Deploy runbook updated |

If any gate fails, the evolution does not proceed.

### Migration path for existing deployments

Existing mainnet/testnet deployments pointing at a proxy ID upgrade in place
via `upgrade_wasm` — zero data movement, zero consumer re-configuration
beyond re-reading `get_api_version()` if they pin it.

Deployments pointing directly at a bare `PriceOracleContract` ID bypassing
the proxy should migrate per ADR-0003 § "Migration path for existing
testnet deployments" before the next upgrade.

## Consequences

### Positive

- One documented, tested evolution path for the post-GA contract.
- Consumers know exactly what breaks (`API_VERSION` bump) and what does not
  (additive changes).
- Every breaking change carries a deprecation window and canary validation.
- State is never lost across upgrades.

### Negative / Trade-offs

- Breaking changes require multi-sig + canary + deprecation window, which
  slows down protocol evolution. This is intentional for a GA price feed.
- `StorageLayoutVersion` bumps require migration code to be written and
  reviewed alongside the contract change.
- The extra cross-contract hop (proxy → implementation) remains a small gas
  cost per call.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Fully immutable contract, no upgrades | Any bug or new requirement forces a full re-deploy and re-migration of every integrator; unacceptable for a live price feed. |
| Immutable core + external migrator | Adds a second contract integrators must trust and re-authorize; no advantage over the proxy pattern already implemented. |
| Breaking changes without deprecation window | Would break live dApps without notice; unacceptable operational risk. |

## References

- Issues #721
- ADR-0003 — Proxy-based upgradeability over an immutable core
- CONTRACT_VERSIONING.md — ABI/interface versioning policy
- `contracts/price-oracle/src/contract/mod.rs` — `API_VERSION = 1`
- `contracts/price-oracle/src/storage.rs` — `get_contract_version`, `get_storage_layout_version`
- `contracts/price-oracle/src/upgrade_migration_test.rs` — state-preservation regression gate
- `docs/CONTRACT_UPGRADE_GOVERNANCE.md` — upgrade approval flow
- `docs/CANARY_DEPLOYMENTS.md` — canary rollout process
- `docs/runbooks/mainnet-deployment.md` — mainnet deployment runbook
- `contracts/price-oracle/CHANGELOG.md` — contract release log
