# Incident Runbooks — Stellar Unified Price Oracle

This directory contains operational runbooks for diagnosing and resolving incidents. Each runbook is linked from Prometheus alert annotations via `runbook_url`.

## Severity Levels

| Level | Response SLA | Definition |
|-------|-------------|------------|
| **P0 – Critical** | 15 min | Total service outage; all price feeds down; data loss risk |
| **P1 – High** | 30 min | Major degradation; >50% of sources failing; latency >5s |
| **P2 – Medium** | 2 hours | Partial degradation; single source down; p95 latency elevated |
| **P3 – Low** | Next business day | Minor issue; no consumer impact; cosmetic or informational |

## Escalation Path

1. **Primary on-call engineer** — primary responder; owns the incident until acked, mitigated, or handed over
2. **Team lead** — escalated for any P1 or prolonged P2 issue that exceeds 2× the SLA or after 1 hour without actionable mitigation
3. **Engineering manager** — escalated for all P0 incidents, customer-facing outages, or if the incident exceeds 30 minutes without recovery

## On-call Rotation and Handoff

- Rotation owner: the primary on-call is assigned in PagerDuty with a 24/7 weekly rotation.
- Secondary coverage: the backup on-call is assigned to the same service and must be in the escalation chain for all P1/P0 alerts.
- Handoff window: the outgoing engineer must notify the incoming engineer via Slack or PagerDuty before the shift changes.
- Shadowing requirement: the outgoing engineer remains on the call for the first 30 minutes of the new rotation during a handoff, and the incoming engineer must acknowledge the incident channel before taking over ownership.
- Acknowledge by: the on-call responder must acknowledge the page within the alert SLA window; unacknowledged alerts escalate automatically according to the route policy below.

## Severity to Escalation Mapping

| Alert / Condition | Severity | Primary channel | Primary target | Secondary target | Acknowledge SLA |
|---|---|---|---|---|---|
| All sources down / contract outage / critical SLA breach | P0 / critical | PagerDuty | primary-oncall | engineering-manager | 15 min |
| Stale feed / degraded upstream / degraded health | P1 / warning | Opsgenie | primary-oncall | team-lead | 30 min |
| Single-source drift / minor anomaly / non-user-impacting noise | P2/P3 / info | Slack | team-channel | none | 4 hours |

> Production routing must only page humans; automated retries and status-only notifications remain in the team channel.

## Test Page and Validation

1. Run a synthetic page from the PagerDuty or Opsgenie staging environment using the production service key and a known test alert.
2. Verify that the alert reaches the configured on-call contact in the expected channel within 2 minutes.
3. Acknowledge the page and confirm the escalation path is recorded in the incident timeline.
4. Trigger the secondary escalation only after the acknowledgement timeout is exceeded to confirm the manager or lead receives the callback.
5. Document the test result in the operations log with the alert ID, the timestamp, and the responder that acknowledged it.

### Example test page command

```bash
curl -X POST https://events.pagerduty.com/v2/enqueue \
  -H 'Content-Type: application/json' \
  -d '{
    "routing_key": "${PAGERDUTY_PROD_ROUTING_KEY}",
    "event_action": "trigger",
    "dedup_key": "ops-rotation-test-$(date +%s)",
    "payload": {
      "summary": "PagerDuty test page for production on-call verification",
      "source": "stellar-price-oracle-ops-test",
      "severity": "critical",
      "custom_details": {
        "alert_type": "source_down",
        "runbook": "docs/runbooks/oracle-source-down.md",
        "owner": "primary-oncall"
      }
    }
  }'
```

## Runbooks Index

- [oracle-source-down.md](oracle-source-down.md)
- [price-feed-stale.md](price-feed-stale.md)
- [price-anomaly.md](price-anomaly.md)
- [contract-failures.md](contract-failures.md)
- [high-error-rate.md](high-error-rate.md)
- [database-issues.md](database-issues.md)
- [mainnet-deployment.md](mainnet-deployment.md)

## Runbooks Index

| Alert / Scenario | Runbook |
|---|---|
| Oracle source down | [oracle-source-down.md](oracle-source-down.md) |
| Price feed stale | [price-feed-stale.md](price-feed-stale.md) |
| Anomaly detected in price data | [price-anomaly.md](price-anomaly.md) |
| Soroban contract call failures | [contract-failures.md](contract-failures.md) |
| High API error rate | [high-error-rate.md](high-error-rate.md) |
| Database connectivity issues | [database-issues.md](database-issues.md) |
| Mainnet deployment | [mainnet-deployment.md](mainnet-deployment.md) |

## Post-Mortem

Use the [post-mortem template](post-mortem-template.md) for all P0 and P1 incidents within 48 hours of resolution.

## Catastrophic failure

If a runbook's mitigation isn't enough — data loss, full cluster loss — this is a
disaster recovery event, not a routine incident. See the
[disaster recovery plan](../disaster-recovery/README.md).
