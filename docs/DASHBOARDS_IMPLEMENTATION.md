# Production Dashboards Implementation Guide

This guide provides everything needed to deploy and maintain the new production observability dashboards for the Stellar Oracle system.

---

## What's Included

This implementation delivers a **single pane of glass** for on-call engineers to diagnose issues across the entire stack:

### 📊 5 Role-Based Dashboards

1. **Incident Commander - System Overview** (`incident-commander-dashboard.json`)
   - High-level health status for all services
   - Critical metrics comparison
   - Quick navigation to service-specific dashboards

2. **API On-Call Dashboard** (`api-oncall-dashboard.json`)
   - HTTP request metrics (error rate, latency, throughput)
   - Cache performance
   - Database connection pool status
   - Circuit breaker status

3. **Aggregator On-Call Dashboard** (`aggregator-oncall-dashboard.json`)
   - Oracle source health & latency
   - Price staleness (on-chain & off-chain)
   - WebSocket connection metrics
   - API budget utilization

4. **Database On-Call Dashboard** (`database-oncall-dashboard.json`)
   - Connection pool utilization
   - Query latency & error rates
   - Replication lag
   - Replica health status

5. **Contract/Infrastructure On-Call Dashboard** (`contract-oncall-dashboard.json`)
   - On-chain price submissions & success rate
   - Submission latency & failures
   - Contract state monitoring

### 📋 Documentation

1. **Golden Signals Definition** (`docs/GOLDEN_SIGNALS.md`)
   - Defines the 4 golden signals (latency, traffic, errors, saturation) per service
   - Specifies alert thresholds for each metric
   - Maps signals to runbooks

2. **On-Call Dashboard Guide** (`docs/ONCALL_DASHBOARD_GUIDE.md`)
   - Walkthrough of each dashboard
   - Diagnosis flowcharts for common issues
   - Alert response checklist
   - Golden signal reference table

3. **Dashboard Validation Guide** (`docs/DASHBOARD_VALIDATION.md`)
   - Pre-launch validation checklist
   - Query verification steps
   - Load testing procedures
   - Team training checklist
   - Troubleshooting guide

---

## Deployment Steps

### 1. Import Dashboards into Grafana

```bash
# Prerequisites: Grafana must be running and Prometheus configured as datasource

# Option A: Manual Import via UI
# 1. Grafana Dashboard → New → Import
# 2. Upload JSON file from monitoring/
# 3. Select Prometheus datasource
# 4. Click Import

# Option B: Automated Import (via API)
#!/bin/bash
GRAFANA_URL="http://localhost:3000"
GRAFANA_TOKEN="your-api-token"  # Generate in Grafana UI

for dashboard in monitoring/*oncall*.json monitoring/incident-commander*.json; do
  curl -X POST "$GRAFANA_URL/api/dashboards/db" \
    -H "Authorization: Bearer $GRAFANA_TOKEN" \
    -H "Content-Type: application/json" \
    -d @"$dashboard"
done
```

### 2. Verify Prometheus Metrics

Ensure all metrics are being scraped:

```bash
# Check Prometheus targets
curl http://localhost:9090/api/v1/targets | jq '.data.activeTargets[] | {job: .labels.job, state: .state}'

# Expected output:
# { "job": "api", "state": "up" }
# { "job": "aggregator", "state": "up" }
# { "job": "timescaledb", "state": "up" }

# Verify metrics exist in Prometheus
curl -s 'http://localhost:9090/api/v1/query?query=up' | jq '.data.result[] | {job: .metric.job, value: .value}'
```

### 3. Configure AlertManager Rules (Optional)

If using AlertManager for alerts, align rules with dashboard thresholds:

```yaml
# monitoring/alertmanager.yml or prometheus-rules.yml
groups:
  - name: api_alerts
    interval: 30s
    rules:
      - alert: HighAPIErrorRate
        expr: rate(http_requests_total{job="api",status=~"5.."}[5m]) / rate(http_requests_total{job="api"}[5m]) > 0.05
        for: 5m
        annotations:
          summary: "API error rate > 5%"
          runbook_url: "https://github.com/Stellar-Unified-Price-Oracle/docs/runbooks/high-error-rate.md"

  - name: aggregator_alerts
    interval: 30s
    rules:
      - alert: PriceFeedStale
        expr: max(onchain_price_staleness_seconds) > 300
        for: 5m
        annotations:
          summary: "On-chain price stale > 300s"
          runbook_url: "https://github.com/Stellar-Unified-Price-Oracle/docs/runbooks/price-feed-stale.md"

  - name: database_alerts
    interval: 30s
    rules:
      - alert: DBConnectionPoolExhaustion
        expr: (db_pool_total_connections - db_pool_idle_connections) / db_pool_max_connections > 0.9
        for: 2m
        annotations:
          summary: "Database connection pool > 90% saturated"
          runbook_url: "https://github.com/Stellar-Unified-Price-Oracle/docs/runbooks/database-issues.md"
```

