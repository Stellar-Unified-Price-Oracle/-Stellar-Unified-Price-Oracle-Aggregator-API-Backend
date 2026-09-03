# Canary Deployments for Contract Upgrades

> Issue #105 — deploy Price Oracle contract upgrades safely by routing a
> fraction of live publish traffic to a **canary** implementation before it
> becomes canonical.

Soroban contracts are upgraded by re-binding the proxy to a new
implementation (WASM).  A bad upgrade is expensive to unwind: it can corrupt
price submissions, break consumers, or require an emergency re-deploy.  A
**canary deployment** makes upgrades reversible *before* they go live:

1. Deploy the new implementation as a **canary** contract, registered on the
   proxy with a small traffic share (e.g. 5%).
2. The aggregator routes that share of live publish submissions to the
   canary — everything else continues hitting the canonical implementation.
3. Operators watch canary health (`canary_*` metrics, on-chain staleness) for
   an observation window.
4. On success → **promote** the canary (it becomes the implementation, the
   old one is kept as `previous_implementation`).
5. On failure → **rollback** (traffic share zeroed; the canonical
   implementation was never touched).

## Architecture

```
                    ┌────────────────────────────────────────────┐
                    │              ProxyContract                 │
                    │  implementation  ─── canonical impl (C1)   │
                    │  canary           ─── canary impl (C2)     │
                    │  canary_traffic_share_bps ── e.g. 500 (5%) │
                    └────────────────────────────────────────────┘
                                  ▲  get_canary / set_canary /
                                  │  promote_canary
        ┌─────────────────────────┴─────────────────────────┐
        │               Aggregator (ContractPublisher)      │
        │  publishAggregated():                             │
        │    refreshCanary() → read share from proxy        │
        │    per submission: share% → C2, rest → C1         │
        │    failures → CanaryRollbackGuard (threshold)     │
        │    threshold hit → set_canary(share=0) auto-rollback
        └───────────────────────────────────────────────────┘
```

The on-chain half (registration, promotion, share storage) lives in
`contracts/price-oracle/src/proxy.rs` (`set_canary`, `get_canary`,
`promote_canary`, `CanaryImplementation`, `CanaryTrafficShareBps`).  The
off-chain half (traffic splitting, failure detection, auto-rollback) lives in
`services/aggregator/src/contract-publishing/canary.ts` and
`publisher.ts`.

## Traffic splitting semantics

- The share is expressed in **basis points** (0–10 000).  `500` bps = 5%,
  `10 000` bps = 100% (full canary), `0` = disabled.
- Splitting is **per-submission and deterministic**: the publisher keeps a
  monotonically increasing sequence counter, and submission *n* goes to the
  canary when `(n % 10_000) < share_bps`.  Over any 10 000-submission window
  the canary receives *exactly* `share_bps` submissions, evenly interleaved
  across all assets — no asset is permanently pinned to the canary.
- Retries (`SubmissionRetryQueue`) always target the canonical contract, so
  a broken canary can never wedge the retry loop.
- The share is re-read from the proxy (`get_canary`) at the start of every
  publish round, so an operator's `promote`/`rollback` is picked up within
  one polling interval without restarting the aggregator.

## Failure detection & auto-rollback

The aggregator records the outcome of every submission routed to the canary:

| Knob | Env var | Default | Meaning |
|------|---------|---------|---------|
| Rollback threshold | `CANARY_FAILURE_THRESHOLD` | `3` | Consecutive canary submission failures before a rollback triggers |
| Auto-rollback | `CANARY_AUTO_ROLLBACK` | `true` (any value other than `"false"`) | When true, the publisher zeroes the canary share on-chain after the threshold is hit |

Only **consecutive** failures count — a single success resets the streak, so
a transient RPC hiccup cannot trip a rollback by itself.  When the threshold
is hit the publisher:

1. Logs a critical `[Canary]` error and increments `canary_rollbacks_total`.
2. If `CANARY_AUTO_ROLLBACK != "false"`, sends `set_canary(admin, canary, 0)`
   to the proxy, pausing canary traffic immediately.
3. If auto-rollback is disabled, it only logs/metrics; an operator must run
   `node scripts/deploy-canary.js rollback`.

### Prometheus metrics

