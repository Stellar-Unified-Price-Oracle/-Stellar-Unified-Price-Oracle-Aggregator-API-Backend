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

1. **On-call engineer** — primary responder; owns the incident until resolved or escalated
2. **Team lead** — escalate if not mitigated within 2× SLA or if P0/P1
3. **Engineering manager** — escalate for customer-facing P0 exceeding 30 min

## Runbooks Index

| Alert / Scenario | Runbook |
|---|---|
| Oracle source down | [oracle-source-down.md](oracle-source-down.md) |
| Price feed stale | [price-feed-stale.md](price-feed-stale.md) |
| Anomaly detected in price data | [price-anomaly.md](price-anomaly.md) |
| Soroban contract call failures | [contract-failures.md](contract-failures.md) |
| High API error rate | [high-error-rate.md](high-error-rate.md) |
| Database connectivity issues | [database-issues.md](database-issues.md) |

## Post-Mortem

Use the [post-mortem template](post-mortem-template.md) for all P0 and P1 incidents within 48 hours of resolution.