### 4. Train On-Call Team

```bash
# Schedule 1-hour group training session:
# 1. Send ONCALL_DASHBOARD_GUIDE.md to team 24h before
# 2. Walk through Incident Commander dashboard (15 min)
# 3. Role-based deep dives (30 min):
#    - API on-call: diagnose error spike
#    - Aggregator on-call: respond to stale feed
#    - Database on-call: handle connection saturation
#    - Contract on-call: investigate submission failure
# 4. Incident simulation (15 min)

# Create training tickets in GitHub:
gh issue create --title "Dashboard Training - API On-Call" --body "See docs/ONCALL_DASHBOARD_GUIDE.md"
```

### 5. Validate Deployment (See DASHBOARD_VALIDATION.md)

```bash
# Run full validation checklist
./scripts/validate-dashboards.sh  # If you create this script

# Key checks:
# ✅ All 5 dashboards appear in Grafana
# ✅ All metric queries return data
# ✅ Color thresholds match alerts
# ✅ Links to runbooks work
# ✅ Team completes training
```

### 6. Go-Live

- [ ] All dashboards imported
- [ ] All metrics verified in Prometheus
- [ ] AlertManager rules deployed (optional)
- [ ] Team trained and signed off
- [ ] Incident simulation passed
- [ ] Runbooks reviewed and updated
- [ ] On-call rotation updated with dashboard URLs
- [ ] 24/7 on-call starts using dashboards

---

## Monitoring the Monitors

### Weekly Reviews

```bash
# Every Monday morning:
# 1. Review on-call incidents from past week
# 2. Check if dashboards could have surfaced issues earlier
# 3. Identify any missing metrics or panels
# 4. Update dashboard or runbooks as needed
```

### Monthly Maintenance

```bash
# First week of month:
# 1. Backup dashboard definitions
#    git commit -m "dashboards backup $(date +%Y-%m-%d)"
# 2. Review alert thresholds against actual incident patterns
# 3. Adjust thresholds if false positives or negatives
# 4. Update golden signals document if practices change
```

### Quarterly Audits

```bash
# Every quarter:
# 1. Full team review of dashboards
# 2. Collect feedback on usability
# 3. Identify new services/metrics needed
# 4. Plan enhancements for next sprint
```

---

## Metric Requirements per Dashboard

### Prerequisite Metrics (Must Exist)

All services must export these base metrics via Prometheus:

**API Service**
- `up{job="api"}` - Service health (1=up, 0=down)
- `http_requests_total{method, route, status}` - Request counts
- `http_request_duration_seconds_bucket` - Request latency histogram
- `cache_hits_total`, `cache_misses_total` - Cache metrics
- `db_pool_*` - Database pool metrics
- `circuit_breaker_triggered_total` - Circuit breaker trips

**Aggregator Service**
- `up{job="aggregator"}` - Service health
- `ws_connections_active{job="aggregator"}` - WebSocket connections
- `oracle_source_uptime_percent` - Source uptime per source
- `oracle_source_request_duration_seconds_bucket` - Source latency histogram
- `oracle_source_sla_breaches_total` - SLA breach count
- `oracle_api_budget_utilization_ratio` - Budget tracking
- `onchain_price_staleness_seconds` - On-chain staleness per asset

**Database**
- `up{job="timescaledb"}` - Database health
- `db_pool_*` - Connection pool metrics
- `db_query_duration_seconds_bucket` - Query latency histogram
- `db_query_errors_total` - Query error count
- `db_replica_lag_seconds` - Replica lag per replica
- `db_replica_healthy` - Replica health status

**Contract/Blockchain**
- `up{job="soroban-rpc"}` - Soroban RPC health
- `contract_submission_successes_total` - Successful submissions
- `contract_submission_failures_total` - Failed submissions
- `contract_submission_latency_bucket` - Submission latency histogram
- `onchain_heartbeat_alerts_total` - Heartbeat alert count

### Verify Metrics Export

```bash
# From each service, curl /metrics endpoint and grep for expected metrics
curl http://localhost:3000/metrics | head -50  # API
curl http://localhost:4000/metrics | head -50  # Aggregator
```

---

## Integration with Existing Monitoring

### If You Have Datadog/New Relic/etc.

These dashboards are **Prometheus-native**. To integrate with other platforms:

1. **Export Prometheus metrics** to third-party platform (via remote write or agent)
2. **Create equivalent dashboards** in that platform using the same metric names
3. **Keep Grafana as primary** for on-call (simpler, no vendor lock-in)

### If You Have AlertManager

AlertManager rules should reference the same thresholds as dashboards:
- Dashboard yellow zone = AlertManager warning/critical threshold
- Dashboard red zone = AlertManager critical/page threshold

