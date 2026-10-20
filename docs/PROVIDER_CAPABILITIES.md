# Provider capability negotiation (issue #684)

**Owner:** provider ecosystem workstream · **Scope:** aggregator feed assignment
**Evidence:** `npm test` — `services/aggregator/tests/capabilities.test.ts`

`src/oracle-sources/capabilities.ts` declares an explicit capability profile per
provider — supported assets, update cadence, precision, and historical
availability — via `ProviderCapabilities`. `CapabilityRegistry` owns the
compatibility decision; `FeedAssignmentValidator` splits a batch of
`(source, asset)` assignments into valid and rejected, logging every rejection
so misconfiguration surfaces instead of silently discarding quotes.

## Runtime enforcement

`BaseSource.fetchWithOutcome` checks the registry before any network call: an
asset outside the source's supported set is skipped as `no-price` without a
request. Each of the four adapters declares its `capabilities` profile; the
singleton `capabilityRegistry` is seeded with the defaults (`XLM, USDC, BTC,
ETH, USDT` at the documented cadences).

## Monitoring / operations

- Rejections are `logger.warn` lines keyed by `(source, asset, reason)`.
- Narrow `WATCHED_ASSETS` or override a profile via `capabilityRegistry.register`
  when a provider drops an asset; no code deploy is needed for the latter.

## Rollout / rollback

- **Rollout:** merge; defaults match the current feed list, so behavior is
  unchanged and can be verified with `npm run test:aggregator`.
- **Rollback:** revert; the guard is additive (it only skips previously
  attempted fetches for unsupported assets), so reverting restores the old
  fetch-and-discard path with no schema or config changes.
