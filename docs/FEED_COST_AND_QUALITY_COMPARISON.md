# Feed Cost and Delivered Quality Comparison (Issue #787)

This report provides evidence-based analysis comparing operational feed costs against
delivered quality metrics (freshness, source coverage, and measured accuracy) for all active
production feeds. These metrics form the objective foundation for oracle capacity allocation
and commercial pricing tiers.

## Executive Summary & Comparison Matrix

| Feed | Asset Pair | Cadence | Monthly OpEx | Cost / 1k Updates | Freshness (p95) | Sources | Accuracy | Quality Score | Quality / $ | Tier Category |
| :--- | :--- | :---: | ---: | ---: | ---: | :---: | ---: | ---: | ---: | :--- |
| **xlm-usd** | XLM/USD | 30s | $44.61 | $0.52 | 2850 ms | 4/4 | 99.4% | **95.4 / 100** | **2.14** | Standard Protocol Asset |
| **usdc-usd** | USDC/USD | 30s | $44.61 | $0.52 | 2100 ms | 4/4 | 99.9% | **97.7 / 100** | **2.19** | Core Settlement Asset |
| **btc-usd** | BTC/USD | 15s | $87.13 | $0.50 | 1750 ms | 4/4 | 99.7% | **92.1 / 100** | **1.06** | High-Frequency Flagship |
| **eth-usd** | ETH/USD | 20s | $66.30 | $0.51 | 2200 ms | 4/4 | 99.6% | **93.8 / 100** | **1.41** | Tier 1 Liquid Asset |
| **usdt-usd** | USDT/USD | 30s | $44.61 | $0.52 | 2400 ms | 4/4 | 99.8% | **95.9 / 100** | **2.15** | Core Settlement Asset |
| **Fleet Totals / Avg** | **5 feeds** | — | **$287.26** | **$0.51** | — | — | — | **95 / 100** | — | — |

## Feed Cost Decomposition & Unit Economics

Costs are tracked across four operational cost centers: provider data ingestion,
aggregation compute, TimescaleDB hypertable storage, and on-chain Soroban submission gas:

| Feed ID | Ingestion (Data APIs) | Aggregation Compute | TimescaleDB Storage | On-Chain Gas & Rent | Total Monthly Cost | Cost Share (%) |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| `xlm-usd` | $24.50 | $4.80 | $1.75 | $13.56 | **$44.61** | 15.5% |
| `usdc-usd` | $24.50 | $4.80 | $1.75 | $13.56 | **$44.61** | 15.5% |
| `btc-usd` | $48.00 | $8.50 | $3.50 | $27.13 | **$87.13** | 30.3% |
| `eth-usd` | $36.50 | $6.80 | $2.65 | $20.35 | **$66.30** | 23.1% |
| `usdt-usd` | $24.50 | $4.80 | $1.75 | $13.56 | **$44.61** | 15.5% |
| **Total** | **$158.00** | **$29.70** | **$11.40** | **$88.16** | **$287.26** | **100.0%** |

### Cost Centers Breakdown
1. **On-Chain Soroban Gas & State Rent**: Represents ~31% of feed costs; scales directly with update cadence (e.g. BTC 15s cadence consumes 2x gas of standard 30s feeds).
2. **Data Provider Ingestion**: Represents ~55% of total spend; covers redundant websocket feeds across independent market venues to eliminate single-point-of-failure risks.
3. **Compute & Storage**: Sub-linear scaling (~14%); optimized through shared container replicas and TimescaleDB chunk compression.

## Quality Metrics: Freshness, Coverage, and Accuracy

Delivered quality is evaluated across three core dimensions weighted in the composite index:
- **Freshness (35%)**: Evaluates median (p50) and tail (p95) latency from external quote generation to on-chain state availability.
- **Coverage (35%)**: Evaluates active provider quorum and source diversity to resist venue-specific outages.
- **Accuracy & Dispersion (30%)**: Evaluates inter-provider spread (in basis points) and reference benchmark agreement.

| Feed ID | Cadence | Freshness (p50) | Freshness (p95) | Max Staleness | Violation Rate | Quorum | Spread (Bps) | Accuracy | Composite Quality |
| :--- | :---: | ---: | ---: | ---: | ---: | :---: | ---: | ---: | ---: |
| `xlm-usd` | 30s | 1420 ms | 2850 ms | 120s | 2.00% | 3/4 | 3.4 bps | 99.4% | **95.4** |
| `usdc-usd` | 30s | 1180 ms | 2100 ms | 120s | 1.00% | 3/4 | 1.1 bps | 99.9% | **97.7** |
| `btc-usd` | 15s | 850 ms | 1750 ms | 60s | 4.00% | 3/4 | 2.1 bps | 99.7% | **92.1** |
| `eth-usd` | 20s | 1050 ms | 2200 ms | 90s | 3.00% | 3/4 | 2.6 bps | 99.6% | **93.8** |
| `usdt-usd` | 30s | 1250 ms | 2400 ms | 120s | 2.00% | 3/4 | 1.4 bps | 99.8% | **95.9** |

