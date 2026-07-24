# Canary Deployments for Soroban Contract Upgrades

Canary deployment lets you test a new version of the Price Oracle contract with a controlled
slice of real traffic before making it the stable endpoint. If the canary behaves unexpectedly
(price deviation, TX failures), the aggregator rolls back automatically.

---

## Architecture

```
Aggregator poll cycle
        │
        ▼
  TrafficSplitter
   (e.g. 10% canary)
    ┌───┴───┐
    │       │
 stable   canary
contract  contract
(CONTRACT_ID)  (CANARY_CONTRACT_ID)
```

The `TrafficSplitter` uses a deterministic round-robin (not random) so the configured ratio
is met precisely over every 100-call window.  Both contracts receive the same aggregated price
value; the canary differs only in contract code, not input data.

The `CanaryMonitor` records every canary publish result and triggers automatic rollback when:
- A canary TX fails `CANARY_MAX_CONSECUTIVE_FAILURES` times in a row (default: 3), or
- The price stored in the canary diverges from stable by more than `CANARY_MAX_DEVIATION_BPS`
  basis points (default: 500 bps = 5%).

---

## Prerequisites

- `ADMIN_SECRET_KEY` set in `.env` (the same admin key that authorized sources on the stable contract).
- The new contract version built and ready (`make build-soroban`).
- The admin keypair must be registered as an authorized source on the canary contract after
  deployment (call `add_oracle_source` via the Stellar SDK or Stellar Lab).

---

## Step-by-step process

### 1. Deploy the canary contract

```bash
# Testnet (default)
make canary-deploy

# Mainnet
make canary-deploy-mainnet

# Custom initial traffic weight (default 10%)
make canary-deploy ARGS="--weight 5"
```

The script:
1. Compiles the Rust contract (`cargo build --release`).
2. Uploads the WASM to the network.
3. Creates a new contract instance.
4. Saves state to `.canary-state.json`.
5. Prints the exact `.env` snippet to activate the canary.

### 2. Register the admin as a source on the canary contract

The canary contract starts fresh — it has no authorized sources.  Add the admin:

```js
// using stellar-sdk
await contract.call('add_oracle_source', adminAddress, adminAddress, 'aggregator');
```

Or use [Stellar Lab](https://laboratory.stellar.org) to invoke `add_oracle_source`.

### 3. Activate canary traffic splitting

Add to `.env`:

```dotenv
CANARY_CONTRACT_ID=<id-from-step-1>
CANARY_ENABLED=true
CANARY_TRAFFIC_WEIGHT=10          # start at 10%
CANARY_MAX_DEVIATION_BPS=500      # auto-rollback at 5% deviation
CANARY_MAX_CONSECUTIVE_FAILURES=3
```

Restart the aggregator:

```bash
docker compose restart aggregator
# or
make dev-aggregator
```

### 4. Monitor

```bash
# Health endpoint (aggregator)
curl http://localhost:4002/health?verbose=true | jq .canaryMetrics

# Expected output
{
  "splitter": {
    "totalCalls": 120,
    "canaryCalls": 12,
    "weight": 10,
    "enabled": true
  },
  "monitor": {
    "totalSamples": 12,
    "failedSamples": 0,
    "maxDeviationBps": 0,
    "avgDeviationBps": 0,
    "consecutiveFailures": 0,
    "rolledBack": false
  }
}
```

Watch the aggregator logs for `[Canary]` prefixed lines:
- `[Canary] Initialized` — splitter is active.
- `[Canary] Submitted <asset> to canary contract` — successful publish.
- `[Canary] TX failed for <asset>` — TX failure recorded.
- `[Canary] Auto-rollback triggered` — rollback fired automatically.

### 5. Gradually increase traffic weight

Update `CANARY_TRAFFIC_WEIGHT` in increments and restart the aggregator each time:

| Stage | Weight | Notes                          |
|-------|--------|--------------------------------|
| 1     | 10%    | Initial smoke test             |
| 2     | 25%    | Monitor for 1–2 poll cycles    |
| 3     | 50%    | Validate at half traffic       |
| 4     | 100%   | Full canary before promotion   |

### 6. Promote canary to stable

Once you're confident the canary is healthy:

```bash
make canary-promote
```

This prints the exact `.env` changes needed:

```dotenv
CONTRACT_ID=<canary-contract-id>
CANARY_ENABLED=false
CANARY_CONTRACT_ID=              # clear this
```

Apply and restart the aggregator.

### 7. Rollback

Automatic rollback happens when the monitor threshold is breached (see above).  To roll
back manually at any time:

```bash
make canary-rollback
```

Then set `CANARY_ENABLED=false` and restart the aggregator.

---

## Rollback triggers

| Trigger                           | Condition                                    |
|-----------------------------------|----------------------------------------------|
| Consecutive TX failures           | `CANARY_MAX_CONSECUTIVE_FAILURES` (default 3)|
| Price deviation from stable       | `CANARY_MAX_DEVIATION_BPS` (default 500 bps) |
| Manual                            | `make canary-rollback`                       |

On any rollback the `TrafficSplitter` is disabled immediately — all subsequent publish
calls go to the stable contract only.  The aggregator does **not** restart; the change
takes effect on the next poll cycle.

---

## Configuration reference

| Env var                            | Default | Description                                                |
|------------------------------------|---------|------------------------------------------------------------|
| `CANARY_CONTRACT_ID`               | —       | Contract ID of the canary instance                         |
| `CANARY_ENABLED`                   | `false` | Master switch for traffic splitting                        |
| `CANARY_TRAFFIC_WEIGHT`            | `10`    | Percent of publish calls sent to the canary (0–100)        |
| `CANARY_MAX_DEVIATION_BPS`         | `500`   | Auto-rollback threshold in basis points (100 bps = 1%)     |
| `CANARY_MAX_CONSECUTIVE_FAILURES`  | `3`     | Consecutive canary TX failures before auto-rollback        |

---

## State file

`scripts/canary-deploy-soroban.js` writes `.canary-state.json` at the project root.  This
file is gitignored and tracks:

```json
{
  "canaryContractId": "C...",
  "stableContractId": "C...",
  "deployedAt": "2026-07-24T12:00:00.000Z",
  "network": "testnet",
  "trafficWeight": 10
}
```

It is updated on deploy, promote, and rollback operations.

---

## Security notes

- The canary contract shares the **same admin keypair** as the stable contract.  Ensure
  `ADMIN_SECRET_KEY` is stored securely (use `enc:` encrypted payloads — see
  `scripts/encrypt-secret.ts`).
- Never commit `.canary-state.json` or `.env` to version control.
- Canary traffic is always a **subset** of stable traffic; no user-facing data is affected
  since both contracts receive the same aggregated prices.
