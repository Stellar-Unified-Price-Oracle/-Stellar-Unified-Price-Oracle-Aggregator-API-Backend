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
- Network egress, managed control-plane fees, taxes, and discounts are excluded.
- Validate the recommendation for at least seven days. CPU p95 should remain below
  70% of requests, memory p95 below 80%, and throttling/error SLOs unchanged.
- If those thresholds are exceeded, raise the affected request independently and
  regenerate this report rather than reducing replicas.

Run `npm run cost:check` in CI or before review to prove the committed report is
in sync with the model and still exceeds the 20% reduction target.
