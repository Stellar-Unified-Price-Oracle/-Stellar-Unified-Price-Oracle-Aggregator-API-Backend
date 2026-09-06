# Metrics Cardinality Management & Cost Control (#414)

**Goal:** bound metrics cardinality to keep Prometheus healthy and affordable.

Unbounded label values (per-asset, per-API-key, per-user, per-URL) multiply time
series without limit. Each unique label-set is a separate series that Prometheus
keeps in memory and persists to disk, so a single careless label can turn one
metric into hundreds of thousands of series and blow up the TSDB head block.

## 1. Cardinality audit

Series count per metric is calculated from the running Prometheus with:

```promql
topk(20, count by (__name__)({__name__=~".+"}))
```

Findings from the current instrumentation
(`api/src/observability/metrics.ts`, `services/aggregator/src/observability/metrics.ts`):

| Metric | Label(s) | Risk | Action |
|--------|----------|------|--------|
| `price_queries_total` | `asset` | Medium — asset set is curated (< 200) but user-supplied pairs can leak in | Validate `asset` against the allow-list **before** incrementing; drop unknown pairs to `asset="other"` |
| `last_price_timestamp_seconds` | `asset` | Medium — same as above | Same allow-list guard |
| `circuit_breaker_triggered_total` | `source`, `asset` | High — `source × asset` product | Drop `asset`; keep `source` only. Per-asset breaker detail moves to logs/traces |
| `oracle_source_request_duration_seconds` | `source`, `asset`, `status` | High — histogram × 3 labels × buckets | Drop `asset` from the histogram; keep `source`, `status`. Per-asset latency is available pre-aggregated as a recording rule |
| `http_request_duration_seconds` | `method`, `route`, `status` | Low — `route` is the templated path, not the raw URL | Keep. Enforce that the router label is the **route template** (`/prices/:pair`), never `req.originalUrl` |
| `http_requests_total` | `method`, `route`, `status` | Low | Keep |
| `onchain_price_staleness_seconds` | `asset` | Medium | Allow-list guard |
| `ws_*` | `service`, `direction` | Low — both bounded | Keep |
| `oracle_api_*` | `source` | Low — `source` is a fixed enum | Keep |

**Forbidden labels** (never add these): `api_key`, `user_id`, `client_ip`,
`request_id`, `trace_id`, `session_id`, raw `url` / `path` / `query`, `error_message`,
`user_agent`, wallet / account address, tx hash, unbounded `pair` / `symbol`.
Those belong in structured logs and traces, which are indexed for search and are
not billed per-series.

### Pre-aggregation via recording rules

Where per-asset detail is genuinely useful for dashboards, it is produced as a
low-frequency recording rule instead of a live label, so the raw high-cardinality
series never has to exist:

```yaml
- record: oracle:source_request_duration_seconds:p99_5m
  expr: histogram_quantile(0.99, sum by (source, le) (rate(oracle_source_request_duration_seconds_bucket[5m])))
```

## 2. Cardinality limits & alerts

Enforced at three layers:

1. **Scrape-time cap** — `sample_limit` and `label_limit` on the scrape config so
   a misbehaving target is dropped rather than ingested:

   ```yaml
   scrape_configs:
     - job_name: stellar-oracle
       sample_limit: 50000          # per-target series ceiling
       label_limit: 12
       label_name_length_limit: 64
       label_value_length_limit: 256
   ```

2. **Global TSDB guardrails** — Prometheus flags:
   `--storage.tsdb.head-series-limit` (soft, alerts) and per-tenant limits when
   running under Mimir/Thanos (`max_global_series_per_user`,
   `max_label_names_per_series`).

3. **Alerting** — see `k8s/base/prometheus-cardinality-rules.yaml`:
   - `PrometheusHighSeriesChurn` — head series growing > 10%/h
   - `MetricCardinalityExplosion` — any single `__name__` over 100k series
   - `PrometheusScrapeSampleLimitHit` — a target hit `sample_limit`
   - `PrometheusTSDBHeadSeriesHigh` — head series > 80% of the configured limit
   - `PrometheusRemoteWriteCostBudget` — remote-write samples/s over the monthly
     cost budget (maps directly to the vendor bill)

## 3. Label conventions for future instrumentation

1. **Bounded by construction.** A label may only carry a value from a fixed,
   code-defined enum or a curated allow-list. If you cannot write down every
   possible value, it is not a label.
2. **Estimate before you ship.** New metric PRs must state
   `expected series = ∏(cardinality of each label)` in the description. Over
   ~10k series for one metric needs sign-off from the observability owner.
3. **Names:** `snake_case`, unit suffix (`_seconds`, `_bytes`, `_total`,
   `_ratio`), subsystem prefix (`oracle_`, `http_`, `ws_`, `onchain_`).
4. **Route labels** use the **route template**, never the raw path.
5. **No IDs, no free text, no user input** as label values — ever. Use exemplars
   to link a metric to a trace instead.
6. **Prefer `le`/bucket histograms over per-entity gauges** when you need a
   distribution across many entities.
7. **Deletion is cheap, migration is not.** When in doubt, ship without the label
   and add it later behind a recording rule.

New instrumentation is reviewed against this list in code review; the
`MetricCardinalityExplosion` alert is the backstop when something slips through.
