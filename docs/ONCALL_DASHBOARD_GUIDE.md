# On-Call Dashboard Review & Training Guide

## Overview

This guide prepares on-call engineers to use the new role-based observability dashboards for the Stellar Oracle system. A single pane of glass replaces fragmented monitoring, enabling faster diagnosis and resolution.

---

## Dashboard Access & Setup

### Grafana Access
- **Production URL**: `https://monitoring.stellar-oracle.com/grafana`
- **Staging URL**: `https://staging-monitoring.stellar-oracle.com/grafana`
- **Default Refresh**: 30 seconds
- **Time Range Presets**: Last 6 hours (default); adjust as needed for incident analysis

### Dashboard List

| Role | Dashboard | URL | Purpose |
|------|-----------|-----|---------|
| **Incident Commander** | Incident Commander - System Overview | `/d/incident-commander` | High-level health; see all critical signals at a glance |
| **API On-Call** | API Service - On-Call Dashboard | `/d/api-oncall` | Diagnose API errors, latency, cache, DB pool issues |
| **Aggregator On-Call** | Aggregator Service - On-Call Dashboard | `/d/aggregator-oncall` | Track oracle sources, price staleness, WebSocket health |
| **Database On-Call** | Database - On-Call Dashboard | `/d/database-oncall` | Monitor connection pool, query perf, replication lag |
| **Contract/Infra On-Call** | Smart Contract & Blockchain - On-Call Dashboard | `/d/contract-oncall` | Track on-chain submissions, price staleness, heartbeats |

---

## Dashboard Walkthrough

### 1. Incident Commander Dashboard
**When to Use**: On-call manager starting shift, responding to alerts, escalating issues

**Key Metrics**:
- **Service Status Cards** (top row): Green = healthy, Red = down
  - API, Aggregator, Database, Soroban RPC
- **Error Rates** (middle left): API 5xx % and DB error %
  - 🟢 Green: < 1%
  - 🟡 Yellow: 1–5%
  - 🔴 Red: > 5%
- **Critical Metrics** (middle right): On-chain staleness and active circuit breakers
- **Oracle Source Health** (bottom left): Per-source uptime %
- **Latency Comparison** (bottom right): p95 across API, DB, and oracle sources

**Action Triggers**:
- 🔴 Any service RED: Page on-call engineer; check service-specific dashboard
- 🔴 API 5xx > 5%: Drill into **API On-Call Dashboard**
- 🔴 On-chain staleness > 300s: Drill into **Contract Dashboard**
- 🔴 Oracle source < 85% uptime: Drill into **Aggregator Dashboard**

**What to Communicate**:
1. Status summary (healthy/degraded/critical)
2. Which service(s) are affected
3. Rough impact (e.g., "price updates stalled")
4. Link to specific dashboard for the team

---

### 2. API On-Call Dashboard
**When to Use**: Incident Commander escalates API issues, API engineer joins on-call

**Key Panels**:

#### Top Row (Status Cards):
- **API Service Status**: Should show green (UP)
- **5xx Error Rate (5m avg)**: Target < 1%
  - 🟢 < 1%: OK
  - 🟡 1–5%: Alert; investigate endpoint
  - 🔴 > 5%: Page lead; likely DB or dependency issue
- **API Latency p95**: Target < 500ms
  - 🟢 < 500ms: OK
  - 🟡 500–1000ms: Investigate slow queries/DB
  - 🔴 > 1000ms: Critical; scale or fix issue

#### Main Panels:
1. **Request Rate by Method**: Spot traffic anomalies (sudden spike = attack or new client; drop = service issue)
2. **HTTP Status Distribution (5m)**: Visual breakdown of 2xx/4xx/5xx
   - If 5xx is growing, click drill-down to find which endpoints are failing
3. **Latency Percentiles (p50/p95/p99)**: Tail latency matters for user experience
   - p99 > 1s usually indicates DB or dependency slowness
4. **Cache Hit Ratio**: Target > 80%
   - < 50% = cache misconfiguration or cache eviction
   - Check if downstream systems are polling too frequently
5. **Database Connection Pool**: Shows idle/in-use/waiting
   - Waiting > 0 = pool exhaustion risk; scale connections
   - In-use > 80% of max = high saturation
6. **Traffic by Endpoint**: Identify which endpoint drives most load
   - Helps diagnose which feature causing issues
7. **Circuit Breaker Trips**: Should stay at 0
   - > 0 = DB or upstream service down; check DB dashboard

