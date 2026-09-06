# Monitoring & Alerting Configuration Guide

This guide documents how to instrument, observe, and alert on the Stellar Unified
Price Oracle & Aggregator stack. It covers the observability architecture, the
Prometheus / Grafana / Alertmanager configuration, the recommended alert
thresholds, the SLI/SLO definitions and error-budget policy, and how to validate
that the whole pipeline is working.

Upstream issue: **#306**.

---

## 1. Architecture overview

The stack emits Prometheus metrics from two services and is observed via the
standard Prometheus + Grafana + Alertmanager toolchain:

```
┌─────────────────────┐      scrape      ┌──────────────────────┐
│ price-oracle-api    │ ───────────────▶ │                      │
│  /metrics           │                  │     Prometheus       │
└─────────────────────┘                  │                      ├──┐ alerts/recording
┌─────────────────────┐      scrape      │  rules → Alertmanager│  │   PrometheusRules
│ price-oracle-aggr.  │ ───────────────▶ │                      │◀─┘  (k8s/base)
│  /metrics           │                  └──────────┬───────────┘
└─────────────────────┘                             │
                                                    ▼
                             ┌───────────┐   ┌──────────────┐
                             │  Grafana  │   │ Alertmanager │ → email/Slack/PagerDuty
                             └───────────┘   └──────────────┘
```

- **API service** (`api/`) exposes `/metrics` at the HTTP layer. It reports
  request volume/latency, cache hit rate, price-query load, staleness, rate
  limiter decisions, WebSocket lifecycle, and DB pool health. Metrics are
  registered in `api/src/observability/metrics.ts`.
- **Aggregator service** (`services/aggregator/`) exposes `/metrics` and reports
  per-source request latency/volume, SLA breaches, per-source uptime, on-chain
  price staleness and API cost/budget utilization. Metrics are registered in the
  aggregator's `metrics.ts`.
