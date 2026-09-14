# Runbook: Prometheus Cardinality Explosion

**Linked alerts:** `MetricCardinalityExplosion`, `PrometheusHighSeriesChurn`, `PrometheusTSDBHeadSeriesHigh`, `PrometheusScrapeSampleLimitHit`, `PrometheusRemoteWriteCostBudget`
**Severity:** P1 / P0 (see per-alert severity)

## Symptoms

- A single metric exceeds ~100k active series, or head series grow >10%/hour
- Head series approach the configured limit; a target exceeds its `sample_limit`
- Remote-write sample rate exceeds the cost budget

## Diagnosis

1. Identify the offending metric and its highest-cardinality label:

```promql
topk(10, count by (__name__) ({__name__=~".+"}))
topk(10, count by (source, asset) (oracle_source_request_duration_seconds_bucket))
```

2. Cross-check the label against `docs/observability/METRICS_CARDINALITY.md` and the
   pre-aggregation recording rules (`oracle:source_request_duration_seconds:p99_5m`).
3. Determine whether the growth aligns with a recent deploy or a new scrape target.

## Mitigation

1. Drop or pre-aggregate the unbounded label (per-asset, per-key, per-URL) at the exporter.
2. If a target tripped `sample_limit`, reduce its series count before it is dropped again.
3. If head series are within 20% of the limit, scale Prometheus or lower retention until cardinality is reduced.
4. Raise the remote-write budget only as a deliberate, reviewed capacity decision.

## Recovery Verification

- `prometheus:tsdb_head_series:ratio` below 0.80 and stable
- No further `prometheus_target_scrapes_exceeded_sample_limit_total` increments
- Remote-write sample rate back under budget

## Related runbooks

- [cost-optimization.md](cost-optimization.md)
- [rollback-decision-tree.md](rollback-decision-tree.md)