**Diagnosis Flowchart**:
```
5xx errors > 5%?
  ├─ Yes, Circuit Breaker Trips > 0?
  │   └─ Yes → DB issue; go to DB Dashboard
  │   └─ No → Check HTTP Status Distribution
  │          ├─ 503 Service Unavailable → DB pool or dependency down
  │          ├─ 500 Internal Server Error → Application error; check logs
  │          └─ 504 Gateway Timeout → Slow query/DB; check DB Dashboard
  └─ No → Check latency
     ├─ p95 > 1s → DB or network slow; go to DB Dashboard
     ├─ p99 >> p95 → Tail latency issue; review slow query logs
     └─ OK → Likely transient; monitor for patterns
```

**Runbook Links**:
- [high-error-rate.md](../docs/runbooks/high-error-rate.md)
- [database-issues.md](../docs/runbooks/database-issues.md)

---

### 3. Aggregator On-Call Dashboard
**When to Use**: Price feeds stale or oracle sources failing

**Key Panels**:

#### Top Row (Status Cards):
- **Aggregator Service Status**: Green = polling
- **Active WS Connections**: Monitor growth (each client = 1 connection)
  - 🟢 < 5,000: Normal
  - 🟡 5,000–10,000: High load
  - 🔴 > 10,000: Approaching limit; consider scaling
- **Max On-Chain Staleness**: Highest staleness across any asset
  - 🟢 < 120s: OK
  - 🟡 120–300s: Alert; submissions may be failing
  - 🔴 > 300s: Critical; on-call check contract dashboard

#### Main Panels:
1. **Oracle Source Uptime %**: Per-source health
   - Green (> 95%): Healthy
   - Yellow (85–95%): Degraded; monitor closely
   - Red (< 85%): Circuit breaker likely open; see next panel
2. **Oracle Source Latency (p95)**: Response time per source
   - Target: < 2s
   - > 5s = source or network issue; check source status page
3. **SLA Breaches (last 10m)**: Any breach = source latency exceeded threshold
   - If > 0: Monitor aggregation; may drop unreliable sources
4. **API Budget Utilization**: Cumulative cost per source
   - 🟢 < 80%: OK
   - 🟡 80–95%: Monitor; may run out before end of month
   - 🔴 > 95%: Critical; need to reduce poll frequency or reduce assets
5. **On-Chain Price Staleness by Asset**: Per-asset staleness on Soroban
   - Diagnose which asset(s) are stuck
6. **WebSocket Connection Activity**: Active vs new connections per min
   - Trend shows adoption; sudden drop = client disconnect event

**Diagnosis Flowchart**:
```
On-Chain Staleness > 300s?
  ├─ Yes, Aggregator Status = UP?
  │   ├─ Yes, Source Uptime > 85% for all?
  │   │   ├─ Yes → Contract submission issue; go to Contract Dashboard
  │   │   └─ No → Source down; trigger [oracle-source-down.md](../docs/runbooks/oracle-source-down.md)
  │   └─ No → Aggregator crashed; restart [Runbook](../docs/runbooks/price-feed-stale.md)
  └─ No, check SLA Breaches
     ├─ > 0 → Sources slow but aggregating; monitor for trend
     └─ 0 → Check API Budget
        ├─ > 95% → May need to reduce polling; page lead
        └─ OK → System healthy
```

**Runbook Links**:
- [price-feed-stale.md](../docs/runbooks/price-feed-stale.md)
- [oracle-source-down.md](../docs/runbooks/oracle-source-down.md)

---

### 4. Database On-Call Dashboard
**When to Use**: API or Aggregator errors point to DB; performance degradation

**Key Panels**:

#### Top Row (Status Cards):
- **Database Status**: Green = accepting connections
- **Connection Pool Saturation**: (in-use / max) * 100
  - 🟢 < 75%: Healthy
  - 🟡 75–90%: High load; scale or optimize
  - 🔴 > 90%: Critical; new connections will wait or fail
- **Query Error Rate**: Target < 0.1%
  - > 1% = serious issue; check logs

#### Main Panels:
1. **Connection Pool Status**: Stacked area showing idle/in-use/waiting
   - Waiting > 0 = connection starvation; first sign of saturation
   - In-use slowly climbing = normal; sudden spike = query backlog
2. **Query Latency Percentiles (p50/p95/p99)**: Target p95 < 50ms
   - > 100ms = slow queries; review slow query log
