# Runbook: Oracle Source Down

**Linked alerts:** `OracleSourceDowntime`, `SourceHealthDegraded`, `NoOracleSourcesHealthy`
**Severity:** P1 (single source) / P0 (all sources)

## Symptoms

- Prometheus alert `OracleSourceDowntime` fires
- `/api/v1/health` returns `degraded` or `unhealthy`
- Aggregated prices show reduced `confidence` or `degradationLevel: critical`
- Logs show repeated `[source] Failed to fetch <asset>` messages

## Diagnosis

```bash
# 1. Check current health
curl https://<api-host>/api/v1/health?verbose=true | jq .

# 2. Check aggregator health server
curl http://<aggregator-host>:4002/health | jq .

# 3. Review recent error logs
kubectl logs -l app=stellar-aggregator --tail=100 | grep -E "ERROR|WARN|Circuit breaker"

# 4. Verify upstream source APIs directly
curl https://min-api.cryptocompare.com/data/price?fsym=XLM&tsyms=USD
curl https://api.redstone.finance/prices?symbol=XLM
```

## Mitigation

### Single source failing

1. Confirm other sources are healthy and producing prices — consumers are automatically served from remaining healthy sources.
2. Check upstream provider status pages for outages.
3. If the source is consistently failing, the circuit breaker will open automatically after 3 consecutive failures.
4. No manual action is required if ≥2 sources remain healthy.

### Multiple sources failing

1. Check network connectivity from aggregator pods.
2. Check for shared dependencies (DNS, proxy, egress IP blocks).
3. Inspect SSRF protection logs — a misconfigured allowlist can block legitimate outbound calls:
   ```bash
   grep "SSRF" /var/log/stellar-aggregator/app.log | tail -20
   ```
4. If network is fine, check if `ORACLE_ALLOWED_HOSTS` env var is up to date.

### All sources failing (P0)

1. Page on-call engineering manager immediately.
2. Check whether the aggregator process has crashed — restart if needed:
   ```bash
   kubectl rollout restart deployment/stellar-aggregator
   ```
3. Verify Soroban RPC endpoint is reachable.
4. If the issue is not resolved within 15 minutes, consider enabling the static fallback price mechanism (see `FALLBACK_PRICES` env var).

## Recovery Verification

```bash
# Confirm sources recovering
curl https://<api-host>/api/v1/health | jq '.data.status'
# Expected: "healthy"

# Confirm prices are fresh
curl https://<api-host>/api/v1/prices | jq '.data.prices[].stale'
# Expected: all false
```

## Related

- [post-mortem-template.md](post-mortem-template.md)
- [high-error-rate.md](high-error-rate.md)
