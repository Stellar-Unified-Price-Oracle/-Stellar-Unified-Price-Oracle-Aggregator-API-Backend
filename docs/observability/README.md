# Observability

Operational visibility for the Stellar Unified Price Oracle.

| Doc | Issue | Summary |
|-----|-------|---------|
| [METRICS_CARDINALITY.md](./METRICS_CARDINALITY.md) | #414 | Cardinality audit of existing metrics, scrape/TSDB limits and alerts, and label conventions for future instrumentation. Alerts: `k8s/base/prometheus-cardinality-rules.yaml` |
| [SYNTHETIC_MONITORING.md](./SYNTHETIC_MONITORING.md) | #415 | Black-box probes hitting `/prices`, `/history`, `/health` and a WebSocket subscribe from outside the cluster, with alerting independent of internal signals. Manifests: `k8s/base/synthetic-probes.yaml`; external runner: `monitoring/synthetic/probe.mjs` |
| [STATUS_PAGE.md](./STATUS_PAGE.md) | #416 | Public status page backed by the synthetic probes and SLOs, incident/post-mortem publishing, and a versioned status API for consumers |
| [ONCHAIN_EVENT_MONITORING.md](./ONCHAIN_EVENT_MONITORING.md) | #417 | Streaming oracle contract events into the observability stack, alerting on submission gaps / governance / upgrades, and correlating with aggregator and DB state. Alerts: `k8s/base/onchain-events-prometheus-rules.yaml` |
