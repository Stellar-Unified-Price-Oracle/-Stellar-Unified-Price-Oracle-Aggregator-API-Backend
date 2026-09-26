# End-to-End Latency Budget & Per-Hop Attribution (#554)

## 1. Overview and Derivation

The API Service Level Agreement (`docs/service-sla.md`) and Service Level Objectives (`monitoring/slo.yml`) commit to:
- **API Latency Commitment:** $99.0\%$ of requests served in $< 1000\text{ ms}$ (p95 target).
- **Internal Target:** Typical requests served in $\le 250\text{ ms}$ p95 across endpoints.

An aggregate percentile metric alone fails to pinpoint why a regression occurred. Without per-hop latency budgeting, an individual subsystem (such as an unindexed database query or cache miss cascade) can consume the entire latency headroom while total request time still superficially passes under light loads.

This document decomposes the end-to-end latency envelope into attributable, measurable hops across both the API serving path and the Aggregator ingestion pipeline.

---

## 2. Per-Hop Latency Budget

### 2.1 API Request-Response Serving Path (Target: p95 $\le 250\text{ ms}$, SLA Bound: p95 $\le 1000\text{ ms}$)

| Hop ID | Subsystem / Operation | Span Name | p50 Target | p95 Budget | CI Hard Cap (+25% tol) | Headroom / Rationale |
|---|---|---|---|---|---|---|
| `hop_ingress_tls` | Ingress / Gateway / TLS termination | `http.ingress` | 2 ms | 10 ms | 12.5 ms | Edge routing and HTTP parsing |
| `hop_middleware_auth` | Auth / RBAC / Rate limiting / Validation | `http.middleware` | 3 ms | 15 ms | 18.75 ms | Token verification and Zod schema parsing |
| `hop_cache_lookup` | Hybrid Cache (L1 Memory + L2 Redis) | `cache.get` | 4 ms | 25 ms | 31.25 ms | Sub-millisecond for L1 hits; network RTT for Redis |
| `hop_data_store` | Persistence Read (File store / TimescaleDB) | `store.read` | 15 ms | 80 ms | 100.0 ms | Disk I/O or hypertable indexed index scan |
| `hop_serialization` | Aggregation / Envelope formatting / Compression | `http.format` | 2 ms | 20 ms | 25.0 ms | JSON stringify and gzip/brotli streaming |
| `hop_egress_network` | Network buffer flush & egress transit | `http.egress` | 5 ms | 30 ms | 37.5 ms | Client socket transmission |
| **Total API End-to-End** | Full HTTP Request Lifecycle | `http.request` | **31 ms** | **180 ms** | **225.0 ms** | **Over 750 ms headroom below 1000 ms SLA ceiling** |

### 2.2 Aggregator Ingestion & Distribution Path

| Hop ID | Subsystem / Operation | Span Name | p50 Target | p95 Budget | CI Hard Cap (+25% tol) | Headroom / Rationale |
|---|---|---|---|---|---|---|
| `hop_source_fetch` | Upstream Oracle HTTP Polling | `oracle.fetch` | 120 ms | 500 ms | 625.0 ms | External API transit (Chainlink, Band, etc.) |
| `hop_median_compute` | Median calculation & anomaly filtering | `oracle.median` | 2 ms | 15 ms | 18.75 ms | In-memory sort and Z-score outlier detection |
| `hop_ws_broadcast` | Internal WS broadcast transmission | `ws.broadcast` | 3 ms | 25 ms | 31.25 ms | Serialization and socket multicast to subscribers |
| `hop_contract_publish` | Soroban RPC contract submission | `contract.submit` | 800 ms | 3500 ms | 4375.0 ms | Stellar consensus and transaction confirmation |

---

## 3. Distributed Tracing Coverage & Missing Hop Detection

To ensure no hop is silently unmeasured:
1. **W3C Trace Context Propagation:**
   Traceparent headers (`traceparent`, `tracestate`) are injected across process boundaries:
   - Aggregator WebSocket broadcasts inject `traceparent` directly into the JSON message envelope.
   - Subscribers extract context so downstream processing joins the active distributed trace.
2. **Missing Span Detection:**
   `validateTraceCoverage(spans)` inspects the completed trace span tree. If a required hop is missing from the span sequence, it triggers `TraceIncompletenessError`, preventing silent observability regressions.

---

## 4. Controlled Measurement in CI

Measuring p95 wall-clock latency on shared CI runners suffers from multi-tenant CPU contention, causing false-positive flaps.
To eliminate runner noise, per-hop CI enforcement (`scripts/enforce-latency-budget.ts`):
- Runs under isolated synthetic benchmark fixtures with pre-warmed engines.
- Samples multiple iterations, trims top and bottom 10% outliers, and decomposes latency by proportional span duration.
- Evaluates each hop against its specific allocation. If any hop breaches its threshold, CI fails explicitly naming the offending hop and breach magnitude:
  ```
  FAIL: Hop 'hop_cache_lookup' exceeded budget: 38.2ms > 25.0ms (+52.8% above budget)
  ```

---

## 5. Reconciliation with Existing k6 Baselines

`scripts/benchmark-baseline.json` records endpoint-level aggregates:
- `GET /api/v1/health`: p95 $12\text{ ms}$
- `GET /api/v1/prices`: p95 $65\text{ ms}$
- `GET /api/v2/prices`: p95 $80\text{ ms}$
- `GET /api/v1/prices/XLM`: p95 $40\text{ ms}$

The hop budget decomposes these baselines:
For `/api/v1/prices` (baseline $65\text{ ms}$):
$$\text{Ingress (5ms)} + \text{Middleware (8ms)} + \text{Cache/Store (35ms)} + \text{Format (7ms)} + \text{Egress (10ms)} = 65\text{ ms}$$
The hop budget thus unifies microsecond hop telemetry with macro k6 synthetic benchmarks into a single coherent performance model.

---

## 6. Budget Revision Process

When architectural changes occur (e.g. migrating persistence from disk files to TimescaleDB hypertables, or introducing multi-region replication):
1. Measure baseline span percentiles over 100,000 real production requests.
2. Submit a PR updating `LATENCY_BUDGET.md`, `monitoring/slo.yml`, and `scripts/enforce-latency-budget.ts`.
3. Provide comparative span flamegraphs demonstrating that total end-to-end budget remains strictly under the $1000\text{ ms}$ SLA promise.
