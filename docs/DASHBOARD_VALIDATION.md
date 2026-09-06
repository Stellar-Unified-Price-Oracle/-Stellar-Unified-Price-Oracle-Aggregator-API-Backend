# Dashboard Validation & Testing Guide

This guide helps you verify that all observability dashboards are working correctly before going live with on-call rotations.

---

## Pre-Launch Validation Checklist

### Environment Setup
- [ ] Prometheus is scraping all services (API, Aggregator, Database, Soroban)
- [ ] Grafana has access to Prometheus datasource
- [ ] All 5 dashboards imported into Grafana:
  - [ ] `incident-commander-dashboard.json`
  - [ ] `api-oncall-dashboard.json`
  - [ ] `aggregator-oncall-dashboard.json`
  - [ ] `database-oncall-dashboard.json`
  - [ ] `contract-oncall-dashboard.json`

### Dashboard Import Steps (for each JSON file)

1. Open Grafana → **Dashboards** → **New** → **Import**
2. Paste JSON content from monitoring/*.json file
3. Select Prometheus datasource
4. Click **Import**
5. Verify dashboard loads without errors (no red "query error" banners)

---

## Query Validation

For each dashboard, verify all metrics exist in Prometheus:

### Incident Commander Dashboard
```bash
# From Prometheus UI (http://prometheus:9090)

# Check each query exists and returns data:
up{job="api"}                                  # Should return 0 or 1
up{job="aggregator"}                           # Should return 0 or 1
up{job="timescaledb"}                          # Should return 0 or 1
up{job="soroban-rpc"} or on() vector(0)        # Should return 0 or 1
rate(http_requests_total{job="api",status=~"5.."}[5m])  # Should return value
rate(http_requests_total{job="api"}[5m])       # Should return value
```

✅ **Pass**: All queries return data  
❌ **Fail**: Any query shows "No data" → missing metric or label

### API On-Call Dashboard
```bash
http_request_duration_seconds                 # HTTP request latency
http_requests_total{method, route, status}    # Request counts
cache_hits_total, cache_misses_total          # Cache metrics
db_pool_*                                      # Database pool metrics
circuit_breaker_triggered_total                # Circuit breaker trips
```

**Validation Steps**:
1. Open [API Dashboard](http://localhost:3000/d/api-oncall)
2. Confirm no red error banners
3. Check each panel loads (no spinning loader > 10s)
4. Verify time series appear in graphs (not blank panels)

### Aggregator On-Call Dashboard
```bash
ws_connections_active{job="aggregator"}       # WebSocket connections
onchain_price_staleness_seconds                # On-chain staleness per asset
oracle_source_uptime_percent                   # Source uptime %
oracle_source_request_duration_seconds         # Latency per source
oracle_source_sla_breaches_total               # SLA breaches
oracle_api_budget_utilization_ratio            # Cost tracking
```

**Validation Steps**:
1. Ensure aggregator service is running and exporting metrics
2. Open [Aggregator Dashboard](http://localhost:3001/d/aggregator-oncall)
3. Verify WebSocket connections > 0 if clients connected
4. Check on-chain staleness is a reasonable number (e.g., 45–120 seconds)

### Database On-Call Dashboard
```bash
db_pool_total_connections, db_pool_idle_connections
db_pool_max_connections, db_pool_waiting_count
db_query_duration_seconds{operation}          # Query latency histogram
db_query_errors_total{operation}               # Query errors
db_replica_lag_seconds{replica}                # Replication lag
db_replica_healthy{replica}                    # Replica health (0/1)
```

**Validation Steps**:
1. Database must be running and API/Aggregator connected
2. Open [Database Dashboard](http://localhost:3002/d/database-oncall)
3. Verify connection pool shows reasonable state (idle > 0, in-use < max)
4. Check query latency appears (no NaN values)

### Contract On-Call Dashboard
```bash
contract_submission_successes_total            # Successful submissions
contract_submission_failures_total             # Failed submissions
contract_submission_latency                    # Latency histogram
onchain_price_staleness_seconds                # On-chain staleness
onchain_heartbeat_alerts_total                 # Heartbeat alerts
```

**Validation Steps**:
1. Soroban contract must be deployed and aggregator running
2. Open [Contract Dashboard](http://localhost:3003/d/contract-oncall)
3. Verify submissions are happening (non-zero counters)
4. On-chain staleness should be < 300s under normal conditions

---

## Metric Export Verification

### Check Prometheus Endpoints

```bash
# API metrics
curl http://localhost:3000/metrics | grep http_requests_total

# Aggregator metrics
curl http://localhost:4000/metrics | grep oracle_source

# Database metrics (if exposed)
curl http://localhost:5432/metrics 2>/dev/null || echo "Not exposed on 5432"

# All services via Prometheus
curl http://localhost:9090/api/v1/targets | jq '.data.activeTargets[] | {job: .labels.job, state: .state}'
```

**Expected Output**:
- Each service should show `state: "up"`
- Metric counts should be > 0

---

## Load Testing for Dashboard Validation

### Simulate Traffic & Errors

```bash
# In separate terminal, run load test while monitoring dashboards
npm run load:test

# Watch dashboards in real-time
# - API error rate should spike
# - Latency should increase
# - Cache hit ratio should change
```

### Generate Test Data

```bash
# Trigger specific scenarios to test dashboard response:

# 1. Simulate API errors
curl -i http://localhost:3000/api/v1/invalid-endpoint  # 404s
curl -i http://localhost:3000/api/v1/prices/invalid    # Error

# 2. Simulate slow database
# (Use kubectl or docker to add network latency)
kubectl exec -it deploy/api -- \
  tc qdisc add dev eth0 root netem delay 500ms

# Watch API latency panel spike

# 3. Simulate aggregator source failure
# (Misconfigure source URL in env, restart aggregator)
# Watch oracle source uptime % drop

# 4. Monitor WebSocket connections
# (Open multiple WebSocket clients)
# Watch ws_connections_active increase
```

---

## Color Coding Validation

All panels should use consistent color thresholds:

### Standard Green/Yellow/Red Mapping

| Metric | Green | Yellow | Red |
|--------|-------|--------|-----|
| Error Rate | < 1% | 1–5% | > 5% |
| Uptime % | > 95% | 85–95% | < 85% |
| Staleness (s) | < 120 | 120–300 | > 300 |
| Saturation (%) | < 75% | 75–90% | > 90% |
| Latency (ms) | < 500 | 500–1000 | > 1000 |

**Validation**:
- Open a dashboard with high error rate
- Panel background should be RED
- Open a dashboard with normal operations
- Panel background should be GREEN
- Adjust a metric to "yellow" range and verify YELLOW background

---

## Cross-Dashboard Correlation Check

### Scenario: API Error Spike

**Trigger**:
1. Simulate database connection pool exhaustion
2. Watch all dashboards simultaneously

**Expected Correlation**:
- ✅ Incident Commander: API card goes RED
- ✅ API Dashboard: 5xx error rate spikes
- ✅ Database Dashboard: Connection pool > 90%
- ✅ Contract Dashboard: Submission failures increase (if contract depends on API)

**Validation**:
- [ ] All 5 dashboards show consistent story
- [ ] Error propagation time < 1 minute
- [ ] Metrics align across dashboards (timestamps match)

### Scenario: Oracle Source Failure

**Trigger**:
1. Take down one oracle source (e.g., Chainlink)
2. Watch aggregator behavior

**Expected Correlation**:
- ✅ Incident Commander: (no change if redundancy OK)
- ✅ Aggregator Dashboard: Source uptime drops for Chainlink
- ✅ Aggregator Dashboard: No impact on on-chain staleness (other sources healthy)
- ✅ API Dashboard: (no impact to API)
- ✅ Contract Dashboard: (no impact to submissions)

**Validation**:
- [ ] Incident Commander shows no alert (redundancy working)
- [ ] Aggregator compensates with remaining sources

---

## Runbook Link Verification

All dashboards should link to relevant runbooks. Validate:

```bash
# Check that runbook files exist
ls -la docs/runbooks/

# Expected files:
# - high-error-rate.md
# - price-feed-stale.md
# - oracle-source-down.md
# - database-issues.md
# - contract-failures.md
# - price-anomaly.md
```

**Validation**:
- [ ] Click runbook link in each dashboard
- [ ] Link resolves to correct .md file
- [ ] File is readable and up to date

---

## Alert Configuration Validation

Verify that AlertManager rules align with dashboard thresholds:

```bash
# Check AlertManager configuration
cat monitoring/alertmanager.yml

# Verify alerts defined for:
# - HighErrorRate (API 5xx > 5%)
# - PriceFeedStale (on-chain staleness > 300s)
# - OracleSourceDown (uptime < 85%)
# - DBConnectionPoolExhaustion (> 90%)
# - HighLatency (p95 > 1s)
```

**Validation**:
- [ ] Alert thresholds match dashboard yellow/red zones
- [ ] Alert rules match runbook severity levels
- [ ] No conflicting alert definitions

---

## Performance Testing

### Dashboard Load Time

```bash
# Measure Grafana response time
time curl -s http://localhost:3000/api/dashboards/uid/incident-commander \
  -H "Authorization: Bearer $GRAFANA_TOKEN" | jq .

# Target: < 1 second for dashboard load
# Target: < 5 seconds for full panel rendering
```

### Prometheus Query Performance

```bash
# Check query execution time
curl -s 'http://localhost:9090/api/v1/query?query=up{job="api"}&time=now' \
  | jq '.stats.timings'

# Target: < 100ms for simple queries
# Target: < 1s for complex histogram_quantile queries
```

**Optimization** (if slow):
- Reduce data retention period in Prometheus
- Downsample old metrics
- Add indexes to common label combinations

---

## Team Training Session Checklist

Schedule a 1-hour group review before going live:

### Part 1: High-Level Tour (15 min)
- [ ] Show Incident Commander dashboard
- [ ] Explain service health cards
- [ ] Demo drill-down to specific dashboard

### Part 2: Deep Dives by Role (30 min)
- [ ] API On-Call: Diagnose error spike
- [ ] Aggregator On-Call: Respond to stale feed
- [ ] Database On-Call: Handle connection saturation
- [ ] Contract On-Call: Investigate submission failure

### Part 3: Incident Simulation (15 min)
- [ ] Trigger a fake alert
- [ ] Have on-call use dashboard to diagnose
- [ ] Practice calling runbook and escalating

### After Session
- [ ] Collect feedback on dashboard usability
- [ ] Document any missing metrics or panels
- [ ] Schedule follow-up training after first real incident

---

## Sign-Off Checklist

| Item | Owner | Status |
|------|-------|--------|
| All dashboards imported and displaying data | Infra | ⬜ |
| All queries validated in Prometheus | Infra | ⬜ |
| Color thresholds match alert definitions | Infra | ⬜ |
| Runbook links verified | Doc Lead | ⬜ |
| Cross-dashboard correlation confirmed | QA | ⬜ |
| Team trained on dashboard usage | On-Call Lead | ⬜ |
| Performance tested and optimized | Infra | ⬜ |
| Incident simulation completed | On-Call Lead | ⬜ |
| Go-live approval | Engineering Lead | ⬜ |

---

## Troubleshooting Common Issues

### Panel Shows "No Data"
- **Check**: Is the service running?
- **Check**: Is Prometheus scraping that service?
- **Fix**: `curl http://service:port/metrics` to verify endpoint exists
- **Fix**: Check Prometheus targets: `http://localhost:9090/targets`

### Dashboard Loads Slowly (> 10s)
- **Check**: Number of panels on dashboard
- **Check**: Query complexity (avoid multiple histogram_quantiles)
- **Fix**: Reduce time range (6h instead of 30d)
- **Fix**: Increase Prometheus `query.max-samples` config
- **Fix**: Move non-critical panels to separate dashboard

### Metrics Stopped Appearing
- **Check**: Service still running?
- **Check**: Prometheus still scraping? (check targets page)
- **Check**: Metric name changed in code?
- **Fix**: Restart scraper: `kubectl rollout restart -n prometheus daemonset/prometheus`

### Color Not Changing to Red
- **Check**: Threshold settings in field config
- **Check**: Metric actually exceeds threshold value
- **Fix**: Temporarily lower threshold to < current value to test
- **Fix**: Verify metric unit matches threshold unit (e.g., percentunit vs percent)

---

## Rollback Plan

If dashboards cause confusion or incorrect decisions:

1. **Revert dashboards to main branch** (version control)
2. **Revert AlertManager rules** to previous version
3. **Communicate status** to on-call team
4. **Post-mortem**: Document what went wrong
5. **Iterate**: Fix and re-test before re-deploy

---

## Success Metrics

After 1 week of using dashboards:
- ✅ Average incident diagnosis time < 5 minutes
- ✅ Zero incidents caused by dashboard misconfiguration
- ✅ On-call team confidence in dashboards > 8/10
- ✅ All runbook links used without error
- ✅ No "blind spots" (situations not covered by dashboards)

---

## Contact & Support

- **Questions about dashboard setup**: Infra team
- **Questions about metrics**: Metrics owner (see code comments)
- **Enhancement requests**: File GitHub issue with `dashboard` label
- **Emergency dashboard issues during incident**: Page on-call lead