## Comparative Evaluation & Capacity/Pricing Recommendations

Integrating unit economics with delivered quality provides empirical evidence for resource allocation and commercial rate tiers:

### `xlm-usd` (XLM/USD)
- **Pricing Tier Recommendation**: **Standard Protocol Asset**
- **Capacity Allocation**: Healthy Headroom
- **Unit Economics**: $44.61 / month ($0.52 per 1k submissions)
- **Delivered Quality**: **95.4 / 100** (2.14 Quality Points / $1)
- **Operational Action**: Maintain current 30s cadence; provider spread and latency remain optimal within current budget.

### `usdc-usd` (USDC/USD)
- **Pricing Tier Recommendation**: **Core Settlement Asset**
- **Capacity Allocation**: Cost-Optimal Reference
- **Unit Economics**: $44.61 / month ($0.52 per 1k submissions)
- **Delivered Quality**: **97.7 / 100** (2.19 Quality Points / $1)
- **Operational Action**: Benchmark stablecoin reference feed; tightest spread and lowest volatility risk across providers.

### `btc-usd` (BTC/USD)
- **Pricing Tier Recommendation**: **High-Frequency Flagship**
- **Capacity Allocation**: High Throughput Priority
- **Unit Economics**: $87.13 / month ($0.50 per 1k submissions)
- **Delivered Quality**: **92.1 / 100** (1.06 Quality Points / $1)
- **Operational Action**: 15s cadence justifies premium pricing tier; delivers sub-second p50 freshness with full 4-source consensus.

### `eth-usd` (ETH/USD)
- **Pricing Tier Recommendation**: **Tier 1 Liquid Asset**
- **Capacity Allocation**: Balanced Cost/Quality
- **Unit Economics**: $66.30 / month ($0.51 per 1k submissions)
- **Delivered Quality**: **93.8 / 100** (1.41 Quality Points / $1)
- **Operational Action**: 20s cadence balances gas burn with low deviation; optimal candidate for high-volume DeFi lending collateral.

### `usdt-usd` (USDT/USD)
- **Pricing Tier Recommendation**: **Core Settlement Asset**
- **Capacity Allocation**: Cost-Optimal Reference
- **Unit Economics**: $44.61 / month ($0.52 per 1k submissions)
- **Delivered Quality**: **95.9 / 100** (2.15 Quality Points / $1)
- **Operational Action**: Standard stablecoin profile; low resource footprint with stable multi-source consensus.

### Strategic Portfolio Findings
1. **Flagship High-Frequency Differentiation**: `btc-usd` consumes the largest monthly budget ($87.13) due to its 15s cadence, but delivers industry-leading sub-second p50 freshness (850 ms) and 99.7% accuracy, justifying its placement in the Premium High-Frequency tier.
2. **Stablecoin Efficiency**: `usdc-usd` and `usdt-usd` achieve the highest quality-per-dollar ratios (2.22 and 2.22 respectively) with tight spreads (1.1–1.4 bps), serving as cost-optimal references for settlement.
3. **Protocol Native Optimization**: `xlm-usd` demonstrates balanced performance with 30s cadence and 99.4% accuracy, fulfilling native ecosystem oracle demand within sustainable gas limits.

## Review Procedure and Completion Evidence

Run `npm run feed:cost-quality` to regenerate this report, and `npm run feed:cost-quality:check` to verify that the documentation artifact matches the underlying metrics manifest in CI.

Automated verification passes when:
- `npm run feed:cost-quality:check` exits with code 0.
- All five core active feeds are evaluated across all four cost centers and three quality pillars.
- Composite quality scores and unit cost ratios align with the mathematical weighting model.
- Automated tests in `scripts/tests/feed-cost-quality.test.mjs` pass completely.

## Owner, Supported Scope, and Limitations

- **Owner**: Economics and ecosystem sustainability workstream (Market Data & Platform teams).
- **Supported Scope**: Covers active production feeds across off-chain ingestion, aggregation, storage, and Soroban on-chain publication; computes unit economics and composite quality scores.
- **Limitations**:
  - Provider data API licensing costs reflect contracted subscription rates; volume overages are reconciled monthly.
  - Latency measurements represent aggregated transport and block inclusion delays under standard network conditions.

## Compatibility and Operational Impact

- **Compatibility**: Strictly additive analytics tool and documentation artifact. Does not alter runtime transaction execution, feed ingestion, or pricing consensus logic.
- **Operational Impact**: None on live oracle serving paths; model and verification run offline and within CI test pipelines without database locks or external network dependencies.

## Rollout and Rollback Guidance

- **Rollout**: Commit configuration manifest, calculation script, test suite, and generated markdown report.
- **Rollback**: Revert the commit; no schema migrations, database updates, or contract redeployments are required.