3. **Query Latency by Operation**: Separate INSERT/SELECT/UPDATE
   - Identify which operation is slow
   - Example: UPDATEs slow = possible locking
4. **Replica Replication Lag**: Per-replica lag
   - Target < 1s
   - > 5s = read consistency risk; use primary for critical reads
5. **Query Errors by Operation**: Track which operations are failing
6. **Replica Health Status**: 1 = healthy, 0 = unhealthy
   - 0 = failover needed; page DBA

**Diagnosis Flowchart**:
```
Error Rate > 1%?
  ├─ Yes → Check Query Errors by Operation
  │   ├─ INSERT errors → Check disk space, storage issue
  │   ├─ Connection errors → Check Connection Pool Saturation
  │   │   ├─ > 90% → Scale pool size or kill long-running queries
  │   │   └─ < 90% but high pool usage → Slow queries; check Latency panels
  │   └─ Other → Check logs for error reason
  └─ No → Check Latency
     ├─ p95 > 50ms → Slow queries; identify via slow query log
     ├─ Query errors > 0 → Transaction rollbacks; check for deadlocks
     └─ Replica Lag > 5s → Replication issue; alert DBA
```

**Runbook Links**:
- [database-issues.md](../docs/runbooks/database-issues.md)

---

### 5. Smart Contract & Blockchain On-Call Dashboard
**When to Use**: On-chain prices stale or submissions failing

**Key Panels**:

#### Top Row (Status Cards):
- **Soroban RPC Status**: Green = contract reachable
- **Submission Success Rate (5m)**: Target 99%+
  - 🟢 99%+: Healthy
  - 🟡 90–99%: Some failures; investigate
  - 🔴 < 90%: Critical; submissions failing
- **Max On-Chain Staleness**: Highest staleness across all assets
  - 🟢 < 120s: OK
  - 🟡 120–300s: Submissions slow
  - 🔴 > 300s: Critical; diagnose

#### Main Panels:
1. **Price Submissions (Success vs Failure)**: Trend over time
   - Sudden drop = likely submission issue or network problem
2. **Submission Latency (p50/p95/p99)**: Time from submission to on-chain confirmation
   - Target p95 < 30s
   - > 60s = network congestion or RPC overload
3. **On-Chain Price Staleness by Asset**: Which asset(s) are stuck
   - Correlate with Submissions trend
4. **Submission Failures by Reason**: Why submissions are failing
   - Examples: Stale price, out-of-bounds, insufficient balance
5. **On-Chain Heartbeat Alerts (10m)**: Alerts when staleness exceeds threshold
   - > 0 = critical; investigate why submissions not landing
6. **Contract State Size**: Monitor for memory leaks
   - Steady growth = normal; exponential = issue

**Diagnosis Flowchart**:
```
On-Chain Staleness > 300s?
  ├─ Yes, Soroban RPC Status = UP?
  │   ├─ Yes → Check Submissions trend
  │   │   ├─ Success rate 99%+ → Submissions OK; may be on-chain issue
  │   │   │   └─ Check aggregator logs; data may not be generated
  │   │   └─ < 99% → Submission failures; check Failures by Reason
  │   │       ├─ Stale price → Network delay; normal; monitor trend
  │   │       ├─ Out of bounds → Aggregation logic issue; alert team
  │   │       └─ Insufficient balance → Refill contract; alert finance
  │   └─ No → Soroban down; check Soroban status page
  └─ No → Submissions landing OK; system healthy
```

**Runbook Links**:
- [contract-failures.md](../docs/runbooks/contract-failures.md)
- [price-anomaly.md](../docs/runbooks/price-anomaly.md)

---

## Alert Response Checklist

### 🔴 API 5xx Error Rate > 5% (P1)
1. ✅ Open **Incident Commander** dashboard
2. ✅ Check **API On-Call Dashboard** → HTTP Status Distribution
3. ✅ Identify affected endpoints
4. ✅ Check **Database On-Call Dashboard** for connection pool saturation
5. ✅ If connection pool OK, check API logs for errors
6. ✅ If DB pool > 90%, scale connections or restart pods
7. ✅ If still failing, restart API service

### 🔴 Price Feed Stale > 300s (P1)
1. ✅ Open **Incident Commander** dashboard
2. ✅ Check **Aggregator On-Call Dashboard** → Service Status
3. ✅ If aggregator DOWN → restart it
4. ✅ If UP, check **Oracle Source Uptime %**
   - If < 85%: Follow [oracle-source-down.md](../docs/runbooks/oracle-source-down.md)
