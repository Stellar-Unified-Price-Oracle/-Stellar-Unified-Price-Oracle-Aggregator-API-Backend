# Prometheus Metrics Cardinality Budget & Enforcement (#553)

## 1. Executive Summary

This document establishes the official Prometheus metrics cardinality budget for the Stellar Unified Price Oracle & Aggregator API. It audits every metric and label, derives per-metric cardinality budgets with explicit headroom, defines enforcement mechanisms at startup and runtime, and reconciles these rules with Kubernetes Prometheus configurations (`k8s/base/prometheus-cardinality-rules.yaml`).

Without an enforced budget, operator-controlled configuration (`WATCHED_ASSETS`) and on-chain oracle registrations multiply series cardinality:
$$\text{Total Series} = \prod_{l \in \text{labels}} |\text{Domain}(l)| \times \text{Buckets}$$

This creates severe risk: high series cardinality consumes TSDB head memory and causes scrape timeouts, degrading the very monitoring system needed to observe incidents.

---

## 2. Metric and Label Audit

Every metric in `services/aggregator/src/observability/metrics.ts` and `api/src/observability/metrics.ts` was audited against actual use in Grafana dashboards (`monitoring/*.json`) and Prometheus alert rules (`monitoring/rules/*.yaml`, `k8s/base/prometheus-cardinality-rules.yaml`).

