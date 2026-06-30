# Central Log Aggregation (Loki + Grafana)

Ships logs from all Stellar Oracle services into a searchable central store,
instead of leaving them scattered across local files/stdout on each instance.

## Components

- **Loki** (`loki-config.yml`) — log storage and indexing, with a 30-day
  default retention policy enforced by the compactor.
- **Promtail** (`promtail-config.yml`) — tails the JSON log files written by
  `services/aggregator/src/utils/logger.ts` (and the API's equivalent logger)
  plus all `stellar-oracle-*` container stdout via the Docker socket, and
  ships them to Loki.
- **Grafana** (`grafana-provisioning/`) — pre-provisioned with Loki as a
  datasource and a "Log Search" dashboard (`Logs` folder) with live tail,
  error-rate, and errors-only panels.
- **Loki ruler alerts** (`loki-alert-rules.yml`) — fires on elevated error
  log rates or a complete stop in log shipping (likely pipeline failure).

## Running

```bash
docker compose -f docker-compose.yml -f monitoring/logging/docker-compose.logging.yml up -d
```

Grafana is available at `http://localhost:3300` (separate port from the
metrics Grafana instance defined in `monitoring/grafana-dashboard.json`, to
avoid clashing if both stacks run side by side).

## Retention

Default retention is 30 days for all log streams (`retention_period: 720h`
in `loki-config.yml`). Adjust per-tenant overrides in `limits_config` if a
longer retention window is needed for specific services.
