# API Canary Imbalance

Severity: warning

Purpose: Steps to investigate and correct an unexpected canary/stable traffic split.

Immediate steps:

- Verify the expected 90/10 split in the Istio VirtualService configuration for `api.stellar-oracle`.
- Inspect metrics for the stable and canary pods to confirm traffic proportions.
- Check canary deployment health, readiness/liveness probes, and recent rollout events: `kubectl rollout status`.

Mitigations:

- If canary is unhealthy, pause or rollback the canary deployment.
- Manually adjust VirtualService weights to restore desired split while investigating.

Post-incident:

- Add stronger automated checks in CI for canary deployments and update the runbook with common failure modes.
