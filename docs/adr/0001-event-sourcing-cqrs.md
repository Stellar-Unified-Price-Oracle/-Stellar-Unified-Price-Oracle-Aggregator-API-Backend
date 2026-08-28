# ADR-0001: Adopt Event Sourcing and CQRS for price data

**Status:** Accepted

**Date:** 2026-07-25

**Authors:** @Devdave-0x

---

## Context

Price data from multiple oracle sources arrives at high frequency. The existing
mutable-record model makes it hard to audit history, replay events after bugs,
or build eventually-consistent read models (e.g. VWAP over a rolling window).

## Decision

Introduce an append-only `EventStore` (`api/src/services/eventStore.ts`) with a
`ProjectionEngine` that rebuilds typed read models from the event log.
Commands (writes) go through `CommandHandler` classes; queries (reads) consume
`Projection` read models.

## Consequences

### Positive

- Full audit trail of every price update.
- Projection rebuild allows correcting bugs without data loss.
- Exactly-once processing guard prevents duplicate event side-effects.
- Snapshots bound replay time on large event logs.

### Negative / Trade-offs

- In-memory store is lost on restart — production deployment requires a
  persistent backend (PostgreSQL append-only table or a dedicated event store).
- Added conceptual overhead for contributors unfamiliar with CQRS.

## Alternatives considered

| Alternative | Why rejected |
|-------------|--------------|
| Mutable SQL rows | No history, hard to replay |
| External event bus (Kafka) | Adds operational complexity for MVP |

## References

- Issue #118
- `api/src/services/eventStore.ts`
- `api/src/routes/events.ts`
