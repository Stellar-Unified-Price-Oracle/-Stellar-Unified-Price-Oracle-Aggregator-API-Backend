# Soroban Storage Rent & TTL

Every Soroban ledger entry — instance storage (Admin, GovConfig, GovernanceProposal,
PendingProxyUpgrade, CanaryConfig, ...) and persistent storage (PriceHistory) — carries a
time-to-live measured in ledgers. Once it expires the entry is archived: reads and writes fail
until it's explicitly restored, which is far more disruptive (and no cheaper) than extending
ahead of time.

## What extends it

Issues #376 and #572 provide two permissionless entry points on `PriceOracleContract`
and `ProxyContract`:

- `extend_instance_ttl(caller: Address, threshold: u32, extend_to: u32) -> Result<(), OracleError>` —
  bumps the calling contract's own instance storage TTL. Covers everything that isn't `PriceHistory`
  (Admin, GovConfig, every `GovernanceProposal`, `MultiSigConfig`, `PendingProxyUpgrade`, `CanaryConfig`, etc.),
  since those all live in instance storage per `storage.rs`.
- `extend_price_history_ttl(caller: Address, asset: String, threshold: u32, extend_to: u32) -> Result<(), OracleError>` —
  bumps the per-asset `PriceHistory` persistent entry, which has its own independent TTL.

### Validation Bounds (Issue #572)

Both entrypoints enforce strict parameter validation:

1. **Ordering**: `extend_to >= threshold` is required. Attempting to set an extension target lower than the threshold is rejected with `InvalidTtlBounds` (error 41).
2. **Maximum extension cap**: `extend_to <= MAX_TTL_EXTEND_TO_LEDGERS` (3,110,400 ledgers, ~180 days). Exceeding this upper bound fails with `InvalidTtlBounds`.
3. **Minimum floor threshold**: `threshold >= MIN_TTL_THRESHOLD_LEDGERS` (17,280 ledgers, ~24 hours). Sub-day thresholds are rejected to prevent churn and ensure a healthy buffer.

### Caller Authorization Policy

- **Permissionless**: Any address can invoke these entry points; admin permissions are explicitly not required since extending TTL only pays rent and cannot mutate price or protocol logic.
- **Explicit authentication**: The caller must authenticate via `caller.require_auth()`. This guarantees that the address signing and paying the transaction fee is verified and accurately recorded in on-chain telemetry.

### Auditable Event Logging

Every successful extension publishes a `ttl_extended` event:
- **Topics**: `("ttl_extended", asset: String, caller: Address)` (where asset is the asset name, or `"instance"` for instance storage).
- **Data**: `(previous_ttl: u32, new_ttl: u32)`.

This makes every extension verifiable by indexers and reconcilable with the off-chain rent model.

### Sub-Floor and Missing Entry Failure

- If `extend_price_history_ttl` is called for an asset that has never been recorded in storage, it returns `AssetNotFound` (error 3).
- If an entry has reached 0 remaining ledgers (archived) or if calling `extend_ttl` results in a no-op where the TTL failed to extend, the function fails loudly with `TtlSubFloor` (error 42) instead of silently succeeding.

## The scheduled job

`scripts/extend-contract-ttl.mjs` calls both entry points for every contract instance and every
asset in `TRACKED_ASSETS`, passing the caller address via the `stellar` CLI. `k8s/ttl-extension-cronjob.yaml` runs it daily.
Defaults: extend once remaining TTL drops under `THRESHOLD_LEDGERS` (~34,560 ledgers, ~48h at
5s/ledger) out to `EXTEND_TO_LEDGERS` (~518,400 ledgers, ~30 days) — both overridable via env.

## Alerting on entries approaching the floor

The `stellar` CLI / RPC can read an entry's live TTL
(`getLedgerEntries` returns `liveUntilLedgerSeq`), so an alert would poll that and fire
if any tracked entry's remaining TTL drops under a second, tighter threshold than the
extension job's own — e.g. flag at 7 days remaining if the job runs daily and extends at 48h,
which gives multiple missed-run cycles of warning before archival.

## Who funds it

`STELLAR_ACCOUNT` in `k8s/ttl-extension-cronjob.yaml`'s `oracle-ttl-extension-secrets` needs a funded
Stellar account whose ongoing XLM balance covers the resource fees for these calls indefinitely:

1. A dedicated "ops" account funded from protocol treasury/fee revenue, topped up on a schedule.
2. The account needs its own low-balance alert so a starved TTL job doesn't fail silently.
