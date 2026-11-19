# Budget Forecast Uncertainty (Issue #793)

The monthly budget forecast is reported as a confidence range rather than a single number,
with the drivers that move it ranked by impact and every recorded month tracked against the
range. Generated from `config/budget-forecast.json`, `config/cost-model.json` and
`config/cost-invoices.json` by `npm run budget:forecast`; do not edit by hand.

- **Owner**: Economics and ecosystem sustainability workstream (Platform FinOps)
- **Last updated**: 2026-11-19 · **Review interval**: 30 days · **Next review**: 2026-12-19

## Confidence ranges (monthly, USD)

| Category | Point (all drivers at mode) | Mean | P10 | P50 | P90 | P90 − P10 |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| Cloud (compute, storage, egress, control plane) | $27.32 | $29.63 | $27.98 | $29.43 | $31.60 | $3.62 |
| Network (Soroban fees and rent) | $67.78 | $80.05 | $60.27 | $78.34 | $102.45 | $42.18 |
| **Total** | $95.10 | $109.68 | $89.86 | $107.98 | $132.28 | $42.42 |

Method: each driver is a triangular distribution (low, mode, high). 20,000 draws with
seed 793 make the result reproducible, so the same inputs always produce this document.
Percentiles are computed per category from the simulated totals, so the total P10/P90 is
narrower than the sum of the category P10/P90s.

## Drivers

| Driver | Category | Unit | Low | Mode | High | Unit cost | Rationale |
| :--- | :--- | :--- | ---: | ---: | ---: | :--- | :--- |
| Requested vCPU (all services) | cloud | vCPU | 0.6 | 0.625 | 0.8 | $29.20 | Optimized requests in config/cost-model.json; high case is HPA scale-out under surge demand. |
| Requested memory (all services) | cloud | GiB | 1.4 | 1.4375 | 1.8 | $3.65 | Optimized requests in config/cost-model.json; high case mirrors vCPU scale-out. |
| Persistent volume | cloud | GiB | 10 | 10 | 14 | $0.17 | TimescaleDB PVC; high case is a volume expansion before the archive tier rollout. |
| Network egress | cloud | GiB | 9 | 12.5 | 22 | $0.09 | Inferred from VPC flow logs (errorBandPct 18 in cost-model.json); skewed high for WS fan-out growth. |
| Shared control-plane allocation | cloud | USD | 0.9 | 1 | 1.2 | $1.00 | Namespace share of the $73/month control plane (errorBandPct 12). |
| Soroban price submissions | network | submissions | 400000 | 432000 | 520000 | 0.00015 XLM | 5 assets at a 30s cadence; high case adds deviation-triggered submissions. |
| Soroban state rent extensions | network | XLM | 450 | 500 | 650 | 1 XLM | Monthly TTL extension job (scripts/extend-ttl-job.ts); see docs/RENT_BUDGET.md. |
| XLM/USD exchange rate | network (fx) | USD per XLM | 0.08 | 0.12 | 0.2 | converts XLM costs | Converts every XLM-denominated network cost; the widest single source of uncertainty. |

## Sensitivity drivers

Each driver is moved to its low and high value while every other driver stays at its mode.
Drivers are ranked by the resulting swing in the total monthly forecast.

| Rank | Driver | Total at low | Total at high | Downside | Upside | Swing | Share of swing |
| ---: | :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | XLM/USD exchange rate | $72.51 | $140.28 | -$22.59 | +$45.18 | $67.78 | 65.6% |
| 2 | Soroban state rent extensions | $89.10 | $113.10 | -$6.00 | +$18.00 | $24.00 | 23.2% |
| 3 | Requested vCPU (all services) | $94.37 | $100.21 | -$0.73 | +$5.11 | $5.84 | 5.6% |
| 4 | Soroban price submissions | $94.52 | $96.68 | -$0.58 | +$1.58 | $2.16 | 2.1% |
| 5 | Requested memory (all services) | $94.96 | $96.42 | -$0.14 | +$1.32 | $1.46 | 1.4% |
| 6 | Network egress | $94.78 | $95.95 | -$0.31 | +$0.86 | $1.17 | 1.1% |
| 7 | Persistent volume | $95.10 | $95.78 | $0.00 | +$0.68 | $0.68 | 0.7% |
| 8 | Shared control-plane allocation | $95.00 | $95.30 | -$0.10 | +$0.20 | $0.30 | 0.3% |

## Variance against actual costs

Cloud actuals are the invoiced totals in `config/cost-invoices.json`; network actuals are XLM
spent by the oracle account converted at the month's average XLM/USD rate. Variance is measured
against the forecast P50. Tolerances: cloud ±15%, network ±20%, total ±15%.

| Month | Cloud | Network | Total |
| :--- | :--- | :--- | :--- |
| 2026-07 | $27.40 (-6.9%, outside band) | $66.22 (-15.5%, within band) | $93.62 (-13.3%, within band) |
| 2026-08 | $26.80 (-8.9%, outside band) | $70.30 (-10.3%, within band) | $97.10 (-10.1%, within band) |
| 2026-09 | — | $74.72 (-4.6%, within band) | — |
| 2026-10 | — | $87.02 (+11.1%, within band) | — |

**Calibration**: 4 of 6 category observations fall inside the P10–P90 band
(66.7% observed vs 80% expected). Persistent under-coverage on one side
means the driver ranges are biased and must be re-centred at the next review.

- **within band**: actual is between P10 and P90.
- **outside band**: actual is outside P10–P90 but within tolerance; review the driver ranges.
- **tolerance breach**: variance exceeds tolerance; `npm run budget:forecast:check` fails until the
  forecast is revised or the variance is explained in the review notes.

## Review procedure and completion evidence

1. Each month, append the invoice to `config/cost-invoices.json` and the oracle account's XLM
   spend to `networkActuals` in `config/budget-forecast.json`.
2. Run `npm run budget:forecast` and commit the regenerated document.
3. At each review, re-centre any driver whose actuals sit consistently on one side of the band.

`npm run budget:forecast:check` (run in CI) fails on invalid drivers, a tolerance breach or a stale
document. `scripts/tests/budget-forecast.test.mjs` covers the sampler, percentile maths,
degenerate (zero-width) ranges, sensitivity ranking, variance classification and invalid inputs.

## Compatibility, monitoring and operational impact

- **Compatibility**: Additive. Reuses rates from `config/cost-model.json` and invoices from
  `config/cost-invoices.json` without changing them; `npm run cost:reconcile` and `cost:check` are
  unaffected.
- **Monitoring**: The XLM/USD rate and Soroban rent are the largest swing drivers; the existing
  rent budget (docs/RENT_BUDGET.md) and the oracle account balance alerts remain the runtime
  signals.
- **Operational impact**: None. Offline report; no runtime service reads these files.

## Rollout and rollback

- **Rollout**: Merge, then add actuals monthly as described above.
- **Rollback**: Revert the commit. No services, schemas or deployed resources depend on it.
