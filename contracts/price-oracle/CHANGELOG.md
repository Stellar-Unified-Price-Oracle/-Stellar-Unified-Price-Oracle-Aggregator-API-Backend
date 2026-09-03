# Price Oracle Contract — Changelog

All notable changes to the `contracts/price-oracle` Soroban contracts
(`PriceOracleContract`, `ProxyContract`, `GovernanceContract`,
`MultiSigAdminContract`) are documented here, per issue #383.

The format follows [Keep a Changelog](https://keepachangelog.com/) and this
project adheres to the interface versioning policy in
[docs/CONTRACT_VERSIONING.md](../../docs/CONTRACT_VERSIONING.md):

- **Added** — new entrypoints, fields, or capabilities (non-breaking).
- **Changed** — behavioral changes that keep the exported ABI compatible.
- **Deprecated** — entrypoints scheduled for removal (still working).
- **Removed** — breaking removals; bumps `API_VERSION`.
- **Fixed** — bug fixes.

Breaking changes that alter the exported interface bump `API_VERSION` in
`src/contract.rs` (and are mirrored by `ProxyContract::get_api_version`).

## [Unreleased]

### Added

- `API_VERSION` constant and `get_api_version()` entrypoint on both
  `PriceOracleContract` and `ProxyContract` — consumers can query the
  exported ABI version before integrating or before an upgrade (#383).
- ABI/interface compatibility test suite (`src/compat_test.rs`) asserting
  that all v1 consumer read entrypoints (`get_price`, `get_price_history`,
  `get_assets`, `get_deviation_threshold`, `get_source_reputation`) return
  identical data after a state-preserving implementation swap (#383).
- Versioning policy document (`docs/CONTRACT_VERSIONING.md`) defining
  additive vs. breaking change rules (#383).

## [1.0.0] — 2026-08-27

### Added

- Core oracle surface: `initialize`, `submit_price`, `submit_batch`,
  `get_price`, `get_price_history`, `get_assets`, `set_trusted_asset`,
  `is_paused`, query-fee and whitelist admin controls.
- Proxy-based upgradeability (`ProxyContract`) with WASM-hash swaps,
  logical implementation-pointer upgrades, storage-layout versioning, and
  the multi-sig upgrade proposal flow (ADRs #68, ADR-0003).
- Canary rollout registration on the proxy: `set_canary` /
  `get_canary` / `promote_canary` (#375).
- Multi-sig administration and token governance entrypoints
  (`init_multisig`, `create_proposal`, `approve_proposal`,
  `execute_proposal`).
- Staking / slashing and reputation tracking with deviation guards.
- On-chain state-migration upgrade test (#381).

[Unreleased]: https://github.com/Stellar-Unified-Price-Oracle/-Stellar-Unified-Price-Oracle-Aggregator-API-Backend/compare/1.0.0...HEAD
[1.0.0]: https://github.com/Stellar-Unified-Price-Oracle/-Stellar-Unified-Price-Oracle-Aggregator-API-Backend/releases/tag/v1.0.0