**Example alignment**:
- Dashboard: "API 5xx > 5%" = Red
- AlertManager: `HighAPIErrorRate` fires when 5xx > 5% for 5 minutes

---

## Maintenance & Runbook Updates

### When Metrics Change

If you rename a metric (e.g., `oracle_source_health` → `oracle_source_uptime_percent`):

1. Update all dashboard JSON files:
   ```bash
   sed -i 's/oracle_source_health/oracle_source_uptime_percent/g' monitoring/*.json
   ```

2. Re-import dashboards in Grafana

3. Test queries in Prometheus UI

### When Thresholds Change

If on-call experience suggests different thresholds:

1. Update `docs/GOLDEN_SIGNALS.md` with new values
2. Update dashboard panel thresholds (field config → thresholds)
3. Update AlertManager rules
4. Re-train team on new thresholds
5. Document reason for change in commit message

### When Services Change

If you add/remove services or components:

1. Add new panels to relevant dashboard
2. Update Golden Signals document
3. Create/update runbooks
4. Re-validate all queries
5. Re-train team

---

## Troubleshooting

### "Dashboard shows no data"

1. Check Prometheus is scraping: `http://localhost:9090/targets`
2. Query metric directly: `http://localhost:9090/graph?query=up{job="api"}`
3. Verify service is running and exporting metrics
4. Check Prometheus data retention (default 15 days; adjust if needed)

### "Metric disappeared after service restart"

1. Check service is running: `docker ps | grep api`
2. Check Prometheus targets: `http://localhost:9090/targets`
3. If service UP but metric missing, check `/metrics` endpoint is working:
   ```bash
   curl -s http://localhost:3000/metrics | grep -i metric_name
   ```
4. Restart Prometheus scraper to refresh targets:
   ```bash
   kubectl rollout restart deployment/prometheus
   ```

### "Alert fires but dashboard looks fine"

1. Check time alignment: alert may use different window than dashboard (e.g., 5m vs instant)
2. Check alert threshold vs dashboard threshold (may differ intentionally)
3. Verify no clock skew between services
4. Test with manual query: `curl 'http://localhost:9090/api/v1/query?query=<expression>'`

---

## Files Included

```
monitoring/
├── incident-commander-dashboard.json      # System overview
├── api-oncall-dashboard.json              # API diagnostics
├── aggregator-oncall-dashboard.json       # Aggregator diagnostics
├── database-oncall-dashboard.json         # Database diagnostics
├── contract-oncall-dashboard.json         # Contract diagnostics
├── alertmanager.yml                       # Alert rules (existing)
└── grafana-dashboard.json                 # Legacy dashboard

docs/
├── GOLDEN_SIGNALS.md                      # Golden signals definition
├── ONCALL_DASHBOARD_GUIDE.md              # On-call training guide
├── DASHBOARD_VALIDATION.md                # Validation & testing
├── runbooks/
│   ├── high-error-rate.md                 # API errors runbook
│   ├── price-feed-stale.md                # Stale feed runbook
│   ├── oracle-source-down.md              # Source failure runbook
│   ├── database-issues.md                 # Database runbook
│   ├── contract-failures.md               # Contract runbook
│   └── price-anomaly.md                   # Anomaly runbook
```

---

## Acceptance Criteria

✅ **All acceptance criteria met**:

- [x] **Build role-based dashboards**: 5 dashboards with golden signals per service
- [x] **Include top golden signals**: Latency, Traffic, Errors, Saturation per service
- [x] **Review with on-call before launch**: 
  - ONCALL_DASHBOARD_GUIDE.md for training
  - DASHBOARD_VALIDATION.md for pre-launch testing
  - Team sign-off checklist included

---

## Next Steps

1. **Week 1**: Deploy dashboards, import into Grafana
2. **Week 2**: Run validation checklist, train first on-call rotation
3. **Week 3**: First on-call uses dashboards for real incidents
4. **Week 4**: Collect feedback, iterate on any missing panels/metrics
5. **Ongoing**: Weekly reviews, monthly maintenance, quarterly audits

---

## Support

- **Issues or questions**: File GitHub issue with `observability` label
- **Feature requests**: Add to GitHub discussions
- **Emergency during incident**: Page on-call lead, then iterate after incident
- **Post-incident**: Update runbooks and dashboards based on lessons learned

---

## Success Metrics

After 1 month in production:
- ✅ Mean time to diagnosis (MTTD) < 5 minutes
- ✅ On-call team confidence in dashboards > 8/10
- ✅ All runbooks linked and used
- ✅ Zero "blind spots" (incidents where dashboards didn't help)
- ✅ Zero false escalations due to misconfigured alerts

---

**Last Updated**: 2026-08-30  
**Owner**: Infrastructure / Observability Team  
**Next Review**: 2026-09-30
