# Production Observability Dashboards

Welcome to the Stellar Oracle observability dashboard suite. This directory contains production-ready Grafana dashboards that provide a **single pane of glass** for diagnosing issues across the entire stack.

---

## 🚀 Quick Start

### For On-Call Engineers (First Time?)

1. **Read**: [ONCALL_DASHBOARD_GUIDE.md](../docs/ONCALL_DASHBOARD_GUIDE.md) (20 min read)
2. **Explore**: Open Grafana and visit the [Incident Commander Dashboard](http://localhost:3000/d/incident-commander)
3. **Practice**: Follow a diagnosis flowchart for your service
4. **Reference**: Keep the [golden signals quick ref](../docs/GOLDEN_SIGNALS.md#golden-signal-quick-reference) handy

### For Deployment/DevOps Teams

1. **Deploy**: Follow [DASHBOARDS_IMPLEMENTATION.md](../docs/DASHBOARDS_IMPLEMENTATION.md)
2. **Validate**: Run through [DASHBOARD_VALIDATION.md](../docs/DASHBOARD_VALIDATION.md)
3. **Train**: Schedule team session using [training checklist](../docs/DASHBOARD_VALIDATION.md#team-training-session-checklist)

---

## 📊 5 Production Dashboards

| Dashboard | File | Purpose | Audience |
|-----------|------|---------|----------|
| **Incident Commander** | `incident-commander-dashboard.json` | System overview; quick escalation | On-call manager, engineering lead |
| **API On-Call** | `api-oncall-dashboard.json` | Request metrics, errors, latency | API engineer |
| **Aggregator On-Call** | `aggregator-oncall-dashboard.json` | Oracle health, price staleness | Aggregator engineer |
| **Database On-Call** | `database-oncall-dashboard.json` | Query perf, connections, replication | Database engineer |
| **Contract On-Call** | `contract-oncall-dashboard.json` | On-chain submissions, staleness | Infra/contract engineer |

---

## 📖 Documentation Map

### For On-Call Training
- **[ONCALL_DASHBOARD_GUIDE.md](../docs/ONCALL_DASHBOARD_GUIDE.md)** — How to read & use dashboards + diagnosis flowcharts
- **[GOLDEN_SIGNALS.md](../docs/GOLDEN_SIGNALS.md)** — Metrics definition + alert thresholds

### For Deployment & Operations
- **[DASHBOARDS_IMPLEMENTATION.md](../docs/DASHBOARDS_IMPLEMENTATION.md)** — Import, verify, configure, maintain
- **[DASHBOARD_VALIDATION.md](../docs/DASHBOARD_VALIDATION.md)** — Pre-launch testing checklist
- **[DASHBOARDS_DELIVERY_SUMMARY.md](../docs/DASHBOARDS_DELIVERY_SUMMARY.md)** — What was built + acceptance criteria

### For Incident Response
- **[runbooks/](../docs/runbooks/)** — Runbooks linked from all dashboards:
  - `high-error-rate.md` → API errors
  - `price-feed-stale.md` → Stale feeds
  - `oracle-source-down.md` → Source failures
  - `database-issues.md` → DB problems
  - `contract-failures.md` → Contract issues
  - `price-anomaly.md` → Anomalies

---

## 🎯 Golden Signals at a Glance

Every service tracks 4 golden signals: **Latency, Traffic, Errors, Saturation**

### API Service
- **Error Rate**: Target < 1% (🔴 alert if > 5%)
- **Latency p95**: Target < 500ms
- **Cache Hit Ratio**: Target > 80%
- **DB Pool Saturation**: Target < 75%

### Aggregator Service
- **Oracle Uptime**: Target > 95% (🔴 alert if < 85%)
- **On-Chain Staleness**: Target < 120s (🔴 alert if > 300s)
- **SLA Breaches**: Target 0
- **WebSocket Connections**: Target < 5K

### Database
- **Query Error Rate**: Target < 0.1%
- **Query p95 Latency**: Target < 50ms
- **Pool Saturation**: Target < 75%
- **Replica Lag**: Target < 1s

### Smart Contract
- **Submission Success**: Target > 99% (🔴 alert if < 90%)
- **Submission Latency**: Target < 30s
- **On-Chain Staleness**: Target < 120s
- **Heartbeat Alerts**: Target 0

---

## 🔄 Workflow: Incident → Dashboard → Runbook

```
Alert fires
    ↓
Open Incident Commander dashboard
    ↓
Identify which service is RED
    ↓
Drill into service-specific dashboard
    ↓
Follow diagnosis flowchart
    ↓
Click runbook link
    ↓
Execute mitigation steps
    ↓
Verify recovery
    ↓
Document findings
```

---

## 🛠️ Deployment

### Option 1: Manual Import (UI)
```
Grafana → Dashboards → New → Import
→ Upload JSON file
→ Select Prometheus datasource
→ Click Import
```

### Option 2: Automated (API)
```bash
GRAFANA_TOKEN="your-token"
curl -X POST "http://localhost:3000/api/dashboards/db" \
  -H "Authorization: Bearer $GRAFANA_TOKEN" \
  -H "Content-Type: application/json" \
  -d @incident-commander-dashboard.json
```

**See [DASHBOARDS_IMPLEMENTATION.md](../docs/DASHBOARDS_IMPLEMENTATION.md) for full deployment guide.**

---

## ✅ Pre-Launch Validation

Before going live with on-call:

1. **Import all 5 dashboards** into Grafana
2. **Verify metrics exist** in Prometheus (see DASHBOARD_VALIDATION.md)
3. **Run load test** while monitoring dashboards
4. **Train team** using ONCALL_DASHBOARD_GUIDE.md
5. **Simulate incident** to practice diagnosis
6. **Get sign-off** from team leads

**Full checklist in [DASHBOARD_VALIDATION.md](../docs/DASHBOARD_VALIDATION.md)**

---

## 📞 Common Questions

### "Which dashboard should I look at?"

- **General overview?** → Incident Commander
- **API errors?** → API On-Call Dashboard
- **Price stale?** → Aggregator or Contract dashboard (depending on where staleness is)
- **Database slow?** → Database On-Call Dashboard
- **On-chain issue?** → Contract On-Call Dashboard

### "How do I know if it's a real problem?"

Check the golden signals quick reference table in [GOLDEN_SIGNALS.md](../docs/GOLDEN_SIGNALS.md). If metric is in red zone (e.g., error rate > 5%), it's a real problem.

### "What should I do if a dashboard shows a problem?"

1. Find the diagnosis flowchart in [ONCALL_DASHBOARD_GUIDE.md](../docs/ONCALL_DASHBOARD_GUIDE.md)
2. Follow the flowchart to narrow down root cause
3. Click the runbook link
4. Execute the steps

### "A metric disappeared from my dashboard!"

See [DASHBOARD_VALIDATION.md - Troubleshooting](../docs/DASHBOARD_VALIDATION.md#troubleshooting-common-issues) section.

### "I want to update a dashboard"

See [DASHBOARDS_IMPLEMENTATION.md - Maintenance](../docs/DASHBOARDS_IMPLEMENTATION.md#maintenance--runbook-updates) section.

---

## 🎓 Training Path

**New to on-call?** Follow this path:

1. **Week 1**: Read [ONCALL_DASHBOARD_GUIDE.md](../docs/ONCALL_DASHBOARD_GUIDE.md)
2. **Week 1**: Attend team training session
3. **Week 1**: Practice with staging environment
4. **Week 2+**: Use dashboards in real on-call rotation

**Experienced on-call?** Just:
1. Skim [ONCALL_DASHBOARD_GUIDE.md](../docs/ONCALL_DASHBOARD_GUIDE.md) for new dashboards
2. Bookmark the 5 dashboard URLs
3. Keep [GOLDEN_SIGNALS.md](../docs/GOLDEN_SIGNALS.md#golden-signal-quick-reference) handy

---

## 📊 Metrics Reference

All metrics exported by services:

### API Service (`/metrics` on port 3000)
- `http_requests_total{method, route, status}` — Request counts
- `http_request_duration_seconds_bucket` — Latency histogram
- `cache_hits_total`, `cache_misses_total` — Cache metrics
- `db_pool_*` — Database connection pool
- `circuit_breaker_triggered_total` — Circuit breaker trips

### Aggregator Service (`/metrics` on port 4000)
- `oracle_source_*` — Source latency, requests, uptime
- `onchain_price_staleness_seconds` — On-chain staleness per asset
- `ws_connections_*` — WebSocket connection metrics
- `oracle_api_budget_utilization_ratio` — Cost tracking

### Database (via Node.js exporter)
- `db_pool_*` — Connection pool status
- `db_query_duration_seconds_bucket` — Query latency
- `db_query_errors_total` — Query error count
- `db_replica_lag_seconds` — Replication lag

### Smart Contract (via application logs → exporter)
- `contract_submission_*` — Submission success/failure/latency
- `onchain_price_staleness_seconds` — On-chain staleness
- `onchain_heartbeat_alerts_total` — Heartbeat alerts

---

## 🚨 Alert Integration

All dashboards are designed to align with AlertManager rules:

- Dashboard **yellow zone** = AlertManager warning threshold
- Dashboard **red zone** = AlertManager critical/page threshold

Example: API error rate panel shows RED at > 5%, and AlertManager fires alert at same threshold.

---

## 🔄 Maintenance Schedule

| Frequency | Task | Owner |
|-----------|------|-------|
| **Weekly** | Review incidents; update dashboards if needed | On-call lead |
| **Monthly** | Team review of thresholds & runbooks | Infra team |
| **Quarterly** | Full audit of all dashboards | Eng leadership |
| **Before each deploy** | Test dashboards in staging | QA team |

---

## 📈 Success Metrics

**After 1 week of production use:**
- ✅ Mean time to diagnosis (MTTD) < 5 minutes
- ✅ On-call team confidence > 8/10
- ✅ 0 incidents caused by dashboard errors
- ✅ All runbooks used successfully
- ✅ No "blind spots" in observability

---

## 🤝 Contributing

Found an issue or want to improve a dashboard?

1. **Check current issue**: Does it already exist in GitHub?
2. **File issue**: Include screenshot + dashboard name
3. **Suggest fix**: Include what metric should replace/add
4. **Get feedback**: Post in `#incidents` or tag on-call lead
5. **Update**: Follow [maintenance guide](../docs/DASHBOARDS_IMPLEMENTATION.md#maintenance--runbook-updates)

---

## 📞 Support

- **Questions about dashboards**: Check [ONCALL_DASHBOARD_GUIDE.md](../docs/ONCALL_DASHBOARD_GUIDE.md)
- **Deployment help**: Check [DASHBOARDS_IMPLEMENTATION.md](../docs/DASHBOARDS_IMPLEMENTATION.md)
- **Validation issues**: Check [DASHBOARD_VALIDATION.md](../docs/DASHBOARD_VALIDATION.md)
- **Still stuck?**: File GitHub issue or Slack #incidents

---

## 📜 License

Same as main repository (see LICENSE file)

---

**Last Updated**: 2026-08-30  
**Status**: 🟢 Production Ready  
**Owner**: Infrastructure / Observability Team  
**Next Review**: 2026-09-30
