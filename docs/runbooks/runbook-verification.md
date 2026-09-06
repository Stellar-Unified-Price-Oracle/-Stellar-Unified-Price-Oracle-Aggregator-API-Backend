# Runbook Verification — Shadowed On-call Checklist

Purpose: provide a concise, repeatable checklist for a shadowed on-call to validate that a runbook is executable end-to-end.

For each runbook under `docs/runbooks/` perform the following steps during a scheduled verification drill (testnet or staging environment preferred):

1. Setup
   - Confirm the shadowed on-call and the observer/mentor are present in the call.
   - Ensure access to the staging Prometheus/Grafana, Kubernetes cluster, and any test Soroban network endpoints.

2. Simulate the alert condition (non-production)
   - If metric-based, use a Prometheus `pushgateway` or test metric generator to create firing conditions, or temporarily adjust the rule evaluation in staging.
   - If event-based, reproduce the minimum observable symptom (e.g., return 5xx from a mocked source).

3. Triage using the runbook
   - The on-call should follow the runbook's Immediate steps and Diagnosis in order.
   - Execute commands from the runbook while the observer verifies steps are performed and outcomes are recorded.

4. Apply mitigation
   - Perform the mitigation actions listed (restart, rollback, scale, etc.) in the staging environment.
   - The observer confirms each action was applied and notes timing.

5. Recovery verification
   - Follow the runbook's Recovery Verification section and confirm metrics return to normal.
   - If the runbook lacks a recovery section, run the verification commands below:
     - Check health endpoints: `curl https://<api-host>/api/v1/health`
     - Check metrics in Prometheus/Grafana for the alert condition to be cleared

6. Post-mortem and follow-ups
   - The observer files one action item for any missing steps, unclear commands, or required access improvements.
   - Mark the runbook as `verified` with date and participants in the runbook header (add a short note at top of the runbook file).

Example verification commands and notes (copy into the runbook under a `Verification` section if missing):

```
# Check health
curl https://<api-host>/api/v1/health | jq '.data'

# Check specific metric in Prometheus (example query)
# time() - oracle_last_price_update_timestamp_seconds > 120

# Verify contract calls resumed
kubectl logs -l app=stellar-aggregator | tail -n 50 | grep "submit_price"
```

Record the verification result in the runbook header as:

- Verified: YYYY-MM-DD — by @oncall_username (shadowed) — @observer_username (mentor)
