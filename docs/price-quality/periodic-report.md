# Feed quality validation report

Generated: 2026-10-21T01:45:00.846Z

> Corpus results are synthetic validation measurements, not observed production feed performance. Freshness cannot be measured because this corpus contains no timestamped observations.

## Coverage and accuracy

- Labeled cases: 6; sources: 18; regimes: calm, volatile, illiquid, abrupt-dislocation.
- Source coverage against the corpus reference within 1%: 12/18 (66.67%).
- Mean absolute percentage error across labeled sources: 4.675%.
- Freshness: unavailable (no observation timestamps in corpus).

## Detection quality

Detection rule: flag each source whose absolute deviation from the case median exceeds 10%.
- Confusion counts: TP 1, FP 1, FN 1, TN 15.
- False-positive rate: 6.25% (95% Wilson CI [1.11%, 28.33%]); missed-detection rate: 50.00% (95% Wilson CI [9.45%, 90.55%]).
- Coverage within 1%: 95% Wilson CI [43.75%, 83.72%]. Raw counts are shown so small-sample uncertainty is visible.

## Results by market regime

| Regime | Cases | Sources | Mean absolute error |
|---|---:|---:|---:|
| calm | 1 | 3 | 0.056% |
| volatile | 1 | 3 | 0.124% |
| illiquid | 2 | 6 | 5.750% |
| abrupt-dislocation | 2 | 6 | 8.186% |

## Methodology and limitations

Synthetic labeled validation corpus; prices are same-unit USD values. Deviation rule flags a source when absolute percent error from the all-source median exceeds 10%. Truth labels are explicit and the report computes confusion rates from them. Synthetic results are not production performance estimates.

The corpus is intentionally small and hand-labeled. Results do not establish live coverage, provider independence, liquidity, temporal freshness, or production confidence intervals. Add timestamped independently sourced observations and increase sample size before using this report to compare providers.
