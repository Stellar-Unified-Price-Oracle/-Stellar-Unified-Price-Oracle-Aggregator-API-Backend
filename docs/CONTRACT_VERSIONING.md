# Contract ABI/Interface Versioning & Backwards-Compatibility Policy

**Status:** Adopted

**Owner:** Contract team (issue #383)

This document defines how the exported interface of the
`contracts/price-oracle` Soroban contracts evolves without breaking
integrators. Consumers call `get_price` / `get_price_history` (usually
through the proxy contract id) from their dApps; a breaking change to those
entrypoints breaks their applications. The rules below make breaking changes
detectable, documented, and rare.

## The three version counters

The repository tracks three **distinct** numbers. Do not conflate them:

| Counter | Where | Meaning | Bumped when |
|---|---|---|---|
| `API_VERSION` | `contracts/price-oracle/src/contract.rs` (`API_VERSION`), exposed via `get_api_version()` | The exported **ABI/interface** version integrators compile against | Only on **breaking** interface changes |
| Contract deployment version | `ProxyContract::get_version()` | Number of upgrades/deployments applied to a given proxy instance | Every `upgrade()` / `promote_canary()` |
| `StorageLayoutVersion` | `ProxyContract::get_storage_layout_version()` | Internal on-chain storage layout revision, for migration code | Any change that adds/reinterprets a `DataKey` variant |

A consumer that checks `get_api_version()` learns whether the interface it
compiled against is still valid. `get_version()` and
`get_storage_layout_version()` are operational concerns for operators and
migration code, not interface contracts.

## Additive vs. breaking changes

### Additive changes (allowed without bumping `API_VERSION`)

- **New entrypoints** — e.g. adding `get_api_version()` does not affect any
  existing call.
- **New fields appended to a returned struct** — existing clients ignore
  unknown trailing fields (SCVal vectors decode positionally; append-only is
  safe). Never insert in the middle.
- **New enum variants** appended to a returned enum, where existing clients
  treat unknown variants conservatively.
- **Loosening a constraint** that cannot invalidate existing behavior (e.g.
  accepting an additional valid input range that was previously rejected
  only when nothing depended on the rejection).
- **New authorization requirements on *new* entrypoints** (existing
  entrypoints must not gain new auth requirements).

Every additive release must still:

1. Add the entrypoints/fields to `src/compat_test.rs` (assert they work and
   that all pre-existing v1 assertions still hold).
2. Add a `### Added` section entry to
   `contracts/price-oracle/CHANGELOG.md`.
3. Go through the standard upgrade governance flow
   (`docs/CONTRACT_UPGRADE_GOVERNANCE.md`) when deployed on-chain.

### Breaking changes (require `API_VERSION` bump)

Bump `API_VERSION` (and mirror it on the proxy) when any of the following
happens:

- **Removing or renaming an entrypoint** (e.g. dropping
  `get_query_fee`, or renaming `submit_price`).
- **Changing argument types or arity** of an existing entrypoint.
- **Changing the meaning or order of fields in a returned struct.**
- **Tightening constraints** in a way that can break existing valid calls
  (e.g. newly rejecting previously accepted decimals values).
- **Adding authorization requirements to an existing entrypoint** so that
  previously-valid callers are now rejected.
- **Changing on-chain event topics** that consumers subscribe to, when the
  topics are part of the documented interface.

Breaking changes additionally require:

1. `API_VERSION` incremented in `src/contract.rs`, and `ProxyContract`'s
   `get_api_version` returning the new value.
2. The **old interface kept alive for a deprecation window** wherever
   practical: keep the removed/renamed entrypoint as a thin shim behind a
   `Deprecated` changelog entry, and delete it only in a later release (this
   is a *recommendation*; where gas/storage costs make a shim impractical,
   the deprecation must be announced in the changelog and via
   `docs/runbooks/mainnet-deployment.md` before the bump lands).
3. The compat suite updated with the *new* expectations **and** a comment
   recording the exact break (so the policy is auditable in CI).
4. A `### Removed` / `### Changed` entry in `contracts/price-oracle/CHANGELOG.md`
   describing the migration path for integrators.

## Compatibility test suite (regression gate)

`contracts/price-oracle/src/compat_test.rs` is the enforcement mechanism. It
asserts that:

- `get_api_version()` is stable and queryable on both the bare
  implementation and the proxy.
- After a state-preserving implementation swap at a fixed contract id (the
  on-chain effect of `ProxyContract::upgrade_wasm`), every v1 consumer read
  entrypoint — `get_price`, `get_price_history`, `get_assets`,
  `get_deviation_threshold`, `get_source_reputation` — returns **identical**
  data to what a v1 client observed before the swap.
- A same-id re-registration with an unchanged ABI disturbs nothing.

CI runs `cargo test` (including this module) on every PR that touches the
contract. Any release that changes an exported entrypoint **must** extend
`compat_test.rs`; a PR that breaks a v1 assertion cannot pass CI.

## Changelog discipline

`contracts/price-oracle/CHANGELOG.md` is the release log for the contract.
Every PR that ships a contract change adds an entry under `[Unreleased]`,
categorized `Added` / `Changed` / `Deprecated` / `Removed` / `Fixed`, and
links the issue. A maintainer folds `[Unreleased]` into a dated version
section at each tagged release.

## Operational notes

- **Proxy is the integration point.** Integrators should point at the
  proxy contract id, never a bare `PriceOracleContract` id (see
  ADR-0003). The proxy preserves storage across upgrades, so
  additive releases are invisible to consumers except for new
  capabilities.
- **Canary releases** (`docs/CANARY_DEPLOYMENTS.md`) let a new interface
  version be exercised on a canary contract with a configured traffic share
  before promotion — the recommended way to validate a breaking change
  against real callers.
- **Consumers** should record the `API_VERSION` they integrated against and
  re-check `get_api_version()` (or poll the changelog) before upgrading
  their dApp dependencies.

## Related documents

- `contracts/price-oracle/CHANGELOG.md` — release log
- `docs/adr/0003-contract-upgrade-strategy.md` — proxy upgrade strategy
- `docs/CONTRACT_UPGRADE_GOVERNANCE.md` — upgrade approval flow
- `docs/CANARY_DEPLOYMENTS.md` — canary rollout process
- `contracts/price-oracle/src/compat_test.rs` — enforcement tests
