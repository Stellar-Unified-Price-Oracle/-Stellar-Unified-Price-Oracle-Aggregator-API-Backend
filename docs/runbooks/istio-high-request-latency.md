# Istio High Request Latency

Severity: warning

Purpose: Investigate elevated p99 latency in Istio for Stellar Oracle services.

Immediate steps:

- Identify affected service from alert (`{{ $labels.destination_service }}`).
- Check pod/sidecar CPU and memory: `kubectl top pods -n <ns>`.
- Inspect Istio proxies for resource saturation and logs: `kubectl logs -l app=<service> -c istio-proxy`.
- Check recent deployments or config changes to the destination service.

Mitigations:

- Restart the affected pods to clear transient issues.
- If high latency persists, route traffic away from the service (adjust Istio virtualservice) or scale replicas.

Post-incident:

- Collect traces and metrics for root cause analysis and update runbook with remediation steps.
