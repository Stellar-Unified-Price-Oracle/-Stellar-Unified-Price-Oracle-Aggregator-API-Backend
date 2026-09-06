# Runbook: DR Drill — Regional Failover

**Linked workflow:** `.github/workflows/dr-drill.yml`
**Schedule:** Weekly, Sundays at 02:00 UTC
**Severity (if drill fails):** P1

## Purpose

Validate that the active-active multi-region topology (us-east-1, eu-west-1, ap-southeast-1) recovers correctly when one region loses network connectivity. The drill tests three properties:

1. The two surviving regions continue to serve traffic within the failover window.
2. The system returns a healthy state after the partition is healed (CRDT LWW convergence).
3. The 50% regional traffic-loss load scenario remains within SLO thresholds.

## Prerequisites

- `CHAOS_TARGET_ENV` must be `staging` — the safety guard in `scripts/dr-drill.sh` aborts otherwise.
- Chaos Mesh installed in the target cluster (`k8s/chaos/install/`).
- Repository variables `REGION_US_HEALTH`, `REGION_EU_HEALTH`, `REGION_AP_HEALTH`, `REGION_US_PRICES`, `REGION_EU_PRICES`, `REGION_AP_PRICES` set to the health and prices endpoint URLs for each region.
- k6 available in CI (installed by `grafana/setup-k6-action@v1`).

## Running the drill

### Automated (weekly)

The workflow triggers automatically via `cron: '0 2 * * 0'`. No action required.

### Manual trigger

1. Navigate to **Actions → DR Drill → Run workflow** in GitHub.
2. Optionally set `target_region` (default: `us-east-1`) and `convergence_timeout` (default: 120s).
3. Click **Run workflow**.

### Local execution

```bash
export CHAOS_TARGET_ENV=staging
export TARGET_REGION=us-east-1
export REGION_US_HEALTH=http://us-east-1.oracle.example/api/v1/health
export REGION_EU_HEALTH=http://eu-west-1.oracle.example/api/v1/health
export REGION_AP_HEALTH=http://ap-southeast-1.oracle.example/api/v1/health
export REGION_US_PRICES=http://us-east-1.oracle.example/api/v1/prices
export REGION_EU_PRICES=http://eu-west-1.oracle.example/api/v1/prices
export REGION_AP_PRICES=http://ap-southeast-1.oracle.example/api/v1/prices
chmod +x scripts/dr-drill.sh
./scripts/dr-drill.sh
```

## Drill phases

| Phase | What happens |
|-------|-------------|
| 1 — Apply partition | `regional-partition.yaml` is applied to Chaos Mesh, cutting network traffic from the target region to the other two regions. |
| 2 — Verify surviving regions | The script polls `/api/v1/health` on the two non-partitioned regions every 5s until they return HTTP 200, or until `DRILL_TIMEOUT` (default 300s) expires. |
| 3 — Remove partition | The Chaos Mesh experiment is deleted, restoring network connectivity. |
| 4 — Verify CRDT convergence | After `CONVERGENCE_TIMEOUT` (default 120s), `/api/v1/prices` is fetched from both surviving regions and compared. Matching asset/price sets indicate convergence. |
| 5 — Load test | `load-tests/k6/regional-traffic-loss.js` runs a 3-minute scenario: 30s at full capacity, 2m with 50% of requests directed to a single region, 30s recovery. |

## Success criteria

| Criterion | Target |
|-----------|--------|
| Both surviving regions serve HTTP 200 on `/health` | Within 120s of partition |
| TTR (time to first healthy response from surviving region) | < 120s |
| CRDT convergence: price snapshots match across regions | Within `CONVERGENCE_TIMEOUT` after heal |
| Load test `p(95)` latency during 50% traffic loss | < 1000ms |
| Load test error rate during 50% traffic loss | < 10% |

## Interpreting results

**PASS:** All checks in `scripts/dr-drill.sh` report `PASS` and the load test k6 thresholds are met. The generated report in `docs/chaos-engineering/reports/` will show all criteria as ✅.

**FAIL — surviving region not responding:** The load balancer is not routing away from the partitioned region fast enough. Check `failoverWindowMs` in `k8s/base/multi-region/failover-policy.yaml` and the health-check interval on the global load balancer.

**FAIL — CRDT convergence:** Prices on surviving regions diverged or could not be fetched after the heal window. Check the replication topic (`REGION_REPLICATION_TOPIC`) and consumer lag. See `docs/active-active-multi-region.md` — drift beyond `REGION_MAX_REPLICATION_LAG_MS` may also trigger quarantine.

**FAIL — load test thresholds:** Under 50% traffic loss the surviving regions are overloaded. Review HPA configuration (`k8s/base/api/hpa.yaml`, `k8s/hpa.yaml`) and ensure burst headroom is provisioned.

## Report location

Reports are uploaded as workflow artifacts (`dr-drill-report-<run_number>`) and also written to `docs/chaos-engineering/reports/` with names in the format `dr-drill-YYYYMMDD-HHMMSS.md`.

## Cleanup

The Chaos Mesh experiment (`regional-partition`) is deleted automatically in Phase 3. If the drill is interrupted before cleanup, remove it manually:

```bash
kubectl delete networkchaos regional-partition -n stellar-oracle --ignore-not-found
```

## Related

- [`docs/active-active-multi-region.md`](../active-active-multi-region.md)
- [`docs/runbooks/disaster-recovery.md`](disaster-recovery.md)
- [`k8s/chaos/experiments/regional-partition.yaml`](../../k8s/chaos/experiments/regional-partition.yaml)
- [`load-tests/k6/regional-traffic-loss.js`](../../load-tests/k6/regional-traffic-loss.js)
- [`docs/chaos-engineering/README.md`](../chaos-engineering/README.md)
