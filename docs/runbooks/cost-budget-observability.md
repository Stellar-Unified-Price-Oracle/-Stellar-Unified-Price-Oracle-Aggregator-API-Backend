# Cost & budget observability

Issue #418. Keeps infrastructure cost continuously visible against the monthly
budget so cost discipline survives launch.

## Sources of truth

| Concern | File |
| --- | --- |
| Requested-capacity cost model (per service + owning team) | `config/cost-model.json` |
| Recording rules + budget alerts | `k8s/cost-optimization/prometheus-rule.yaml` |
| Namespace guardrail (ResourceQuota) | `k8s/cost-optimization/budget.yaml` |
| Grafana dashboard | `docs/dashboards/cost-budget.json` |
| Alertmanager routing | `monitoring/alertmanager-cost-routes.yaml` |
| Recorded monthly invoices | `config/cost-invoices.json` |

## 1. Visualize the cost model per service and team

`docs/dashboards/cost-budget.json` renders:

- **Requested monthly cost (total)** — `stellar_oracle:requested_monthly_cost_usd`,
  with static warning ($24 = 80%) and exceeded ($30 = 100%) threshold lines.
- **Requested monthly cost by service / team** —
  `stellar_oracle:requested_monthly_cost_usd_by_service_team`, grouped by the
  `cost.stellar.org/service` and `cost.stellar.org/team` pod labels, so each
  team sees its own run rate and chargeback share.
- **Budget utilization %**, **Active cost alerts**, and **Modeled vs invoiced
  variance %** (from the reconciliation step below).

The recording rules already exist in production; this issue adds the dashboard
that consumes them. The modeled numbers can be regenerated any time with
`npm run cost:analyze` and are verified in CI by `npm run cost:check`.

## 2. Confirm budget warning / exceeded alerts route correctly

Alerts and their labels (defined in `k8s/cost-optimization/prometheus-rule.yaml`):

| Alert | Fires at | Labels |
| --- | --- | --- |
| `StellarOracleCostBudgetWarning` | run rate > $24 for 30m | `severity=warning, team=platform, cost_center=stellar-oracle` |
| `StellarOracleCostBudgetExceeded` | run rate > $30 for 15m | `severity=critical, team=platform, cost_center=stellar-oracle` |

Merge `monitoring/alertmanager-cost-routes.yaml` into the org Alertmanager
config, then prove routing without waiting for a breach:

```sh
amtool config routes test --config.file=alertmanager.yml \
  alertname=StellarOracleCostBudgetWarning severity=warning team=platform cost_center=stellar-oracle
# expect: cost-budget-warning  (Slack #stellar-oracle-cost)

amtool config routes test --config.file=alertmanager.yml \
  alertname=StellarOracleCostBudgetExceeded severity=critical team=platform cost_center=stellar-oracle
# expect: cost-budget-exceeded  (Slack + PagerDuty)
```

For an end-to-end check, temporarily lower the warning threshold in a staging
`PrometheusRule` (e.g. `> 1`), confirm the notification lands in
`#stellar-oracle-cost`, then revert.

## 3. Reconcile the model with actual invoices monthly

On the first business day of each month:

1. Pull the previous month's provider invoice and split it per service using the
   `cost.stellar.org/service` allocation labels (or the provider's own tags).
2. Append an entry to `config/cost-invoices.json` (`month`, `invoicedTotal`,
   `byService`, `reconciledBy`, `notes`).
3. Run `npm run cost:reconcile` and review per-service variance. `--check` exits
   non-zero when the latest variance exceeds `COST_VARIANCE_TOLERANCE_PCT`
   (default 15%).
4. If variance is out of tolerance, update `config/cost-model.json` rates to the
   provider's effective rates, run `npm run cost:analyze`, and open a PR so the
   change is reviewable. Feed
   `stellar_oracle:cost_invoice_variance_percent` from the recorded variance so
   the dashboard panel reflects reality.
