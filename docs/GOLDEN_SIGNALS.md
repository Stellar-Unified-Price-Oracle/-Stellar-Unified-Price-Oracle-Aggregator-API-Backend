# Golden Signals for Production Observability

## Overview

This document defines the critical metrics (golden signals) for monitoring each component of the Stellar Oracle system. Each service tracks four golden signals: **Latency**, **Traffic**, **Errors**, and **Saturation**.

---

## 1. API Service

### Latency
- **p50, p95, p99 HTTP request duration** (`http_request_duration_seconds`)
  - Per route: `/api/v1/prices`, `/api/v1/health`, etc.
  - Target: p95 < 500ms, p99 < 1s
  - Alert: P1 if p95 > 1s

### Traffic
- **HTTP requests per second** (`rate(http_requests_total[1m])`)
  - Per method & route
  - Target: track baseline and alert on >2x deviation
  - Alert: P2 if traffic suddenly drops (service down indicator)

### Errors
- **5xx error rate** (`rate(http_requests_total{status=~"5.."}[5m]) / rate(http_requests_total[5m])`)
  - Target: < 1% (0.01)
  - Alert: P1 if > 5%
- **4xx error rate** (`rate(http_requests_total{status=~"4.."}[5m]) / rate(http_requests_total[5m])`)
  - Target: < 0.5% (indicates client issues or API misuse)
  - Alert: P2 if > 2%
- **Circuit breaker triggers** (`rate(circuit_breaker_triggered_total[5m])`)
  - Alert: P1 if triggered (indicates DB or dependency issue)

### Saturation
- **Database connection pool saturation** (`db_pool_waiting_count / db_pool_max_connections`)
  - Target: < 50% waiting
  - Alert: P1 if > 80%
- **Memory usage** (Node.js heap)
  - Target: < 80% of limit
  - Alert: P1 if > 90%
- **Cache hit ratio** (`cache_hits_total / (cache_hits_total + cache_misses_total)`)
  - Target: > 80% (indicates cache working)
  - Alert: P2 if < 50%

---

## 2. Aggregator Service

### Latency
- **Oracle source API latency** (`oracle_source_request_duration_seconds` by source)
  - Per source (Chainlink, Redstone, Band, Reflector)
  - Target: p95 < 2s
  - Alert: P1 if > 5s for critical source
- **Price aggregation time** (median calculation)
  - Target: < 100ms
  - Monitor via polling cycle timing

### Traffic
- **Requests to oracle sources per minute** (`rate(oracle_source_requests_total[1m])`)
  - Per source
  - Target: ~1 req/30s per asset (configurable poll interval)
  - Alert: P2 if drops to 0 (polling may have stopped)

### Errors
- **Oracle source success rate** (`oracle_source_requests_total{status="success"} / oracle_source_requests_total`)
  - Per source
  - Target: > 95%
  - Alert: P1 if < 85% (source degradation)
- **SLA breaches** (`rate(oracle_source_sla_breaches_total[5m])`)
  - Target: 0
  - Alert: P2 if > 0 (latency SLA exceeded)
- **Circuit breaker activations** (`rate(circuit_breaker_triggered_total[1m])`)
  - Alert: P1 if any breaker trips (indicates repeated failures)
- **On-chain price staleness** (`onchain_price_staleness_seconds`)
  - Per asset
  - Target: < 120s
  - Alert: P1 if > 300s (price not updating on-chain)

### Saturation
- **WebSocket connections** (`ws_connections_active`)
  - Target: < 10,000 (depends on capacity)
  - Alert: P2 if sustained >5,000
- **Memory usage**
  - Target: < 80% of limit
  - Alert: P1 if > 90%
- **Source API budget utilization** (`oracle_api_budget_utilization_ratio`)
  - Per source
  - Target: < 80%
  - Alert: P2 if > 80%, P1 if > 95%

---

## 3. Smart Contract (Soroban)

### Latency
- **Price submission transaction time** (from submission to confirmation)
  - Track via contract logs/events
  - Target: < 30s
  - Alert: P1 if > 60s

### Traffic
- **Contract invocations per minute** (`contract_invocations_total`)
  - Should match aggregator poll interval
  - Target: ~1 per poll interval (default 30s)
  - Alert: P2 if drops to 0 (aggregator may be down)