- **Alert rules** are declared as Kubernetes `PrometheusRule` objects in
  `k8s/base/prometheus-rule.yaml` (see [§5](#5-alert-rules-and-thresholds)).
- **Dashboards** are stored in `monitoring/grafana-dashboard.json` (see [§6](#6-grafana-dashboards)).
- **Alert routing** is configured in
  `k8s/chaos/reporting/alertmanager-config.yaml`.

---

## 2. Running the stack locally

Start a local Prometheus + Grafana + Alertmanager with:

```bash
docker compose -f docker-compose.yml up prometheus grafana alertmanager
```

The API and aggregator must expose their `/metrics` endpoints on scrape
targets; point the Prometheus `scrape_configs` at:

- `http://localhost:3000/metrics` (API)
- `http://localhost:<aggregator-port>/metrics` (Aggregator)

The `/metrics` endpoint is **unauthenticated by default** so Prometheus can
scrape it; do not expose the monitoring endpoints publicly in production (see
[§7 Security](#7-security-considerations)).

---

## 3. Key metrics catalog

### 3.1 API service (`api/src/observability/metrics.ts`)

| Metric | Type | Meaning |
|---|---|---|
| `http_requests_total{status_code}` | Counter | Total HTTP requests by status class |
| `http_request_duration_seconds` | Histogram | Request latency (bucketed) |
| `price_queries_total{asset}` | Counter | Price lookups served per asset |
| `last_price_timestamp_seconds{asset}` | Gauge | Epoch seconds of the most recent published price |
| `cache_hits_total` / `cache_misses_total` | Counter | Cache effectiveness |
| `circuit_breaker_active` | Gauge | 1 while an outbound circuit-breaker is open |
| `circuit_breaker_triggered_total` | Counter | Times a circuit-breaker tripped |
| `rate_limit_decisions_total{action}` | Counter | Rate-limiter allow/block decisions |
| `ws_api_connections_active` | Gauge | Live WebSocket connections |
| `ws_api_errors_total` | Counter | WebSocket errors |
| `db_query_duration_seconds` / `db_query_errors_total` | Histogram/Counter | DB health |
| `db_pool_*`, `db_replica_healthy` | Gauge | Connection-pool + replica health |

### 3.2 Aggregator service

| Metric | Type | Meaning |
|---|---|---|
| `oracle_source_request_duration_seconds` | Histogram | Per-source RPC/HTTP latency |
| `oracle_source_requests_total{source}` | Counter | Requests per oracle source |
| `oracle_source_sla_breaches_total{source}` | Counter | Times a source exceeded its SLA (5s/request) |
| `oracle_source_uptime_percent{source}` | Gauge | Rolling per-source success rate |
| `onchain_price_staleness_seconds` | Gauge | How stale the on-chain price is vs expected cadence |
| `oracle_api_calls_total` | Counter | External aggregator API calls |
| `oracle_api_budget_utilization_ratio` | Gauge | Budget consumed by external API usage |

### 3.3 Recording rules

Add recording rules in `k8s/base/prometheus-rule.yaml` for expensive or
frequently-queried expressions, e.g.:

```yaml
- record: management:http_request_error_rate_5m
  expr: |
    sum by (job) (rate(http_requests_total{status_code=~"5.."}[5m]))
      / sum by (job) (rate(http_requests_total[5m]))
```

---

## 4. SLIs and SLOs

An **SLI** is the measured signal; an **SLO** is the target share of "good"
events over a window; the **error budget** is the remaining share of tolerated
downtime. The canonical SLIs/SLOs are defined in `monitoring/slo.yml` and kept
in sync in `scripts/generate-slo-report.ts`, which renders a monthly compliance
report from Prometheus.

### 4.1 SLO table

| SLO | SLI (good events / total events) | Target | Window | Error budget |
|---|---|---|---|---|
| `api-availability` | `http_requests_total` not returning `5xx` over all requests | **99.9%** | 30d | 43.8 min/month |
| `api-latency` | API requests served under 1s (`le="1"` bucket) | **99.0%** | 30d | 7.3 h/month |
| `price-freshness` | Published asset prices younger than the staleness threshold | **99.5%** | 30d | 3.65 h/month |

PromQL (matching `scripts/generate-slo-report.ts`):

```promql
# api-availability
sum(rate(http_requests_total{job="stellar-api",status_code!~"5.."}[5m]))
  / sum(rate(http_requests_total{job="stellar-api"}[5m]))

# api-latency (p95-ish, served under 1s)
sum(rate(http_request_duration_seconds_bucket{job="stellar-api",le="1"}[5m]))
  / sum(rate(http_request_duration_seconds_count{job="stellar-api"}[5m]))

# price-freshness
sum(rate(stellar_oracle_price_checks_total{stale="false"}[5m]))
  / sum(rate(stellar_oracle_price_checks_total[5m]))
```

> If `stellar_oracle_price_checks_total` is not exported by the deployed build,
> compute freshness from `last_price_timestamp_seconds` or the aggregator's
> `onchain_price_staleness_seconds` gauge instead.

### 4.2 Error-budget alerting

Fire a page well before the budget is exhausted. A common policy:

```promql
# Burn rate > 14.4x over 1h consumes budget faster than the SLO allows.
(
  sum(rate(http_requests_total{status_code=~"5.."}[1h]))
    / clamp_min(sum(rate(http_requests_total[1h])), 0.0001)
)
  > 14.4
```

### 4.3 Generating the SLO report

```bash
tsx scripts/generate-slo-report.ts --prometheus-url=http://localhost:9090 --out=./reports
```

---

## 5. Alert rules and thresholds

Production rules live in **`k8s/base/prometheus-rule.yaml`** (SLA group). The
current set and recommended thresholds:

| Alert | Expression (recommended) | For | Severity | Runbook |
|---|---|---|---|---|
| `OracleSourceSlaBreachRateHigh` | `rate(oracle_source_sla_breaches_total[5m]) > 0.05` | 5m | **warning** | `docs/runbooks/oracle-source-down.md` |
| `OracleSourceSlaBreachRateCritical` | `rate(oracle_source_sla_breaches_total[5m]) > 0.2` | 3m | **critical** | `docs/runbooks/oracle-source-down.md` |
| `OracleSourceUptimeDegraded` | `last_over_time(oracle_source_uptime_percent{source!=""}[10m]) < 95` | 10m | **warning** | `docs/runbooks/oracle-source-down.md` |
| `ApiErrorRateHigh` | `(100 * sum(rate(http_requests_total{status_code=~"5.."}[5m])) / clamp_min(sum(rate(http_requests_total[5m])),1)) > 1` | 5m | **warning** | `docs/runbooks/high-error-rate.md` |
| `ApiErrorRateCritical` | same expression `> 5` | 5m | **critical** | `docs/runbooks/high-error-rate.md` |
| `ApiP95LatencyHigh` | `histogram_quantile(0.95, sum by (le)(rate(http_request_duration_seconds_bucket[5m]))) > 1` (seconds) | 5m | **warning** | `docs/runbooks/high-error-rate.md` |
| `PriceStale` | `max(time() - last_price_timestamp_seconds) > 120` | 2m | **warning** | `docs/runbooks/price-feed-stale.md` |
| `PriceDeviationAnomaly` | `abs(price_deviation_percent) > 5` | 5m | **warning** | `docs/runbooks/price-anomaly.md` |
| `CircuitBreakerOpen` | `circuit_breaker_active == 1` | 1m | **warning** | `docs/runbooks/oracle-source-down.md` |
| `DbReplicaLagHigh` | `db_replica_lag_seconds > 2` | 5m | **warning** | `docs/runbooks/database-issues.md` |
| `PrometheusBudgetBurnRateHigh` | burn-rate `> 14.4` over 1h | — | **critical** | [§4.2](#42-error-budget-alerting) |

### 5.1 Threshold tuning

- **Severity policy:** `critical` = page someone (PagerDuty / P1); `warning` =
  notify the on-call channel without paging.
- **`for` durations** prevent flapping from briefly spiking metrics.
- If a source's anomalies are expected (RPC maintenance), use alert
  **silences** rather than lowering the threshold, and re-evaluate at the next
  incident review.

---

## 6. Grafana dashboards

- A starter dashboard is committed at **`monitoring/grafana-dashboard.json`**.
  Import it via *Dashboards → Import → Upload file*; the default data source is
  `Prometheus`.
- Panels cover: source health/uptime, per-asset price staleness, API request
  rate + latency, cache hit ratio, and error budget status.
- **Dashboard link (production):** the deployed Grafana is referenced in
  docs/env scaffolding; the shareable dashboard URL is auto-generated at import
  (search *"Oracle Sources"* in your Grafana instance).
- Reference dashboards for load testing and cost live under `docs/dashboards/`.

---

## 7. Security considerations

- Keep `/metrics` internal. In Kubernetes, scrape via the in-cluster service
  and/or an `istio`/Cilium network policy rather than exposing it publicly.
- Rotate Alertmanager webhook secrets (Slack tokens, PagerDuty keys) and do not
  commit them (see `.env.example` / `SECRETS` guidance).
- Validate that dashboards/alerts are immutable-approved before production
  changes: every alert rule change should be reviewed and shipped through the
  `k8s/base/prometheus-rule.yaml` PR flow.

---

## 8. Validating the pipeline (tests)

- `api/tests/prometheus-alerting.test.ts` asserts the alert rule names,
  expressions and severity mapping (add a case there when you add an alert).
- `api/tests/grafana-dashboard.test.ts` asserts the dashboard JSON is valid and
  references existing metrics.
- `scripts/generate-slo-report.ts` is exercised via
  `npm run verify:contract`/CI to confirm SLO queries parse.
- Manually check `/metrics` after a deploy, and run
  `promtool check rules k8s/base/prometheus-rule.yaml` locally before applying.

---

## 9. Checklist for enabling alerting on a new environment

1. Configure Prometheus scrape targets for the API and aggregator `/metrics`.
2. Apply `k8s/base/prometheus-rule.yaml` (and environment-specific overrides).
3. Import `monitoring/grafana-dashboard.json` and point it at the right data source.
4. Set Alertmanager receivers in `k8s/chaos/reporting/alertmanager-config.yaml`.
5. Confirm SLO compatibility via `scripts/generate-slo-report.ts`.
6. Do a monitored canary deploy and verify a test alert fires end-to-end.
7. Document deviations in the SLO table above and re-run the cost check (`npm run cost:check`).

See also: `docs/TRACING.md` (distributed tracing), `docs/PERFORMANCE_TUNING.md`,
and the runbooks in `docs/runbooks/`.