| Metric | Current Labels | Dashboards / Alerts Querying Labels | Audit Finding | Enforcement Strategy |
|---|---|---|---|---|
| `oracle_source_request_duration_seconds` | `source`, `asset`, `status` | Alerts use `sum by (source, le)`; incident dashboard queries quantile by source. Raw `asset` is NOT queried in live alerts due to pre-aggregation (#414). | High Risk: `source × asset × status × buckets` = $10 \times 50 \times 4 \times 10 = 20,000$ series if unbounded. | Bound `asset` via allowlist with fallback to `'other'`. Hard cap of 50 assets. Startup admission check enforces budget. |
| `oracle_source_requests_total` | `source`, `status` | Queried by source health and error rate dashboards. | Low Risk: $10 \times 4 = 40$ series. | Kept. Source validated against approved oracle source enum. |
| `oracle_source_sla_breaches_total` | `source` | Queried by `increase(oracle_source_sla_breaches_total[10m])` in aggregator on-call dashboard. | Low Risk: $10$ series. | Kept. Bounded to approved oracle source enum. |
| `oracle_api_calls_total` | `source` | Cost model and API call tracking. | Low Risk: $10$ series. | Kept. Bounded to approved oracle source enum. |
| `oracle_api_cost_estimated_usd_total` | `source` | Cost monitoring and capacity planning. | Low Risk: $10$ series. | Kept. Bounded to approved oracle source enum. |
| `oracle_api_budget_utilization_ratio` | `source` | On-call dashboard: `oracle_api_budget_utilization_ratio`. | Low Risk: $10$ series. | Kept. Bounded to approved oracle source enum. |
| `oracle_source_uptime_percent` | `source` | Incident commander & on-call dashboards. | Low Risk: $10$ series. | Kept. Bounded to approved oracle source enum. |
| `price_queries_total` | `asset` | API request distribution monitoring. | Medium Risk: User input could inject arbitrary pairs if unvalidated. | Curated allowlist guard. All unapproved pairs sanitized to `'other'`. Cap at 50 assets. |
| `last_price_timestamp_seconds` | `asset` | Staleness monitoring per asset. | Medium Risk: Same as above. | Same allowlist guard. Cap at 50 assets. |
| `circuit_breaker_triggered_total` | `source`, `asset` | Triggers tracked in logs; aggregated across sources. | High Risk if unbounded. | Kept with curated asset allowlist. Max $10 \times 50 = 500$ series. |
| `price_deviation_percent` | `source`, `asset` | Histogram with 7 buckets. | High Risk: $10 \times 50 \times 8 = 4,000$ series. | Kept with curated asset allowlist. |
| `onchain_price_staleness_seconds` | `asset` | Heartbeat staleness alerts. | Low/Medium Risk: $50$ series. | Guarded by watched assets list. |
| `contract_submission_gas` | `function`, `asset`, `status` | Gas tracking histogram (9 buckets). | Medium Risk: 3 functions × 50 assets × 3 statuses × 10 buckets = 4,500 series. | Bound asset to watched assets. |

---

## 3. Cardinality Budget & Headroom

### 3.1 Parameter Bounds

- **Max Approved Sources ($S_{\max}$):** 10 (Current active: 4 — Chainlink, Redstone, Band, Reflector; Headroom: 150%)
- **Max Curated Assets ($A_{\max}$):** 50 (Current active: 2–10; Headroom: 400%)
- **Max Statuses ($St_{\max}$):** 4 (`success`, `error`, `timeout`, `rate_limited`)
- **Max Contract Functions ($F_{\max}$):** 4 (`submit_price`, `submit_batch`, `set_canary`, `promote_canary`)
- **Prometheus Scrape Sample Limit:** 50,000 per target (`sample_limit` in Prometheus config)

### 3.2 Per-Metric Budget Allocation

| Metric | Label Dimensions | Series Formula | Worst-Case Series | Budget (with Headroom) |
|---|---|---|---|---|
| `oracle_source_request_duration_seconds` | `{source, asset, status, le}` | $S_{\max} \times A_{\max} \times St_{\max} \times 10$ | 20,000 | 2,500 (Pre-aggregated recording rule retains live detail) |
| `oracle_source_requests_total` | `{source, status}` | $S_{\max} \times St_{\max}$ | 40 | 100 |
| `oracle_source_sla_breaches_total` | `{source}` | $S_{\max}$ | 10 | 25 |
| `oracle_api_calls_total` | `{source}` | $S_{\max}$ | 10 | 25 |
| `oracle_api_cost_estimated_usd_total` | `{source}` | $S_{\max}$ | 10 | 25 |
| `oracle_api_budget_utilization_ratio` | `{source}` | $S_{\max}$ | 10 | 25 |
| `oracle_source_uptime_percent` | `{source}` | $S_{\max}$ | 10 | 25 |
| `price_queries_total` | `{asset}` | $A_{\max} + 1$ (`other`) | 51 | 100 |
| `last_price_timestamp_seconds` | `{asset}` | $A_{\max}$ | 50 | 100 |
| `circuit_breaker_triggered_total` | `{source, asset}` | $S_{\max} \times (A_{\max} + 1)$ | 510 | 750 |
| `price_deviation_percent` | `{source, asset, le}` | $S_{\max} \times A_{\max} \times 8$ | 4,000 | 1,000 |
| `onchain_price_staleness_seconds` | `{asset}` | $A_{\max}$ | 50 | 100 |
| `contract_submission_gas` | `{function, asset, status, le}` | $F_{\max} \times A_{\max} \times St_{\max} \times 10$ | 6,000 | 1,500 |
| **All Other System Metrics** | Default process/runtime | Fixed | ~350 | 500 |
| **Total Aggregator Series Target** | — | — | **~31,000** raw | **$\le 6,775$ series** |

The total application series budget of **6,775 series** utilizes only **13.5%** of the Prometheus `sample_limit: 50000`, providing **86.5% headroom** against TSDB head explosion.

---

## 4. Enforcement Architecture

Enforcement is applied at two critical lifecycle checkpoints:

```
[ Operator Config: WATCHED_ASSETS & SOURCES ]
                   │
                   ▼
       [ 1. Startup Admission Check ] ──> (Fails fast if sources > 10 or assets > 50)
                   │
                   ▼
       [ 2. Runtime Label Sanitizer ]
                   │
       ┌───────────┴───────────┐
       ▼                       ▼
 [ Allowed Asset ]      [ Unapproved Asset ]
       │                       │
       ▼                       ▼
  Normal Series         Remapped to "other"
                               │
                               ▼
                   cardinality_violations_total++
```

### 4.1 Startup Admission Check (`enforceStartupCardinalityBudget`)
- **Mechanism:** Validates configuration at process boot. If configured `WATCHED_ASSETS` exceeds 50, or authorized sources exceed 10, or total estimated series exceed the maximum safe threshold, the service crashes immediately with an actionable error.
- **Failure Mode:** Fail-fast at deployment time. Prevents bad configuration from silently starting and overwhelming Prometheus at scrape time.

### 4.2 Runtime Label Sanitizer (`sanitizeAssetLabel` & `sanitizeSourceLabel`)
- **Mechanism:** Compares every label value against the approved allowlist before emission. Unrecognized assets or sources are remapped to `'other'`.
- **Alertability:** Every sanitization increments `cardinality_violations_total{metric, label, rejected_value}`, alerting operators that an unapproved asset is generating traffic.
- **Failure Mode:** Soft clamp. Protects Prometheus series limits while logging the rejected entity in structured logs.

---

## 5. Reconciled Prometheus Alert Rules

Added to `k8s/base/prometheus-cardinality-rules.yaml`:
1. `MetricCardinalityBudgetApproaching`: Warns if active series for any metric exceed 80% of its budget.
2. `MetricCardinalityViolationDetected`: Alerts when `cardinality_violations_total > 0`, identifying unapproved asset/source emission.
