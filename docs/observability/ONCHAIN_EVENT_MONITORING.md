# On-Chain Event Monitoring & Alerting (#417)

**Goal:** alert on contract events that indicate problems.

The Soroban oracle contract is the source of truth. Its events — price
submissions, governance changes, upgrades — are the ground truth for whether the
system is actually doing its job on-chain, regardless of what the off-chain
aggregator's own metrics say. A silent divergence between "the aggregator thinks
it published" and "the contract emitted an event" is exactly the failure class
this monitoring exists to catch.

## Event stream into the observability stack

An **on-chain event exporter** (`services/aggregator/src/contract-publishing/`
already holds a Soroban RPC client; the exporter reuses it) polls
`getEvents` for the oracle contract from the last processed ledger and converts
each event into metrics + structured logs:

| Contract event | Metric | Labels |
|----------------|--------|--------|
| `price_submitted` | `onchain_price_submissions_total` (counter) | `asset`\* |
| `price_submitted` | `onchain_last_submission_ledger` (gauge) | `asset`\* |
| `price_submitted` | `onchain_submission_price` (gauge, headline pairs only) | `asset`\* |
| `governance_changed` / `admin_changed` / `params_updated` | `onchain_governance_events_total` (counter) | `kind` |
| `upgraded` (WASM hash change) | `onchain_upgrade_events_total` (counter) | `from_hash`, `to_hash` (short) |
| any event | `onchain_events_processed_total` (counter) | `event_type` |
| exporter itself | `onchain_exporter_ledger_lag` (gauge) | — |
| exporter itself | `onchain_exporter_last_success_timestamp` (gauge) | — |

\* `asset` is guarded by the curated allow-list per
`docs/observability/METRICS_CARDINALITY.md` (#414); unknown pairs collapse to
`asset="other"`.

Raw event bodies (full args, ledger, tx hash, topics) go to structured logs and
the event index, **not** to metric labels.

## Alerts

See `k8s/base/onchain-events-prometheus-rules.yaml`:

- **`OnChainSubmissionGap`** — no `price_submitted` event for a headline asset in
  `> 2 ×` its expected cadence
  (`rate(onchain_price_submissions_total[15m]) == 0` for an asset that was
  active in the last 6h). `critical` — the contract is not receiving prices.
- **`OnChainSubmissionGapAllAssets`** — zero submissions across **all** assets
  for 10m → page immediately; the publishing path is fully down.
- **`OnChainGovernanceChange`** — any `onchain_governance_events_total` increase.
  `warning`, always routed to the security channel. Expected changes are
  acknowledged; unexpected ones are an incident (possible key compromise —
  cross-reference `docs/KEY_MANAGEMENT.md`).
- **`OnChainContractUpgraded`** — any `onchain_upgrade_events_total` increase not
  inside a declared change window → `critical`. Correlate `to_hash` with the
  release that was supposed to ship (`docs/CONTRACT_UPGRADE_GOVERNANCE.md`).
- **`OnChainExporterStalled`** — `time() - onchain_exporter_last_success_timestamp
  > 300` or `onchain_exporter_ledger_lag > 120`. The monitor itself is blind;
  treat all other on-chain alerts as unreliable until cleared.
- **`OnChainVsAggregatorDivergence`** — aggregator published
  (`price_publish_success_total` increasing) but `onchain_price_submissions_total`
  flat for the same asset over 15m, or vice versa. Indicates dropped txs, RPC
  issues, or a reorg.

## Correlating events with aggregator and DB state

Correlation is done on three shared keys so an operator can pivot across signals:

1. **`asset`** — common label across `onchain_*`, aggregator
   (`oracle_source_*`, `price_*`), and DB freshness metrics. Dashboard rows are
   grouped by asset so an on-chain gap lines up with the aggregator and DB
   panels for the same pair.
2. **Ledger / timestamp** — each exported event carries `ledger` and close time
   in its log line; the aggregator's publish attempt logs carry the same tx hash
   and target ledger, so a join on tx hash reconstructs the full
   attempt → submission → confirmation path.
3. **DB check** — the exporter also writes the last on-chain price + ledger per
   asset to a `onchain_state` table. A periodic reconciliation job compares
   `onchain_state` against the aggregator's `latest_prices` and the TimescaleDB
   history; a mismatch beyond tolerance raises `OnChainVsDbMismatch` and is
   surfaced on the SLO dashboard.

A single Grafana dashboard row per headline asset shows, side by side:
on-chain submission rate & staleness, aggregator publish success, source health,
and DB freshness — so the operator sees immediately which layer broke.
