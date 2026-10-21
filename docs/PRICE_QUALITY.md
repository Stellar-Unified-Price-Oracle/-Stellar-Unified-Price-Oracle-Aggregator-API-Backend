# Price quality and explainability

Owner: Price quality and explainability maintainers (aggregator service). Scope:
BTC/USD and ETH/USD daily benchmarks, offline confidence evaluation, opt-in
bounded freshness for all aggregator assets, and latest local aggregation evidence.

## Independent corpus (#695)

`benchmarks/price-quality/v1` contains 1,462 actual Coin Metrics PriceUSD observations:
731 UTC dates for each asset from 2024-01-01 through 2025-12-31. Selection was based
on liquidity and continuous reference availability, before examining oracle error.
These references are independent of the configured Chainlink, Redstone, Band and
Reflector adapters. They are one reference publisher, not multiple independent
venues. See the manifest for pinned source URLs, source SHA256 digests, corpus
SHA256, selection policy, ownership and coverage limitations.

Data attribution: Coin Metrics, Inc., https://github.com/coinmetrics/data.
The reference data is **CC BY-NC 4.0**, separately from repository code;
`LICENSE.reference.txt` preserves the upstream notice. Benchmark use must be
noncommercial; this dataset must not be embedded in a commercial production feed.
Coin Metrics methodology: https://docs.coinmetrics.io/asset-metrics/market/priceusd.
Daily resolution does not support intraday freshness/error claims. XLM, stablecoins,
illiquid assets and venue-specific basis risk are outside v1 coverage.

Reproduce from repository root with Python 3 (network needed only for import):

```
python3 scripts/import-price-quality-corpus.py
git diff --exit-code -- benchmarks/price-quality/v1
```

Normal scoring and tests are offline. Never overwrite v1 after accepting it: add a
new version with its own manifest, hashes, coverage review and report. The loader
fails on checksum changes, duplicate/missing rows, off-grid timestamps, nonpositive
prices and schema changes. Review reference methodology or publisher revisions
before promoting another version. The importer fails rather than filling gaps.

## Confidence calibration (#696)

Run `npm run quality:report -- predictions.jsonl report.json`. Each JSONL prediction
must have exactly `asset`, `timestamp` (Unix seconds), `price` (positive decimal USD
string, normalized from the integer and its decimals), `confidence` (0..1), and
`observedAt` (Unix seconds or null). Export **actual selected aggregator results**;
never copy benchmark references into predictions or infer historical confidence
from present-day source counts. Do not include provider payloads or credentials.

