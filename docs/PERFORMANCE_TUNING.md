# Performance Tuning Guide

Practical guidance for sizing the knobs that most affect latency, throughput,
and cost across the API, aggregator, and Soroban submission path.

## Database connection pool sizing

Configured via `DATABASE_POOL_MIN` / `DATABASE_POOL_MAX` (see `.env.example`,
Issue #44).

- Start with `DATABASE_POOL_MIN=2`, `DATABASE_POOL_MAX=20` (the defaults) and
  watch pool-wait time in the connection-pool metrics.
- Size `DATABASE_POOL_MAX` to roughly `(peak concurrent requests) /
  (avg query time in seconds)`, capped by your Postgres/Timescale
  `max_connections` divided across all service instances.
- Keep `DATABASE_POOL_MIN` low in low-traffic environments — idle connections
  still cost memory on the database side.
- Prefer raising instance count over pushing a single instance's pool very
  high; a very large pool on one instance can starve the database of
  connections for other services.

## Cache TTL optimization

Per-endpoint TTLs are independently tunable in `.env.example`:

| Variable | Default | Trade-off |
|---|---|---|
| `PRICE_CACHE_TTL_MS` | 15000 | Lower = fresher prices, more upstream load. |
| `HISTORY_CACHE_TTL_MS` | 60000 | Historical data changes rarely; safe to raise. |
| `SOURCES_CACHE_TTL_MS` | 300000 | Source list is near-static; raise further if sources rarely change. |
| `HEALTH_CACHE_TTL_MS` | 30000 | Lower values give faster health-status detection at the cost of more checks. |

Tune `PRICE_CACHE_TTL_MS` first since it's on the hottest read path — it
should stay below your consumers' staleness tolerance but above the
aggregator's actual price-update cadence (`POLLING_INTERVAL_MS`) to avoid
cache churn with no new data behind it.

## Polling interval tuning

`POLLING_INTERVAL_MS` (default `30000`) controls how often the aggregator
pulls fresh prices from oracle sources.

- Lowering it improves price freshness but increases outbound request volume
  to every configured source (watch source-side rate limits).
- Raising it reduces load and cost but increases staleness; make sure it
  stays below `PRICE_CACHE_TTL_MS` so cached responses reflect the latest
  poll.
- If sources have heterogeneous rate limits, prefer per-source backoff over
  lowering the global interval.

## Batch submission sizing

`ARCHIVAL_BATCH_SIZE` (default `5000`) and `ARCHIVAL_INTERVAL_MS` (default
`86400000`, 24h) control archival batch throughput.

- Larger batches amortize per-batch overhead but hold longer transactions and
  larger memory buffers; reduce `ARCHIVAL_BATCH_SIZE` if you see archival-job
  memory pressure or long-running transaction warnings.
- If the archival window is too short to process the full backlog at the
  default batch size, either raise `ARCHIVAL_BATCH_SIZE` or shorten
  `ARCHIVAL_INTERVAL_MS` so batches run more frequently.

## Poll loop overrun policy & cycle deadlines (Issue #575)

Aggregator price polling runs in a self-scheduling loop protected by a single-flight mutex:

- **At most one cycle in flight**: If a poll cycle takes longer than `POLLING_INTERVAL_MS`, overlapping ticks are immediately skipped. Duplicate on-chain submissions and interleaved file writes are impossible by construction.
- **Overrun semantics**:
  - If a cycle finishes within `POLLING_INTERVAL_MS`, the next cycle is scheduled for `POLLING_INTERVAL_MS - elapsedMs`.
  - If a cycle exceeds `POLLING_INTERVAL_MS` (overrun), the missed tick is skipped, and the next cycle is scheduled after a **1000ms recovery delay** to prevent CPU/network starvation.
  - An overrun event increments `poll_cycle_overruns_total`.
  - If 3 consecutive cycles overrun, a sustained overrun alert is logged and routed to AlertManager.
- **Bounded deadline**: Each poll cycle is wrapped in a hard timeout (`max(10s, POLLING_INTERVAL_MS * 1.5)`). If upstream oracle sources or RPC stalls exceed the deadline, the cycle is aborted and resources cleaned up.
- **Observability**:
  - `poll_cycle_duration_ms`: histogram of end-to-end poll cycle durations.
  - `poll_cycle_overruns_total`: counter of skipped/overrunning cycles.

## Soroban fee policy & resource fee limits (Issue #578)

Transactions submitted to Soroban use an explicit, bounded fee policy rather than a hardcoded 100 stroop fee:

- **Base inclusion fee & surge multiplier**:
  - Configured via `CONTRACT_BASE_INCLUSION_FEE` (default `100` stroops) and `CONTRACT_FEE_SURGE_MULTIPLIER` (default `1.2`x, clamped between `1.0`x and `3.0`x).
  - Capped by `CONTRACT_MAX_INCLUSION_FEE` (default `50,000` stroops).
- **Simulation minResourceFee guard**:
  - On transaction simulation, the RPC returns `minResourceFee`.
  - If simulation `minResourceFee` exceeds `CONTRACT_MAX_RESOURCE_FEE` (default `1,000,000` stroops), the transaction is rejected immediately to protect against runaway fees or network spikes.
- **Dynamic fee assembly**:
  - The actual fee offered to the network includes both the surge-adjusted inclusion fee and the validated resource fee.

## Account sequence caching & RPC call reduction (Issue #578)

- **Local sequence allocation**:
  The singleton `ContractPublisher` caches the Stellar `Account` instance. When building transactions across multiple assets in a round, the SDK locally increments `account.sequenceNumber()`, requiring only **1 `getAccount` call per round** (or 0 when sequence is valid across rounds).
- **Bad-sequence recovery (`tx_bad_seq`)**:
  If the network reports `tx_bad_seq` (e.g. out-of-band transaction submitted from the same key), the publisher invalidates its cached account, re-fetches sequence from RPC, and retries the submission once.
- **Heartbeat read optimization**:
  Read-only simulation (`getOnChainTimestamp`, canary refresh) uses a lightweight virtual account instance and never performs an RPC `getAccount` call. This reduces RPC call volume during staleness heartbeat checks by >90%.
- **Metrics**:
  - `contract_rpc_calls_total{call_type}`: counter of RPC invocations (`get_account`, `simulate`, `send`, `get_transaction`).
  - `contract_rpc_calls_per_round{call_type}`: gauge recording RPC invocations during the latest round.
