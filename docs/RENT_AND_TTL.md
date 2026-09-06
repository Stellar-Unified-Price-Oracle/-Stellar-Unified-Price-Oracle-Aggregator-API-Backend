# Soroban Storage Rent & TTL

Every Soroban ledger entry — instance storage (Admin, GovConfig, GovernanceProposal,
PendingProxyUpgrade, CanaryConfig, ...) and persistent storage (PriceHistory) — carries a
time-to-live measured in ledgers. Once it expires the entry is archived: reads and writes fail
until it's explicitly restored, which is far more disruptive (and no cheaper) than extending
ahead of time.

## What extends it

Issue #376 added two permissionless entry points, present on `PriceOracleContract`,
`GovernanceContract`, and `ProxyContract`:

- `extend_instance_ttl(threshold: u32, extend_to: u32)` — bumps the calling contract's own
  instance storage TTL. Covers everything that isn't `PriceHistory` (Admin, GovConfig, every
  `GovernanceProposal`, `MultiSigConfig`, `PendingProxyUpgrade`, `CanaryConfig`, etc.), since
  those all live in instance storage per `storage.rs`.
- `extend_price_history_ttl(asset: String, threshold: u32, extend_to: u32)` — bumps the
  per-asset `PriceHistory` persistent entry, which has its own independent TTL.

Both are no-auth: extending TTL can't hurt anything, and gating it behind admin auth would only
make the scheduled job more brittle (one more key to rotate, one more thing that can desync).
The caller pays the resource fee for the extension, same as any other transaction.

## The scheduled job

`scripts/extend-contract-ttl.mjs` calls both entry points for every contract instance and every
asset in `TRACKED_ASSETS`, via the `stellar` CLI. `k8s/ttl-extension-cronjob.yaml` runs it daily.
Defaults: extend once remaining TTL drops under `THRESHOLD_LEDGERS` (~34,560 ledgers, ~48h at
5s/ledger) out to `EXTEND_TO_LEDGERS` (~518,400 ledgers, ~30 days) — both overridable via env.

## Alerting on entries approaching the floor

Not implemented here. The `stellar` CLI / RPC can read an entry's live TTL
(`getLedgerEntries` returns `liveUntilLedgerSeq`), so an alert would poll that and fire
if any tracked entry's remaining TTL drops under a second, tighter threshold than the
extension job's own — e.g. flag at 7 days remaining if the job runs daily and extends at 48h,
which gives multiple missed-run cycles of warning before archival. Wiring that into
`monitoring/grafana-dashboard.json` (a panel plus an alerting rule) is follow-up work, not
included in this change — it needs a metrics exporter that doesn't exist yet, distinct from the
extension job above.

## Who funds it

Not decided as part of this change. `STELLAR_ACCOUNT` in
`k8s/ttl-extension-cronjob.yaml`'s `oracle-ttl-extension-secrets` needs a funded Stellar account
whose ongoing XLM balance covers the resource fees for these calls indefinitely. Options (needs a
decision from whoever owns the mainnet deployment budget):

1. A dedicated "ops" account funded from protocol treasury/fee revenue (see
   `docs/COST_OPTIMIZATION.md` for existing fee-revenue accounting), topped up on a schedule.
2. The same admin/deployer key already used for contract administration, if its custody model
   tolerates an automated job holding it (generally not recommended — prefer a scoped key that
   can only pay fees, not one with `admin.require_auth()` authority over the contracts).

Either way, the account needs its own low-balance alert so a starved TTL job doesn't fail silently.