Source daily labels are shifted +86400 seconds to UTC day-close instants, per
[Coin Metrics PriceUSD timestamp conventions](https://docs.coinmetrics.io/network-data/network-data-overview/market/price.md).
For example the 2024-01-01 row is compared to a prediction at 2024-01-02T00:00:00Z.
The two windows therefore span [2024-01-02, 2025-01-02) and [2025-01-02, 2026-01-02).
Scoring uses exact asset/timestamp joins, absolute relative error in basis points,
and half-open UTC windows. There is no interpolation, lookahead, nearest-neighbor
matching or forward fill. The fixed split is 2024 calibration and 2025 held-out
validation. Freeze any threshold tuning before examining held-out results. Report
unmatched predictions, outside-window samples, unverified ages and matched/eligible
reference coverage alongside all curves. Empty bins have null metrics and
`insufficient-data`, not zero error. Duplicates and invalid input fail the run.

The JSON report and `.curves.csv` publish five confidence bands, sample counts,
mean confidence, mean/p95 realized error, fraction within the error budget and a
95% Wilson lower bound on that fraction. Confidence 1 belongs to the last band.
The initial review budget is **100 bps p95**, with **30 samples per band** required
before a pass/fail verdict. These are explicit review defaults, not validated
consumer guarantees. Current confidence remains `source-count-ratio-v1`, a
participation ratio, **not** a probability of accuracy; this work does not silently
change its meaning. Correlated observations reduce effective sample size, so even
Wilson bounds are descriptive and cannot establish an SLA.

The checked-in empty-input report is the honest baseline: no historical production
outputs were supplied, so production calibration is insufficient. It publishes the
corpus coverage, empty calibration curves, and freshness backtest without inventing
historical oracle results. Replace the input with retained real outputs to measure
calibration; preserve input hash, report, version and scoring windows with each run.
Before operational adoption, require coverage >=95%, at least 30 observations per
used band and per supported asset, review p95 <=100 bps on the held-out window,
and investigate every unmatched/unverified observation. Pooled curves alone must
not authorize an asset; use the included per-asset windows and CSV curves for those
checks. Per-asset coverage denominators contain only that asset's references.

## Bounded freshness (#697)

The feature is disabled by default. Example aggregator environment value:

```
VOLATILITY_FRESHNESS_POLICY={"minAgeMs":5000,"baseAgeMs":30000,"hardMaxAgeMs":60000,"sensitivity":10}
```

Startup validates finite positive age bounds with min <= base <= hard max, and
finite nonnegative sensitivity. Malformed JSON/config fails startup. Budget is
`min(hardMax, max(minAge, baseAge / (1 + sensitivity * volatilityBps / 10000)))`.
Volatility is absolute relative movement between the last two distinct observation
updates of the selected median in bps, using decimal-safe arithmetic. It is lagged:
a new update changes the *next* decision's budget. Repeated reads cannot manufacture
additional history. Cold start uses zero volatility and the base budget. Higher
volatility only tightens the budget; it can never extend it. Strict age < budget
means equality with hardMax is always rejected. Future, missing or nonfinite
provider observation times are rejected in this mode. Local fetch timestamps do
not establish freshness. No eligible or trusted source yields null, with a failed
quorum bundle; stale/suspicious fallback cannot bypass the hard maximum.

The offline report replays all consecutive same-asset daily references, probing
zero age, minimum/base boundaries and hardMax boundaries. It reports adaptive vs
fixed accepted counts and hard-limit violations. Require zero violations. This is
a daily-volatility stress replay with synthetic age probes, not intraday latency
validation or proof of reduced price error. Use shadow intraday observation logs
and realized errors before enabling this policy for production trading.

## Explainability (#698)

`GET http://aggregator:4002/evidence/BTC` returns the latest **already evaluated**
local decision. Reads never recalculate aggregation. Optional `?id=<sha256>` selects
an exact retained decision: older/replaced or unknown IDs/assets return 404.
`Cache-Control: no-store` prevents caches presenting old evidence as current.
The in-process equivalent is `PriceAggregator.getEvidence(asset)`.

The v1 bundle contains a SHA256 ID over its JSON content (excluding `id`), evaluation
time, policy/budget/lagged volatility, allowlisted source observations, original
integer prices and decimals, common-scale normalized prices, inclusion flags and
reasons, source-count quorum, explicit legacy stale/suspicious fallback, and the
exact returned aggregation result (or null). `quorum.minimum=1` describes the
current aggregator's local minimum, not contract publishing authorization or a
feed-catalog guarantee. Suspicious flags now use the breaker's actual `asset:source`
key, fixing a previously ineffective lookup. A legacy fallback may include a source
with exclusion reasons; `included` and `fallback` make this explicit. Normalization
uses the result scale; values excluded at higher precision can be fractional at
that scale. No result means no normalization scale and null normalized prices.

Only one bundle per asset is retained, replaced on the next evaluation and lost on
restart. Memory cost is O(assets * sources); there is no new database or price
payload schema. Capture selected IDs externally if audit retention is required.
No raw provider responses, URLs, headers, credentials or request identity enter the
bundle. The health port is operational infrastructure: apply the same network
access restrictions as `/health?verbose=true`; do not expose it publicly merely
to distribute bundles. This endpoint does not prove on-chain acceptance.

## Rollout, monitoring and rollback

1. Run `npm run build:backend`, `npm run test:backend` and `npm run quality:report -- benchmarks/price-quality/empty-predictions.jsonl /tmp/quality.json`.
   Review checksum/coverage, curves, zero hard-limit violations and evidence tests.
2. Deploy with freshness disabled; inspect bundles for known assets and compare
   contributing source counts to expected breaker exclusions. The key fix may
   lower participation or expose legacy suspicious fallback previously hidden.
3. Collect actual timestamp-aligned output logs; rerun reports and review coverage,
   insufficient-data bins, p95 errors, within-bound rates and unverified ages.
   Alert on coverage below 95%, any hard-limit violation, and failing used bands.
4. Canary freshness on a noncritical feed/deployment with bounded config. Monitor
   bundle budgets, quorum failures, stale/critical output frequency and publisher
   skipped updates via existing service health/metrics/logs. Compare against the
   fixed-policy deployment; daily backtests alone do not authorize promotion.
5. Roll back freshness by unsetting the variable and restarting; legacy stale
   fallback resumes. Revert the release for the breaker lookup/evidence changes.
   Remove offline reports/datasets independently; there are no schema migrations,
   contract changes, new ports or API/WebSocket price field changes to roll back.

## Implementation verification (upstream ed878e4)

The focused command is:

```
npm exec --workspace services/aggregator -- vitest run tests/price-quality.test.ts tests/price-evidence-http.test.ts
npx tsc --noEmit --strict --esModuleInterop --skipLibCheck --target ES2022 --module ESNext --moduleResolution bundler scripts/price-quality-report.ts
```

On 2026-10-20, all 11 focused tests passed and the standalone strict typecheck
passed. Reimporting the pinned corpus preserved its digest, and two empty-input
report runs produced byte-identical JSON and CSV files. Backtest evidence:
10,220 comparisons, 4,380 adaptive accepts vs 5,840 fixed accepts, zero hard-limit
violations. These acceptance counts are boundary stress probes, not market-time
availability estimates.

Full validation is limited by existing upstream defects, reproduced in a separate
pristine worktree at ed878e4 using the same installed dependency tree:

| Check | Change branch | Pristine upstream |
| --- | --- | --- |
| Aggregator full suite | 36 failed tests, 39 failed suites | Same failures/counts |
| API full suite | 207 failed, 1,243 passed, 93 skipped | Same failures/counts |
| Aggregator build | 125 TypeScript diagnostics | Identical diagnostics |
| API build | 212 TypeScript diagnostics | Identical diagnostics |
| Port consistency | 29 checks pass | Existing port contract preserved |

`npm ci --ignore-scripts` also fails on upstream's missing sdk-bindings workspace
lock entry; local validation used `npm install --ignore-scripts --package-lock=false`
without changing the lockfile. Full backend build stops at the upstream missing
`packages/ssrf-guard/src/deployment-policy.ts`; the aggregator configuration also
contains syntax errors. Existing env-contract documentation drift remains.
The focused tests mock configuration/logging/alert infrastructure to isolate actual
aggregation and HTTP behavior from those defects. Full stack integration cannot
start until upstream builds are repaired; no contract code changed.
