# Runbook: Synthetic Monitoring Failures

**Linked alerts:** `SyntheticProbeFailed`, `SyntheticProbeLatencyHigh`, `SyntheticProbeTLSExpiringSoon`, `SyntheticProbeMultiRegionDown`
**Severity:** P0 / P1 (see per-alert severity)

## Symptoms

- `probe_success == 0` from one or more external vantage points
- Probe duration exceeds the 2 s SLO
- TLS certificate expires within 21 days
- The same endpoint fails from 2+ vantage points (confirmed customer-facing outage)

## Diagnosis

1. Confirm the failing target, module, and vantage point:

```promql
probe_success{probe_target=~".+"}
probe_duration_seconds
probe_ssl_earliest_cert_expiry - time()
```

2. Reproduce the request from outside the cluster (DNS, TLS, ingress, CDN, routing).
3. Compare with internal health checks to isolate an external-path issue from an application one.

## Mitigation

1. Single vantage point failing → investigate that region's network path first.
2. Multiple vantage points failing → treat as a confirmed outage; page and follow [high-error-rate.md](high-error-rate.md).
3. Certificate expiring → renew and redeploy the ingress certificate.
4. Latency above SLO → check upstream oracle sources and Istio latency panels.

## Recovery Verification

- `probe_success == 1` from all configured vantage points
- Probe latency back under the 2 s SLO
- Earliest certificate expiry comfortably beyond 21 days

## Related runbooks

- [high-error-rate.md](high-error-rate.md)
- [istio-high-request-latency.md](istio-high-request-latency.md)
