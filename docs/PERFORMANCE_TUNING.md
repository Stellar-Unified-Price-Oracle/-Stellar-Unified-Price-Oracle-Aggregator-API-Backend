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

## Soroban fee optimization

- Use the network's current base fee plus a small surge multiplier rather
  than a fixed high fee; static over-bidding wastes XLM at low network load
  and under-bids during congestion.
- Batch independent contract calls into a single transaction where the
  contract interface allows it, to amortize the base transaction fee across
  more state changes.
- Monitor submission failures due to `tx_fee_bump` / insufficient fee and
  adjust the surge multiplier reactively rather than statically over-fixing
  it.
- Keep a dedicated fee-source key balance topped up separately from
  admin/signer keys so fee spend is easy to attribute and rate-limit.
