# Price quality report operations

**Owner:** Price Quality workstream (aggregator maintainers). The monthly GitHub Actions workflow generates the report from `verification/fixtures/price-quality-regimes.json`; its run artifact is the public report for that run. Run `npm run report:price-quality -- /tmp/price-quality-report.md` to reproduce locally.

## Supported scope and completion evidence

The report provides labeled source coverage within 1% of the reference, mean absolute percentage error, false-positive and missed-detection rates with two-sided 95% Wilson intervals, and results by calm, volatile, illiquid, and abrupt-dislocation regimes. It reports freshness as unavailable when the corpus has no timestamps. The checked-in corpus is synthetic and hand-labeled, so its rates validate the calculation and scenario coverage only; they are not live feed or provider rankings. Completion evidence is the successful `report:price-quality` workflow run and its retained Markdown artifact.

## Method and limitations

The validator marks a source anomalous when its absolute deviation from the same case's source median exceeds 10%. Case labels are ground truth. Coverage counts each source within 1% of its supplied independent reference. The report uses a Wilson score interval for each binomial rate; intervals can be wide at this small sample size. Cases do not model correlated provider errors, observation age, market impact, or a statistically representative production distribution.

## Source bias alert

At each successful aggregation, the service compares each source against the median of its other available sources and records signed percentage deviations. An alert is actionable after at least 10 observations when the rolling 95% normal interval lies wholly beyond +/-1%; history is limited to 30 observations and held in process memory. It resets on restart. A statistically significant alert recommends provider calibration review or application of the existing quarantine policy; it does not automatically disable or penalize a provider. The estimate assumes independent peers and is not reliable when peers share upstream data.

## Operations, rollout, and rollback

The scheduled workflow runs monthly and can be run manually. Inspect corpus changes and the generated artifact before changing detection thresholds. The workflow is read-only and has no production data dependency. The bias alert is emitted through the existing alert manager and appears in the existing alert history, logs, and configured notification routes; monitor alert volume and source disagreement during rollout. Roll back by reverting the workflow/corpus changes and disabling the bias call in the aggregator; the existing price path and wire formats remain unchanged. No database migration or consumer compatibility change is required.

## Arithmetic vectors

`verification/fixtures/price-arithmetic-vectors.tsv` is the shared TypeScript/Rust conversion corpus. Both validators use signed `i128` bounds, checked multiplication, decimal exponents up to 38, and round-half-away-from-zero at the output scale. Run `npm run validate:price-vectors` and `cargo test price_arithmetic_vectors` from `contracts/price-oracle`.
