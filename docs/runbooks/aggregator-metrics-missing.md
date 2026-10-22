**Owner:** Platform Operations
**Review date:** 2026-10-21

# Aggregator Metrics Missing

Firing alerts: `AggregatorMetricsTargetDown`, `AggregatorMetricsAbsent`
(`k8s/base/prometheus-rule.yaml`).

Both mean Prometheus is getting **no aggregator samples**: either the scrape
target is down (`up == 0`) or no target matches `job ~ ".*aggregator.*"` at
all. A wrong scrape port historically looked like healthy silence — these
alerts exist so it cannot (issue #590).

## Port model

The aggregator binds **only** `PORT + 1` (WebSocket, 4001) and `PORT + 2`
(`/health` + `/metrics` on one HTTP listener, 4002). Nothing listens on `PORT`
(4000) itself. The Service port `http-metrics` maps 4002 → the health listener;
`AGGREGATOR_URL` in the configmaps points at `:4002`.

## Diagnosis

1. Does the process expose metrics?
   ```bash
   kubectl -n <ns> port-forward svc/aggregator 4002:4002 &
   curl -fsS localhost:4002/metrics | head
   ```
   If the curl fails, check the pod logs for
   `Resolved ports: ws=… health+metrics=…` — the startup log states the ports
   the process actually bound.
2. Do endpoints exist?
   ```bash
   kubectl -n <ns> get endpoints aggregator
   ```
   The 4000 port must not appear; 4001 and 4002 must.
3. Is the ServiceMonitor applied and selected?
   ```bash
   kubectl -n <ns> get servicemonitor aggregator -o yaml
   kubectl -n <ns> get svc aggregator -o jsonpath='{.metadata.labels}'
   ```
   The Service needs label `app: aggregator` (jobLabel). The ServiceMonitor is
   not part of `kustomize build` — apply it manually:
   ```bash
   kubectl apply -f k8s/base/aggregator/service-monitor.yaml
   kubectl apply -f k8s/base/prometheus-rule.yaml
   ```
4. Prometheus config: target should be Service port **`http-metrics` (4002)**,
   path `/metrics`. Any config still scraping `4000` scrapes nothing.

## Resolution checklist

- [ ] `curl localhost:4002/metrics` returns the Prometheus registry
- [ ] `kubectl get endpoints aggregator` shows 4001 + 4002, never 4000
- [ ] ServiceMonitor exists in the aggregator namespace and is selected
- [ ] Prometheus target for the aggregator is green; `up{job=~".*aggregator.*"}` is 1
- [ ] Re-run `node scripts/check-port-consistency.mjs` if manifests changed
