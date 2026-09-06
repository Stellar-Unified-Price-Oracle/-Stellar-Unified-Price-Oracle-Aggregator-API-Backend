# Alert → Runbook Mapping

This file maps Prometheus alert names and observed failure modes to their canonical runbooks. Use this as the single source of truth when updating alerts or authoring new runbooks.

## Alerts defined in Prometheus rules

- `OracleSourceSlaBreachRateHigh` — Runbook: [oracle-source-down.md](oracle-source-down.md)
- `OracleSourceSlaBreachRateCritical` — Runbook: [oracle-source-down.md](oracle-source-down.md)
- `OracleSourceUptimeDegraded` — Runbook: [oracle-source-down.md](oracle-source-down.md)
- `StellarOracleCostBudgetWarning` — Runbook: [cost-optimization.md](cost-optimization.md)
- `StellarOracleCostBudgetExceeded` — Runbook: [cost-optimization.md](cost-optimization.md)
- `IstioHighRequestLatency` — Runbook: [istio-high-request-latency.md](istio-high-request-latency.md)
- `IstioHighErrorRate` — Runbook: [high-error-rate.md](high-error-rate.md)
- `ApiCanaryImbalance` — Runbook: [api-canary-imbalance.md](api-canary-imbalance.md)

Files containing rules: `k8s/base/prometheus-rule.yaml`, `k8s/istio/observability/prometheus.yaml`, `k8s/cost-optimization/prometheus-rule.yaml`.

## Alerts referenced by runbooks or tests but not defined in repository rules

These alert names are mentioned in documentation or tests but do not have a Prometheus rule file in this repository. They should either be reconciled to existing alert names (aliases) or have rules added.

- `OracleSourceDown` — Alias/older name. Current rule names: `OracleSourceUptimeDegraded`, `OracleSourceSlaBreachRateHigh`. Mapping: [oracle-source-down.md](oracle-source-down.md). Action: consider adding an explicit `OracleSourceDown` rule or update tests to use the canonical names.
- `StalePrices` / `PriceFeedStale` — Canonical runbook: [price-feed-stale.md](price-feed-stale.md). Action: add rule `PriceFeedStale` or update alert annotations to reference the runbook URL consistently.
- `CircuitBreakerOpen` — No dedicated runbook file; related guidance exists in [database-issues.md](database-issues.md) and [contract-failures.md](contract-failures.md). Action: created a short runbook `circuit-breaker-open.md` (see below).
- `HighAPILatency` / `APILatencyHigh` / `HighAPILatency` — Related to API latency alerts (Istio or API-specific). Runbooks: [istio-high-request-latency.md](istio-high-request-latency.md), [high-error-rate.md](high-error-rate.md). Action: reconcile naming and add an API-specific latency rule if required.
- `ContractCallFailures` — Runbook: [contract-failures.md](contract-failures.md). Confirm Prometheus rule exists in future if desired.
- `DatabaseConnectionPoolExhausted` — Runbook: [database-issues.md](database-issues.md). Action: ensure alert rule exists in monitoring repo / Prometheus ruleset.
- `PriceDeviation` — Runbook: [price-anomaly.md](price-anomaly.md). Action: add or verify alert rule in Prometheus.

## Next steps (recommended)

1. Reconcile alert name variants in tests and docs to the canonical alert names used in Prometheus rules.
2. Add missing Prometheus rules for the alerts listed above (or update runbooks to reference canonical alert names).
3. Exercise each runbook via a shadowed on-call session using the verification checklist in [runbook-verification.md](runbook-verification.md).
