# Runbook: Price Feed Stale

**Linked alerts:** `PriceFeedStale`
**Severity:** P1

## Symptoms

- `PriceFeedStale` alert fires for one or more assets
- `last_price_timestamp_seconds` gauge is >120 seconds behind `time()`
- `/api/v1/prices` returns entries with `stale: true`

## Diagnosis

```bash
# 1. Check which assets are stale
curl https://<api-host>/api/v1/prices | jq '.data.prices[] | select(.stale == true) | .asset'

# 2. Check Prometheus staleness metric
# In Grafana: time() - stellar_oracle_price_timestamp > 120

# 3. Check aggregator poll logs
kubectl logs -l app=stellar-aggregator --tail=200 | grep -E "Poll cycle|Aggregated"

# 4. Confirm polling interval
kubectl exec -it deploy/stellar-aggregator -- env | grep POLLING_INTERVAL_MS
```

## Mitigation

1. If the aggregator is alive but not polling, check for a blocked event loop:
   ```bash
   kubectl top pod -l app=stellar-aggregator
   ```
2. If CPU or memory is saturated, scale up or reduce `POLLING_INTERVAL_MS`.
3. If the aggregator pod is crash-looping, collect logs and restart:
   ```bash
   kubectl logs deploy/stellar-aggregator --previous | tail -50
   kubectl rollout restart deployment/stellar-aggregator
   ```
4. If sources are returning data but prices are stale in the API, check the API's price-store service and file/database connectivity.

## Recovery Verification

```bash
curl https://<api-host>/api/v1/prices | jq '.data.prices[] | {asset, stale, timestamp}'
# All stale values should be false within one polling cycle
```
