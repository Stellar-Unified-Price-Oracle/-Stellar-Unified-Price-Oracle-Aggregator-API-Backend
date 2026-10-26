# Post-GA Sustainability Model (Issue #786)

This document specifies the post-GA economic and ecosystem sustainability model for the
Stellar Unified Price Oracle Aggregator API Backend. It models consumer revenue,
operating cost structures, reserve requirements, and sensitivity ranges across expected demand.

## Executive Summary & Financial Baseline

| Metric | Monthly (Baseline) | Annualized (Baseline) | Notes |
| :--- | ---: | ---: | :--- |
| **Gross Revenue** | $13,650.00 | $163,800.00 | Base subscriptions + metered overages |
| **Operating Cost (OpEx)** | $296.93 | $3,563.16 | Infrastructure, storage, gas, providers |
| **Net Operating Margin** | $13,353.07 | $160,236.84 | **97.8%** gross operating margin |
| **Capital Reserve Requirement** | $4,273.23 | — | **6 months** operational buffer + contingency |

The oracle service operates with a healthy sustainable margin under baseline demand,
generating positive operating cash flow while fully absorbing Soroban on-chain publication gas,
high-frequency provider data licensing, and multi-region infrastructure spend.

## Revenue Model by Consumer Tier

Revenues follow the access tier definitions documented in `docs/fee-schedule.md` and `docs/rate-limit-tiers.md`:

| Tier | Active Keys | Req / Key (Mo) | Base Revenue | Overage Revenue | Total Monthly Revenue |
| :--- | ---: | ---: | ---: | ---: | ---: |
| **Free** | 120 | 15,000 | $0.00 | $0.00 | $0.00 |
| **Pro** | 35 | 250,000 | $4,200.00 | $1,050.00 | $5,250.00 |
| **Enterprise** | 6 | 2,000,000 | $7,500.00 | $900.00 | $8,400.00 |
| **Total** | — | — | — | — | **$13,650.00** |

## Operating Cost Structure (Off-Chain & On-Chain)

Cost modeling harmonizes Kubernetes infrastructure requested allocations (`config/cost-model.json`),
on-chain Soroban submission benchmarks (`docs/GAS_COST_MODEL.md`), and data procurement:

| Cost Component | Monthly Cost (USD) | Share (%) | Driver & Accounting Reference |
| :--- | ---: | ---: | :--- |
| **Kubernetes Compute** | $25.20 | 8.5% | 8 replicas (API & Aggregator) per `config/cost-model.json` |
| **TimescaleDB Storage** | $8.91 | 3.0% | 10 GiB PVC storage and hypertable chunk retention |
| **On-Chain Soroban Gas & TTL** | $67.82 | 22.8% | 432,000 sub/mo (5 assets @ 30s) + 500 XLM rent/TTL renewal |
| **External Data Providers** | $150.00 | 50.5% | Real-time exchange websocket & REST data licensing |
| **Observability & Tooling** | $45.00 | 15.2% | Prometheus metrics, Sentry error telemetry, alerts |
| **Total Operating Cost** | **$296.93** | **100.0%** | Reconciles via `npm run cost:reconcile` |

## Reserve Requirements & Capital Buffer Policy

To guarantee uninterrupted oracle availability during network disruptions, volatile market periods, or billing settlement delays, the service maintains a mandatory multi-layer capital reserve:

| Reserve Layer | Policy Requirement | Modeled Amount (USD) | Purpose & Trigger |
| :--- | :--- | ---: | :--- |
| **Base OpEx Reserve** | 6 months operating expenses | $1,781.58 | Guarantees operational runway during billing cycles |
| **OpEx Safety Buffer** | 50% safety margin on OpEx | $890.79 | Absorbs unforeseen cloud price or bandwidth increases |
| **On-Chain Gas Buffer** | 10,000 XLM reserve balance | $1,200.00 | Prevents transaction eviction or TTL expiry on Soroban |
| **Contingency Reserve** | 15% of total capital reserve | $400.86 | Emergency disaster recovery failover fund |
| **Total Capital Reserve** | **Target Capital Buffer** | **$4,273.23** | **Minimum liquidity balance maintained by treasury** |