5. ✅ If sources OK, check **Contract On-Call Dashboard** → Submissions
   - If success rate < 99%: Contract issue
   - If success rate 99%+: Check contract logs
6. ✅ Follow [price-feed-stale.md](../docs/runbooks/price-feed-stale.md)

### 🔴 Database Connection Pool Saturation > 90% (P1)
1. ✅ Open **Incident Commander** → drill to **Database On-Call**
2. ✅ Check **Connection Pool Status** graph
   - Growing = app demand increasing
   - Flat but high = slow queries blocking connections
3. ✅ If slow queries: Identify via slow query log; optimize or kill
4. ✅ If demand high: Scale pool size (increase `DB_POOL_MAX` env var)
5. ✅ Restart API/Aggregator to reconnect with new pool size

### 🟡 Oracle Source SLA Breach (P2)
1. ✅ Open **Aggregator On-Call Dashboard**
2. ✅ Check **SLA Breaches (last 10m)**
3. ✅ Identify which source(s) exceed latency threshold
4. ✅ Monitor trend; if persistent, may need to reduce polling frequency
5. ✅ No immediate action needed if uptime > 85%

---

## Golden Signal Quick Reference

| Service | Metric | Target | Yellow | Red |
|---------|--------|--------|--------|-----|
| **API** | 5xx error rate | < 1% | 1–5% | > 5% |
| **API** | p95 latency | < 500ms | 500–1000ms | > 1000ms |
| **API** | Cache hit ratio | > 80% | 50–80% | < 50% |
| **API** | DB pool saturation | < 75% | 75–90% | > 90% |
| **Aggregator** | Oracle uptime | > 95% | 85–95% | < 85% |
| **Aggregator** | Oracle SLA breach | 0 | > 0 | - |
| **Aggregator** | On-chain staleness | < 120s | 120–300s | > 300s |
| **Aggregator** | WS connections | < 5K | 5K–10K | > 10K |
| **Database** | Query error rate | < 0.1% | 0.1–1% | > 1% |
| **Database** | Query p95 latency | < 50ms | 50–100ms | > 100ms |
| **Database** | Connection saturation | < 75% | 75–90% | > 90% |
| **Database** | Replica lag | < 1s | 1–5s | > 5s |
| **Contract** | Submission success rate | > 99% | 90–99% | < 90% |
| **Contract** | Submission p95 latency | < 30s | 30–60s | > 60s |
| **Contract** | On-chain staleness | < 120s | 120–300s | > 300s |

---

## Best Practices

### ✅ Do:
- **Bookmark all 5 dashboards** for quick access during incidents
- **Review dashboards daily** during first week of on-call rotation
- **Set phone lock screen reminder** with Incident Commander URL
- **Correlate metrics** across dashboards (e.g., API errors + DB latency)
- **Update runbooks** if you discover new diagnosis steps
- **Document post-mortems** linking to dashboard screenshots

### ❌ Don't:
- **Ignore yellow metrics**; they often precede red
- **Make assumptions** without checking dashboards (e.g., "must be the API" → verify)
- **Wait for all metrics to turn red**; act on trends
- **Forget to scroll** dashboard panels (most have history on the graph)
- **Panic on one-off spikes**; look for sustained elevation (5+ min)

---

## Dashboard Maintenance & Updates

### Weekly
- Review alert thresholds against actual incident triggers
- Document new error patterns observed
- Update runbook links if any change

### Monthly
- Team review: discuss recent incidents and dashboard improvements
- Adjust time range defaults based on typical incident duration
- Archive old alerts and post-mortems

### Before Deploying Changes
- Test dashboards in staging environment
- Verify all metrics queries return data
- Confirm link to runbooks still valid

---

## Support & Questions

- **Dashboard Issues**: File issue in repo with screenshot
- **Metric Missing**: Check if service is exporting it; update metrics.ts if needed
- **Alert Too Noisy**: Adjust threshold; document reason for change
- **On-Call Questions**: Slack #incidents or page lead

---

## Quick Links

- [Golden Signals Definition](../docs/GOLDEN_SIGNALS.md)
- [Runbooks Directory](../docs/runbooks/)
- [Metrics Reference](../docs/runbooks/README.md)
- [Grafana Docs](https://grafana.com/docs/)
