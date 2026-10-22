# High-Throughput Pipeline — decision record

**Issue:** #588 — `high-throughput-pipeline.ts` was dead code that asserted
performance targets nothing runs.

The module the removed high-throughput pipeline module
has been **deleted in full**. This document is the record the issue asked for:
one keep/adopt/delete decision per export, with the evidence for each, so the
module cannot be reintroduced silently and so nobody has to re-derive why the
thresholds are gone.

## Decisions

| Export | Decision | Replaces / reason |
|---|---|---|
| `fanOutFetch` | **delete** | Not adopted by the poll loop. |
| `SourceRequest<T>` | **delete** | Helper type for `fanOutFetch`; deleted with it. |
| `IncrementalMedian` | **delete** | Duplicates `price-aggregation/median.ts`. |
| `BatchHistoryBuffer` | **delete** | Duplicates `persistence/history.ts`; there is no async batched writer to reconcile with. |
| `PipelineBenchmark` | **delete** | Input type for `assertPerformanceTargets`; deleted with it. |
| `assertPerformanceTargets` | **delete** | Its thresholds are not asserted by CI, so per the issue they are worse than no thresholds. |

### `fanOutFetch` — delete (not adopted)

It is a bounded-concurrency fan-out/fan-in helper with no caller anywhere in
the repository, and the concurrent-polling work explicitly did **not** take it
up: the poll loop in `services/aggregator/src/index.ts` is a self-scheduling,
single-flight, deadline-bounded loop (issue #575) that iterates sources with
`for (const source of sources) { await source.fetchAll(...) }` — deliberately
sequential. `tests/issue-521-concurrent-polling.test.ts` pins that ordering by
asserting elapsed time, so adopting `fanOutFetch` would break an existing
invariant rather than improve it.

The issue's rule is direct: *"if it is not adopted there, it should not
linger."* It was not adopted.

### `IncrementalMedian` — delete (duplicates an existing implementation)

Median is implemented once, in
`services/aggregator/src/price-aggregation/median.ts`
(`medianOnCommonScale`, `toScale`, `isAgeVerified`), which is what aggregation
actually uses and what `tests/issue-520-normalize-decimals.test.ts` covers.
`IncrementalMedian` maintained a second, differently-semantics copy (raw
`bigint` values, no common-scale normalization, no age verification) that
nothing called. Two median implementations is a correctness hazard, not a
feature: they disagree on inputs that are not already on a common scale.

### `BatchHistoryBuffer` — delete (no second batching mechanism to reconcile)

The issue asked to reconcile the buffer with "the async batched history writer"
so there is exactly one batching mechanism. **There is no async batched history
writer.** History is written synchronously and inline, per price, from the poll
loop — either `db.appendHistoricalPrice(...)` when the database is initialised,
or `appendHistoricalPrice(...)` against the file store otherwise. The
corresponding `services/aggregator/src/persistence/history-writer.test.ts` is
entirely placeholder assertions.

So the count is already one: `persistence/history.ts`. Adding a buffer class
that nothing flushes would have made it two.

### `assertPerformanceTargets` — delete (thresholds nothing asserted)

The issue's rule: *"Thresholds that nothing checks are worse than no
thresholds."*

The function asserted five numbers — 100k sustained TPS, p99 ≤ 100 ms,
source fan-out ≤ 500 ms, batch writes ≥ 100k events/s, event-loop block ≤ 1 ms.
A repository-wide search for `sustainedTps`, `batchWriteEventsPerSecond`,
`eventLoopBlockMs` and `assertPerformanceTargets` returns only the definition
itself: no benchmark feeds it, no CI job invokes it, no baseline file exists.
`.github/workflows/ci.yml` runs a benchmark (`scripts/benchmark.js`) against the
API's HTTP endpoints with `BENCHMARK_TARGET_TPS`/`BENCHMARK_THRESHOLD_PCT`, but
that path never touches this module and asserts none of these five numbers.

Deleting the numbers is honest. Keeping them and leaving them unasserted is
what the issue objected to.

The alternative — wiring them to a committed CI baseline — was rejected because
it is a separate piece of work (a real throughput harness for the poll loop
does not exist), and inventing numbers to keep a dead export alive would be
reproducing the exact problem this issue reports.

## Why the whole file went

Each export independently resolved to "delete". A module whose every export is
deleted is a deleted module, so its former performance directory is gone
rather than left as an empty directory. Nothing in `src/`, `tests/`, `docs/` or
`.github/` referenced it; the only other mentions were the API feature flag
`high-throughput-pipeline` (`api/src/routes/featureFlags.ts`, `enabled:
false`, a separate rollout control that never pointed at this module) and this
document.

## Coverage guard

The issue's last requirement: *"Coverage configuration cannot mask unused
modules."*

`services/aggregator/vitest.config.ts` excludes exactly one file from coverage:

```ts
coverage: {
  include: ['src/**/*.ts'],
  exclude: ['src/index.ts'],
}
```

`src/index.ts` is the service entrypoint (poll loop, WS broadcast, health
server) and cannot be unit-tested without booting the process, so its exclusion
is legitimate. Every other file under `src/` must be reached by tests or fail
the thresholds (`lines`/`functions`/`statements` 45, `branches` 38) that CI
asserts — so an unused module now *lowers* coverage instead of hiding behind an
exclusion.

`tests/issue-588-coverage-guard.test.ts` enforces this mechanically:

- the `exclude` list must still be exactly `['src/index.ts']`, so widening it
  requires a deliberate, reviewable edit to the test as well as the config;
- the `include` list must still be `['src/**/*.ts']`, so a module cannot be
  pushed out of measurement with a narrower pattern;
- the thresholds must still be present;
- the high-throughput module must remain absent.

Adding a new coverage exclusion therefore breaks CI unless the guard is updated
in the same change, which is the review signal the issue wanted.
