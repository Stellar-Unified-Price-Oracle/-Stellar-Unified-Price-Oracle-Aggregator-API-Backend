# Infrastructure Cost Optimization Report

This report is generated from `config/cost-model.json` by `npm run cost:analyze`.
It models Kubernetes requested capacity, which is the controllable cost driver in
the repository. Replace the documented rates with the cluster provider's effective
rates when reconciling this forecast against an invoice.

## Executive summary

| Metric | Baseline | Optimized | Reduction |
| --- | ---: | ---: | ---: |
| Requested CPU | 0.950 vCPU | 0.625 vCPU | 34.2% |
| Requested memory | 2.250 GiB | 1.438 GiB | 36.1% |
| Modeled monthly run rate | $37.65 | $25.20 | 33.1% |

The production overlay keeps all 8 replicas and the 10 GiB database volume. Right-sizing saves a modeled
$12.46 per month (33.1%), exceeding the issue's 20% target
without reducing redundancy.

## Cost allocation and recommendations

| Service | Owning team | Replicas | CPU request/replica | Memory request/replica (GiB) | Baseline/month | Optimized/month | Reduction |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| api | platform | 4 | 0.05 | 0.125 | $15.33 | $7.67 | 50.0% |
| aggregator | oracle | 3 | 0.075 | 0.1875 | $11.50 | $8.62 | 25.0% |
| timescaledb | data | 1 | 0.2 | 0.375 | $10.82 | $8.91 | 17.7% |

Production pods and the namespace carry `cost.stellar.org/service`,
`cost.stellar.org/team`, and `cost.stellar.org/environment` labels. These labels
support invoice allocation and Prometheus grouping by service and team.

Implemented recommendations:

- API requests: 100m/256Mi to 50m/128Mi per replica.
- Aggregator requests: 100m/256Mi to 75m/192Mi per replica.
- TimescaleDB requests: 250m/512Mi to 200m/384Mi.
- Limits remain above requests to absorb bursts; probes and replica counts are unchanged.
- A namespace ResourceQuota caps accidental capacity growth.
- Budget alerts evaluate the Kubernetes requested-capacity monthly run rate.

## Budget and alerts

The configured production budget is $30.00 per month.
`StellarOracleCostBudgetWarning` fires at $24.00
(80%), and `StellarOracleCostBudgetExceeded` fires at
$30.00 (100%).

The alert expression uses kube-state-metrics request and PVC metrics. Alert routing
must send labels `team=platform` and `cost_center=stellar-oracle` to the
organization's notification receiver. Rates and thresholds live in both the
cost-model source and the production monitoring manifest so changes are reviewable.
The `stellar_oracle:requested_monthly_cost_usd_by_service_team` recording rule
exposes the same model grouped by the pod allocation labels for dashboards and
chargeback reports.

## Assumptions and verification

- 730 hours per month.
- CPU: $0.04 per vCPU-hour.
- Memory: $0.005 per GiB-hour.
- Persistent storage: $0.17 per GiB-month.
- Network egress and control-plane fees are reconciled as inferred categories with stated error bands.
- Validate the recommendation for at least seven days. CPU p95 should remain below
  70% of requests, memory p95 below 80%, and throttling/error SLOs unchanged.
- If those thresholds are exceeded, raise the affected request independently and
  regenerate this report rather than reducing replicas.

## Reconciling Modeled Cost against Real Cloud Billing (#555)

The modeled requested capacity (`config/cost-model.json`) is reconciled monthly against actual cloud provider invoices (`config/cost-invoices.json`) via `npm run cost:reconcile`.

### 1. Attributable vs. Non-Attributable / Inferred Categories

Cloud billing aggregates disparate infrastructure charges. Attribution is structured at two levels:

1. **Directly Attributable Categories:**
   - **Compute (vCPU):** Directly derived from Kubernetes pod requests and node instance pricing ($0.04/vCPU-hr).
   - **Memory (RAM):** Directly derived from container memory requests ($0.005/GiB-hr).
   - **Persistent Storage:** Directly mapped from TimescaleDB PersistentVolumeClaims ($0.17/GiB-mo).
   - **Oracle API Calls:** Quota-tracked calls against oracle provider contracts (`chainlink`, `redstone`, `band`, `reflector`).
2. **Inferred Categories with Stated Error Bands:**
   Where costs cannot be attributed to a specific pod directly from cloud invoices alone, inferred unit costs carry explicit error bands:
   - **Network Egress:** $0.09/GiB with $\pm 18\%$ error band (sampled from VPC flow logs and cross-AZ transit).
   - **Shared K8s Control Plane:** $73.00/month with $\pm 12\%$ error band (allocated proportionally across namespace pod count).
   - **Disk IOPS Burst:** Baseline IOPS included; burst charges carrying $\pm 15\%$ error band.

### 2. Variance Thresholds & Drift vs. Legitimate Changes

Thresholds defined in `config/cost-model.json`:
- **Total Monthly Variance:** $15.0\%$
- **Per-Service Variance:** $20.0\%$
- **Inferred Category Variance:** $30.0\%$
- **Runtime Call Cost Tolerance:** $10.0\%$

**Distinguishing Drift from Legitimate Changes:**
- If variance exceeds a threshold, `reconcile-cost-invoices.mjs` checks `config/cost-model.json`'s `changelog` array.
- If an intentional infrastructure change (such as database storage expansion or node pool type upgrade) was recorded with author and rationale, the discrepancy is classified as an **Authorized Change** and passes.
- If variance exceeds the threshold without a corresponding changelog entry, the check halts CI with **Unacknowledged Cost Drift**.

### 3. Runtime Budget Controls Verification

The aggregator's runtime scheduling relies on `oracleApiBudgetUtilization` (`services/aggregator/src/infrastructure/cost-model.ts`).
- `verifyRuntimeCostModelIntegrity()` validates that runtime rates (`COST_PER_1K_CALLS`) and daily budgets (`DAILY_BUDGET_CALLS`) are within $10\%$ tolerance of `config/cost-model.json`.
- Discrepancies fire the `oracle_cost_model_drift_percent` gauge and increment `oracle_cost_model_drift_alerts_total`.

### 4. Model Update Process and Evidence

To update the cost model:
1. Collect at least 30 days of AWS/GCP Cost & Usage Reports (CUR) and OpenCost allocation data.
2. Calculate empirical per-unit rates and verify whether variances stem from rate changes or consumption shifts.
3. Append a structured entry to `changelog` in `config/cost-model.json` with date, author, description, and justification.
4. Run `npm run cost:reconcile -- --check` to verify the updated model against recent provider invoices.

