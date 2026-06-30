# Grafana Dashboards

Import these into Grafana (Dashboards → Import → Upload JSON) against a Prometheus
datasource scraping the API and Aggregator `/metrics` endpoints.

| File | Purpose |
| --- | --- |
| `api.json` | API service: request rate, latency (p95), 5xx error rate, DB pool, cache hit ratio, query errors |
| `aggregator.json` | Aggregator service: source success/failure rate, source health, circuit breaker state, aggregated price per asset |
| `contract.json` | Soroban contract: failed contract calls by method, 24h failure total |
| `price-feed-health.json` | Price feed health: staleness (time since last update), price deviation, active alerts, source health overview |
| `system-resources.json` | System resources: CPU, resident memory, Node.js heap, event loop lag, open FDs, DB replica lag |
| `business-metrics.json` | Business metrics: price queries by asset, price updates per asset (24h), active WS subscribers, archived records |

All dashboards use a templated `${DS_PROMETHEUS}` datasource variable so they work
across environments without editing the JSON.
