# Price correctness validation suite

Issue #420. Proves aggregated prices are *correct*, not merely *available* — a
wrong price is worse than no price.

## What it checks

`scripts/validate-price-correctness.mjs` (`npm run validate:prices`) replays the
cases in `verification/fixtures/price-correctness-cases.json` through the
reference aggregation logic (median, matching
`services/aggregator/src/price-aggregation/aggregator.ts`, plus
deviation-from-median outlier rejection mirroring the circuit breaker's
`deviationThreshold`) and asserts, per case:

1. **Median correctness** — the aggregate matches the known-good historical value
   within `medianTolerancePercent`.
2. **Outlier handling** — exactly the sources marked `expectedOutliers` are
   dropped (deviation from the all-source median above `outlierDeviationPercent`).
3. **Robustness** — injecting one extra gross outlier (100x) must not move the
   resulting median beyond tolerance.

Exit non-zero on any failure, with each failure printed.

## Adding cases

Append to `verification/fixtures/price-correctness-cases.json`. Prefer real
snapshots pulled from `price_history` at a timestamp whose correct aggregate is
known from an independent source (exchange VWAP, a second oracle). Each case:

```json
{
  "name": "descriptive label",
  "asset": "BTC",
  "sources": [{ "source": "coinbase", "price": 42010.5 }, ...],
  "expectedMedian": 42010.5,
  "expectedOutliers": ["source-to-drop"]
}
```

## CI

The `price-correctness` job in `.github/workflows/ci.yml` runs `npm run
validate:prices` on every push and PR to `main` / `develop`, so any change that
touches the aggregator (or the fixtures) is gated on it.