| Metric | Type | Meaning |
|--------|------|---------|
| `canary_active` | Gauge | 1 while a canary has a non-zero share |
| `canary_traffic_share_bps` | Gauge | Current share (0–10 000) |
| `canary_submissions_total{status}` | Counter | Submissions routed to the canary (`success`/`failed`) |
| `canary_consecutive_failures` | Gauge | Current failure streak |
| `canary_rollbacks_total` | Counter | Auto-rollbacks performed |

## Runbook

### Prerequisites

- Rust toolchain (to build the contract wasm).
- `@stellar/stellar-sdk` resolvable (run the script from
  `services/aggregator` or install the workspace deps, as with the existing
  `scripts/deploy-soroban.js`).
- `.env` with:
  - `CONTRACT_ID` — the **proxy** contract id (what consumers point at).
  - `ADMIN_SECRET_KEY` — admin keypair that can call `set_canary` /
    `promote_canary` (admin of the proxy).
  - `SOROBAN_RPC_URL`, `NETWORK_PASSPHRASE` (defaults target testnet).

### 1. Deploy the canary

```bash
node scripts/deploy-canary.js deploy 500        # 5% of traffic
node scripts/deploy-canary.js deploy 1000       # 10% of traffic
node scripts/deploy-canary.js deploy 500 --dry-run
```

This builds `contracts/price-oracle`, uploads the wasm, creates a fresh
canary contract instance, and registers it via `set_canary` on the proxy.
It prints the canary contract id, the wasm hash, and the salt used — record
them for the promote/rollback decision and for auditability.

Verify:

```bash
node scripts/deploy-canary.js status
# Canary contract id: C...
# Traffic share: 500 bps (5.0%)
```

The aggregator picks the share up on its next publish round.  Confirm in
Prometheus that `canary_active` is `1` and `canary_submissions_total` is
increasing at the expected rate.

### 2. Observe

- **Submission health**: `canary_consecutive_failures` stays at 0 and
  `canary_submissions_total{status="success"}` grows; no
  `[Canary]` error logs.
- **Price freshness**: `onchain_price_staleness_seconds` should not rise for
  the canary's share — the canary is receiving the same `submit_price`
  calls as the canonical contract.
- **Gas**: compare canary submission fees against canonical; a regression
  here (e.g. `CONTRACT_GAS_ALERT_THRESHOLD` trips) is a common reason to
  abort.
- Recommended observation window: **at least one full publish cycle per
  asset at your target share** (e.g. 15–30 minutes at 5% on a 30 s cycle),
  plus a stress/chaos run if your release warrants it.

### 3. Promote

```bash
node scripts/deploy-canary.js promote
```

`promote_canary` makes the canary the canonical implementation, bumps the
contract version, records the old implementation as
`previous_implementation`, and clears the canary registration.  Consumers
see no interface change (see `docs/CONTRACT_VERSIONING.md` — the ABI is
unchanged; `get_api_version` still returns `1`).

Verify: `canary_active` → 0, `canary_traffic_share_bps` → 0, and price
submissions continue with no errors.

### 4. Rollback (abort)

At any point before promotion:

```bash
node scripts/deploy-canary.js rollback
```

This re-registers the canary with **0 bps** share, so the aggregator routes
100% of traffic to the canonical implementation.  The canary contract
instance still exists on-chain but receives no traffic.  (Auto-rollback does
the same thing automatically when the failure threshold is hit.)

> If the canary was *already promoted* and must be un-done, roll back by
> re-deploying the previous implementation as the canary and promoting it, or
> by running the standard upgrade flow with the previous wasm
> (`scripts/deploy-soroban.js` / `upgrade_wasm`).  `previous_implementation`
> records where to go back to.

## When to use a canary

Use a canary for anything that changes pricing behavior, storage layout,
auth, or event shape — e.g. a new aggregation algorithm, a deviation-threshold
tweak, or a storage migration.  For pure documentation / metadata changes with
no behavioral risk, the standard upgrade path is sufficient.

## Safety notes

- `set_canary` validates the share (`0..10_000`) and requires proxy admin
  auth.  Shares above 10 000 bps are rejected (`InvalidThreshold`).
- The aggregator holds the admin secret (`ADMIN_SECRET_KEY`); auto-rollback
  writes are signed with it.  If you run with `CANARY_AUTO_ROLLBACK=false`,
  a broken canary pauses traffic *to itself* only when an operator acts —
  keep the rollback runbook within reach of on-call.
- Canary deployments do **not** change the canonical implementation until
  `promote_canary` succeeds, so a failed canary can never corrupt the
  production price feed.