### Errors
- **Failed price submissions** (`contract_submission_failures_total`)
  - Alert: P1 if > 0 sustained (indicates contract issue)
- **Rejected prices** (`contract_price_rejections_total` by reason)
  - If stale, outside bounds, etc.
  - Alert: P1 if rejection rate > 10%

### Saturation
- **Contract state size** (KB)
  - Target: monitor growth trend
  - Alert: P2 if growing too fast (memory leak in logic)
- **on-chain storage** (ledger entries)
  - Track contract data footprint
  - Alert: P2 if nearing Soroban contract size limits

---

## 4. Database (TimescaleDB)

### Latency
- **Query duration percentiles** (`db_query_duration_seconds` by operation)
  - Separate INSERT, SELECT, UPDATE
  - Target: p50 < 10ms, p95 < 50ms
  - Alert: P1 if p95 > 100ms

### Traffic
- **Queries per second** (`rate(db_query_total[1m])` by operation)
  - Monitor seasonal patterns
  - Alert: P2 if sudden drop (may indicate connection issue)

### Errors
- **Query error rate** (`rate(db_query_errors_total[5m]) / rate(db_query_total[5m])`)
  - Target: < 0.1%
  - Alert: P1 if > 1%
- **Connection pool errors** (failed connection acquisitions)
  - Alert: P1 if any

### Saturation
- **Active connections** (`db_pool_total_connections` - `db_pool_idle_connections`)
  - Target: < 80% of max
  - Alert: P1 if > 90%
- **Disk space** (free space on data volume)
  - Target: > 10% free
  - Alert: P1 if < 5%
- **Replica lag** (`db_replica_lag_seconds`)
  - Per replica
  - Target: < 1s
  - Alert: P1 if > 5s (read consistency issue)
- **Index bloat** (monitor via `pg_stat_user_indexes`)
  - Alert: P2 if scan seq_scan ratio > 10%

---

## Dashboard Roles

### 1. **Incident Commander** (High-level overview)
   - System health status (green/yellow/red)
   - Top 3 metrics per service
   - Recent incidents/alerts
   - Runbook links

### 2. **API On-Call**
   - API errors (rate + heatmap)
   - Endpoint latency (p50, p95, p99)
   - HTTP status code distribution
   - Database pool health
   - Cache hit ratio

### 3. **Aggregator On-Call**
   - Oracle source health (uptime %)
   - Source latency (p95 per source)
   - Price staleness (on-chain & off-chain)
   - Circuit breaker status
   - WebSocket connection health
   - API budget utilization per source

### 4. **Contract/Infrastructure On-Call**
   - On-chain price staleness (per asset)
   - Submission success/failure rate
   - Contract invocation latency
   - Network transaction status
   - Soroban RPC health

### 5. **Database On-Call**
   - Connection pool status (active/idle)
   - Query latency distribution
   - Replication lag
   - Disk space
   - Top slow queries

---

## Alert Thresholds Summary

| Metric | Threshold | Severity |
|--------|-----------|----------|
| API p95 latency | > 1s | P1 |
| API 5xx rate | > 5% | P1 |
| Oracle source success | < 85% | P1 |
| On-chain price staleness | > 300s | P1 |
| DB query errors | > 1% | P1 |
| DB connection saturation | > 90% | P1 |
| DB replica lag | > 5s | P1 |
| Oracle SLA breach | Any | P2 |
| Cache hit ratio | < 50% | P2 |
| API budget utilization | > 80% | P2 |

---

## Observability Stack

- **Metrics**: Prometheus (scraping from `/metrics` endpoints)
- **Dashboards**: Grafana (pre-configured JSON dashboards)
- **Logs**: ELK or CloudWatch (application & system logs)
- **Traces**: Jaeger (distributed tracing)
- **Alerts**: AlertManager (Prometheus-based)

---

## Next Steps

1. Configure Prometheus scrape targets (see `docs/DEPLOYMENT.md`)
2. Import Grafana dashboards (see `monitoring/`)
3. Configure AlertManager rules (see `monitoring/alertmanager.yml`)
4. Train on-call team on dashboard navigation
5. Schedule weekly dashboard review to refine thresholds
