# Incident Review Template

Use this template after any chaos experiment that surfaces unexpected behavior or SLO violations.

## Summary

| Field | Value |
|-------|-------|
| Date | |
| Experiment | |
| Facilitator | |
| Duration | |
| Environment | staging |

## Expected behavior

Describe what should have happened (e.g., API pod killed → Deployment recreates → health checks pass within 60s).

## Observed behavior

Describe what actually happened, including metrics, logs, and user-visible impact.

## Timeline

| Time (UTC) | Event |
|------------|-------|
| | Experiment started |
| | First alert fired |
| | Recovery detected |
| | Experiment ended |

## Impact assessment

- **Availability**: Did `/api/v1/health` remain reachable?
- **Data correctness**: Were stale or incorrect prices served?
- **Blast radius**: Which services or assets were affected?

## Root cause

Identify the underlying failure mode (missing probe, insufficient replicas, no circuit breaker, etc.).

## Action items

| Priority | Action | Owner | Issue |
|----------|--------|-------|-------|
| | | | |

## Lessons learned

Document what worked well and what to change for the next game day.
