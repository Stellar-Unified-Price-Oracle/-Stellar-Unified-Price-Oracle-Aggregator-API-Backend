# Runbook: High API Error Rate

**Linked alerts:** `HighErrorRate`, `APILatencyHigh`
**Severity:** P1

## Symptoms

- `HighErrorRate` alert fires (5xx rate >5% over 5 minutes)
- `APILatencyHigh` fires (p95 >1s)
- Consumers reporting errors or timeouts

## Diagnosis

```bash
# 1. Check current error rate
# Prometheus: rate(stellar_api_requests_total{status=~"5.."}[5m]) / rate(stellar_api_requests_total[5m])

# 2. Check API logs for error patterns
kubectl logs -l app=stellar-api --tail=200 | grep -E "ERROR|500|503"

# 3. Check which endpoints are erroring
# Prometheus: stellar_oracle_api_calls_total{status=~"5.."}

# 4. Check memory and CPU
kubectl top pod -l app=stellar-api

# 5. Check database connectivity
curl https://<api-host>/api/v1/health | jq '.data'
```

## Mitigation

1. If OOM: increase memory limit or restart pod to clear heap.
2. If DB errors: see [database-issues.md](database-issues.md).
3. If specific endpoint erroring: check route handler logs for stack traces.
4. If pod is crash-looping: collect logs, then force a restart:
   ```bash
   kubectl rollout restart deployment/stellar-api
   ```

## Recovery Verification

```bash
# Verify error rate drops below threshold
curl https://<api-host>/api/v1/health | jq '.data.status'
# Expected: "healthy"
```
