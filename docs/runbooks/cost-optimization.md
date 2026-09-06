# Cost Optimization Alert — Stellar Oracle

Severity: warning / critical

Purpose: Steps to investigate and remediate high projected monthly cost for stellar-oracle.

Immediate steps:

- Check recent changes to deployments or resource requests in `stellar-oracle-prod` namespace.
- Inspect `kubectl get pods -n stellar-oracle-prod -o wide` and `kubectl top pods -n stellar-oracle-prod`.
- Review increasing CPU/memory requests in the last deploys: examine `kubectl describe deployment` and the CI/CD deploy logs.

Mitigations:

- Roll back the offending deployment if a config change increased resource requests.
- Scale down non-critical workloads or replica counts temporarily.
- Apply resource request/limit fixes and redeploy.

Post-incident:

- Record root cause and follow up with a pull request to fix default resource requests.
- Consider automated budget enforcement via cost alerts and automated scaling.