## Demand Sensitivity & Scenario Modeling

The model projects viability across six sensitivity scenarios reflecting market conditions and developer adoption rates:

| Scenario | Demand Mult | Monthly Revenue | Monthly OpEx | Net Margin (Mo) | Gross Margin | Capital Runway |
| :--- | :---: | ---: | ---: | ---: | ---: | :---: |
| **Trough (Low Activity)** | 0.50x | $11,875.00 | $296.93 | $11,578.07 | 97.5% | 14.4 mo |
| **Conservative** | 0.75x | $12,762.50 | $296.93 | $12,465.57 | 97.7% | 14.4 mo |
| **Baseline (Expected)** | 1.00x | $13,650.00 | $296.93 | $13,353.07 | 97.8% | 14.4 mo |
| **Growth (Adoption)** | 1.50x | $15,425.00 | $305.17 | $15,119.83 | 98% | 14.3 mo |
| **Surge (High Volatility)**| 3.00x | $20,750.00 | $329.88 | $20,420.12 | 98.4% | 14 mo |
| **Stress (Peak Demand)** | 5.00x | $27,850.00 | $362.82 | $27,487.18 | 98.7% | 13.7 mo |

### Key Observations
1. **Breakeven Resiliency**: Even under the severe `trough` scenario (50% contraction), revenues exceed operational expenses.
2. **Margin Expansion**: Operating leverage is high; compute costs increase sub-linearly with traffic due to Redis L1/L2 caching.
3. **Runway Stability**: Required reserves scale with cost, guaranteeing 6+ months of operating runway under all modeled demand profiles.

## Key Assumptions and Review Cadence

### Assumptions
- **XLM/USD Valuation**: Baseline assumption of $0.12/XLM for gas and rent calculation; model updates automatically upon parameter refresh.
- **Cache Hit Ratio**: 85% cache hit ratio at API layer, filtering repetitive requests before reaching backend database.
- **On-chain Cadence**: 5 tracked core assets with 30-second submission intervals = 432,000 monthly transactions.
- **Invoice Reconciliations**: 30-day billing settlement lag buffered by operational cash reserves.

### Review Cadence
- **Monthly**: Operational cost reconciliation via `npm run cost:reconcile` and invoice verification.
- **Quarterly**: Sustainability review by the **Economics and ecosystem sustainability** to evaluate subscription tier growth and reserve health.
- **Annual**: Contract fee schedule and provider licensing review.
- **Next Scheduled Review Date**: **2026-11-15**.

## Owner, Supported Scope, and Evidence

- **Owner**: economics-sustainability-team (Economics and ecosystem sustainability workstream).
- **Supported Scope**: Post-GA economic sustainability modeling, covering tier-based consumer revenue, hybrid infrastructure & Soroban cost structures, reserve thresholds, and multi-scenario demand sensitivity.
- **Completion Evidence**:
  - Deterministic model engine implemented in `scripts/sustainability-model.mjs`.
  - Config parameters centralized in `config/sustainability-model.json`.
  - Automated verification suite in `scripts/tests/sustainability-model.test.mjs` asserting normal, boundary, and error cases.

## Compatibility, Monitoring, and Operational Impact

- **Compatibility**: Non-breaking additive model; consumes existing metrics from `config/cost-model.json`, `docs/GAS_COST_MODEL.md`, and `docs/fee-schedule.md`.
- **Monitoring**: Key metrics (`runway_months, gross_margin_percent, operating_reserve_usd, soroban_gas_burn_usd, breakeven_requests_monthly`) exported to Prometheus and audited against quarterly treasury benchmarks.
- **Operational Impact**: None on live traffic path; model runs offline or in CI validation suites without database locks or latency overhead.

## Rollout and Rollback Guidance

- **Rollout**: Commit model configuration and engine script; integrate `npm run sustainability:check` into standard CI sanity checks.
- **Rollback**: Revert configuration and script commits; no state migrations or on-chain contract upgrades required.
