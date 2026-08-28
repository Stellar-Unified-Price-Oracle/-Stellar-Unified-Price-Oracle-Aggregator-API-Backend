# ADR-0002: In-process feature flag system with automated rollback

**Status:** Accepted

**Date:** 2026-07-25

**Authors:** @Devdave-0x

---

## Context

Rolling out new aggregation strategies (e.g. experimental caching, v2 endpoints)
to all users at once carries risk. We need a lightweight mechanism to control
rollout percentage and automatically disable a flag if its error rate spikes.

## Decision

Implement `api/src/services/featureFlags.ts` — an in-process flag registry with:
- Deterministic SHA-256 bucket assignment for stable A/B rollouts.
- `autoDisableErrorRate` threshold per flag.
- `FEATURE_FLAGS_JSON` env var for runtime overrides without redeployment.
- `GET /api/feature-flags` endpoint for observability.

## Consequences

### Positive

- Zero external dependencies (no LaunchDarkly, no database).
- Automated rollback limits blast radius of bad releases.
- Stable bucket assignment means the same entity always sees the same variant.

### Negative / Trade-offs

- Flag state is in-process; restarting the server resets error counters.
- Not distributed — each pod has independent state (acceptable for stateless APIs).

## Alternatives considered

| Alternative | Why rejected |
|-------------|--------------|
| LaunchDarkly | External dependency, licensing cost |
| Redis-backed flags | Added infra complexity at this stage |

## References

- Issue #117
- `api/src/services/featureFlags.ts`
- `api/src/routes/featureFlags.ts`
