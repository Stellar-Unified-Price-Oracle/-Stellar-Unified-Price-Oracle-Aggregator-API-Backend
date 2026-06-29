# Post-Mortem Template

> Copy this file to `docs/post-mortems/YYYY-MM-DD-<slug>.md` and fill it in within 48 hours of resolution.

---

## Incident Summary

| Field | Value |
|---|---|
| **Date** | YYYY-MM-DD |
| **Duration** | X hours Y minutes |
| **Severity** | P0 / P1 / P2 |
| **Incident Commander** | @username |
| **Participants** | @user1, @user2 |
| **Status** | Resolved |

## Impact

- **Services affected**: (e.g., Price API, WebSocket feed, Soroban contract)
- **Consumer impact**: (e.g., "Price feed unavailable for 12 minutes; ~3 downstream integrations affected")
- **Data integrity**: (e.g., "No data loss; stale prices served for <duration>")

## Timeline (UTC)

| Time | Event |
|------|-------|
| HH:MM | Alert fired: `<AlertName>` |
| HH:MM | On-call engineer paged |
| HH:MM | Investigation started |
| HH:MM | Root cause identified |
| HH:MM | Mitigation applied |
| HH:MM | Service restored |
| HH:MM | All-clear declared |

## Root Cause

_What caused the incident? Be specific — name the component, the failure mode, and why the failure was not caught earlier._

## Contributing Factors

- (e.g., missing alerting on X)
- (e.g., runbook for Y did not exist)
- (e.g., dependency on Z not documented)

## What Went Well

- (e.g., circuit breaker limited blast radius)
- (e.g., on-call response was fast)

## What Could Be Improved

- (e.g., alert threshold too high; delayed detection)
- (e.g., runbook was missing a diagnosis step)

## Action Items

| Action | Owner | Due Date | Issue |
|--------|-------|----------|-------|
| Add alert for X | @owner | YYYY-MM-DD | #N |
| Update runbook Y | @owner | YYYY-MM-DD | #N |
| Add monitoring for Z | @owner | YYYY-MM-DD | #N |
