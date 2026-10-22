# Price quality measurement and replay (issues #699–#702)

**Owner:** Aggregator maintainers. **Scope:** off-chain feed observations and retained price-history records; this does not alter Soroban storage or the public price response schema.

## Per-feed staleness decision and measurement

Supply each replay with an immutable policy containing `version`, `maxAgeSeconds`, `staleWeight` (0–1), and `excludeAfterSeconds`. At the replay window end, observations at or under the freshness bound have full weight, older observations are down-weighted, and observations older than the exclusion bound are omitted. The replay reports stale and excluded source names and the absolute and relative difference from the fresh-only median. This counterfactual is a measurable estimate of stale participation's effect; it does not claim ground-truth market error without an independently validated reference price.

Default review policy: 60 seconds fresh, 0.5 stale weight, and exclusion after 180 seconds. Each production feed should set its own values using retained observations. For each proposed policy, replay a representative 30-day sample, report the p50/p95/max relative delta against the fresh-only median and source exclusion rate, then have the aggregator maintainer approve the versioned policy. The supplied tool emits a stable SHA-256 result hash for identical observation data, window, and policy.

## Disagreement evidence

Outliers above the configured percentage threshold are classified in precedence order: provider error evidence, denomination mismatch, venue mismatch, then observation-time skew above 30 seconds; otherwise they remain `unclassified`. Each classification includes deviation, observation times, denomination, venue, and provider error fields available in the retained input. Classification is evidence-based and heuristic: missing metadata remains unclassified and operators should not infer causation from price distance alone.

## Historical corrections

`recordHistoricalCorrection` appends a revision to `corrections-<asset>.json`, preserving the prior value, corrected value, reason, evidence references, correction time, and a hash link to the previous revision. Existing `history-<asset>.json` entries remain untouched, preserving existing consumers and stable access to the original record. Keep correction files under the same protected, backed-up history directory; callers should pass reviewed timestamps and evidence. This initial implementation provides a persistence primitive; a privileged correction API and automated reconciliation are outside scope.

## Replay procedure

Provide a JSON array of retained observations with `asset`, `source`, integer `price`, `decimals`, `timestamp`, and optional `observedAt`, `denomination`, `venue`, and `providerError`. Run:

```sh
npx tsx scripts/replay-price-window.ts observations.json XLM 1720000000 1720003600 policy.json
```

The policy JSON uses the `ReplayPolicy` fields above plus `disagreementThresholdPercent`. Sort order and canonical JSON hashing make the result deterministic; replay rejects invalid windows, invalid policies, and empty eligible windows. Retain the observation export and policy alongside the result hash to make a review repeatable.

## Operations and compatibility

The tooling is opt-in and does not change aggregation defaults, API schemas, database schemas, or on-chain behavior. Monitor replay failures and review reported stale participation, exclusions, disagreement causes, and hash stability during policy review. Roll out by replaying in shadow mode and reviewing metrics before adopting a new per-feed policy. Roll back by restoring the prior policy version; correction records are append-only, so supersede an incorrect correction with a new revision rather than deleting history. Back up correction files with price history and restrict writes to the aggregator's trusted operator path.
