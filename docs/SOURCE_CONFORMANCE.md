# Source conformance suite (issue #683)

**Owner:** provider ecosystem workstream · **Scope:** aggregator oracle adapters
**Evidence:** `npm test` — `services/aggregator/tests/source-conformance.test.ts`

`src/oracle-sources/conformance.ts` defines provider-neutral golden vectors and
`SourceConformanceSuite`, the contract every adapter must pass before it can
contribute to production feeds. Each vector replays a recorded provider payload
through `parseProviderResponse` and asserts the classified outcome
(`ok` / `no-price` / `invalid-payload`) and, when `ok`, the normalized
decimals. A report marks the provider conformant only when **every blocking
vector passes**; non-blocking vectors are informational.

## Golden vectors (`DEFAULT_VECTORS`)

Twelve blocking vectors cover all four providers (valid envelope, missing
field, zero/out-of-range prices, null/absent feed data, asset not carried).
They mirror `tests/fixtures/oracle-payloads` so a recorded schema change is
caught by both the unit fixtures and the suite.

## Monitoring / operations

- Run the suite in CI on every aggregator change (`vitest run
  tests/source-conformance.test.ts`).
- A non-conformant provider must be removed from the poll loop (drop its entry
  from `pollSources`, narrow `WATCHED_ASSETS`) until the adapter is fixed.

## Rollout / rollback

- **Rollout:** merge; no config or deployment changes. Follow-on work can wire
  the suite into the preflight check.
- **Rollback:** revert this change; the suite has no runtime callers, so
  reverting is a clean delete with zero behavioral impact.
