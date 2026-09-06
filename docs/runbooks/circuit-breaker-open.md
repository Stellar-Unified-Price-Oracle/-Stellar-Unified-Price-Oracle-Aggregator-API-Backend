# Runbook: Circuit Breaker Open

**Linked alerts:** `CircuitBreakerOpen` (if present), related to DB / source circuit breaker metrics
**Severity:** P1

## Symptoms

- `circuit_breaker_state` metric indicates open for a specific component
- Increased request errors or timeouts tied to dependency failures
- Logs show retries and backoff behavior in dependent service

## Diagnosis

1. Identify which circuit breaker is open (labels usually include `component` or `source`).

2. Inspect the dependent service logs (DB, upstream oracle source, or Soroban RPC) to determine root cause.

```bash
kubectl logs -l app=stellar-api --tail=200 | grep -i "circuit\|breaker\|timeout"
kubectl logs -l app=stellar-aggregator --tail=200 | grep -i "circuit\|breaker\|timeout"
```

## Mitigation

### If circuit breaker opened due to transient upstream outage

1. Confirm upstream is healthy (DB console, RPC provider status).
2. If upstream is healthy and circuit breaker remains open, allow the cooldown period for the breaker to close automatically.
3. If business-critical, consider restarting the impacted pod to reset in-process breakers and monitor for recurrence.

### If circuit breaker opened due to configuration or capacity

1. Fix the underlying capacity/config issue (e.g., DB scaling, connection limits), then restart services as needed.
2. If a code-level change caused incorrect error classification, revert the recent deployment.

## Recovery Verification

- Prometheus: ensure `circuit_breaker_state` for the component returns to closed (value 0)
- API health checks return `healthy` and error rates drop below alert threshold

## Related runbooks

- [database-issues.md](database-issues.md)
- [contract-failures.md](contract-failures.md)
