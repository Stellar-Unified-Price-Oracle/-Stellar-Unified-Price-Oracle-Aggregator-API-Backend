# Regional and Feed Unit Economics (Issue #795)

Comparable cost and margin measures by region and by feed for 2026-10, including
shared infrastructure allocation and its uncertainty. Generated from `config/unit-economics.json`,
`config/feed-cost-quality.json` and `config/sustainability-model.json` by `npm run unit-economics`;
do not edit by hand.

- **Owner**: Economics and ecosystem sustainability workstream (Platform FinOps + Market Data)
- **Last updated**: 2026-11-19 · **Review interval**: 30 days · **Next review**: 2026-12-19

## Cost pool

| Component | Monthly cost | Notes |
| :--- | ---: | :--- |
| Regional direct (compute, storage, egress) | $80.51 | Attributed to the region that incurs it |
| Feed direct (provider ingestion, on-chain gas and rent) | $246.16 | Attributed to the feed that incurs it |
| Shared infrastructure | $118.00 | Allocated by key, see below |
| **Total** | **$444.67** | Both views below attribute exactly this total |

Revenue: $13,650.00 per month across 22,550,000 requests (config/sustainability-model.json (calculateRevenue, baseline demand)).
Regions by the consumer's billing home region; feeds by share of requests served.

Feed direct cost uses only feed-specific components from `feed-cost-quality.json`; that file's
aggregation-compute and storage figures are already inside the regional compute and storage, so
they are left out here to avoid counting them twice.

## Shared infrastructure allocation

| Shared cost | Amount | Error band | Region key | Feed key |
| :--- | ---: | ---: | :--- | :--- |
| Kubernetes control plane | $73.00 | ±12% | vcpu (range over requests, even) | submissions (range over requests, even) |
| Observability and tooling | $45.00 | ±10% | requests (range over vcpu, even) | requests (range over submissions, even) |
| Feed direct costs → regions | $246.16 | per component | requests (range over even) | — |
| Regional direct costs → feeds | $80.51 | per component | — | requests (range over submissions) |

**Uncertainty method.** Direct costs carry their own error band. For each allocated cost, the
low case takes the low end of the amount band times the smallest share any listed key would
assign, and the high case takes the high end times the largest share. Ranges are therefore
conservative: the low cases across regions do not sum to the pool's low case.

## Regions

| Region | Revenue | Cost (low – high) | Margin (low – high) | Margin % (low – high) | Requests | Cost / 1M requests (low – high) |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| `us-east-1` | $7,098.00 | $200.82 ($133.44 – $233.22) | $6,897.18 ($6,864.78 – $6,964.56) | 97.17% (96.71% – 98.12%) | 11,275,000 | $17.81 ($11.84 – $20.68) |
| `eu-west-1` | $4,095.00 | $143.10 ($127.26 – $163.16) | $3,951.90 ($3,931.84 – $3,967.74) | 96.51% (96.02% – 96.89%) | 7,216,000 | $19.83 ($17.64 – $22.61) |
| `ap-southeast-1` | $2,457.00 | $100.75 ($82.81 – $163.85) | $2,356.25 ($2,293.15 – $2,374.19) | 95.9% (93.33% – 96.63%) | 4,059,000 | $24.82 ($20.40 – $40.37) |

| Cost item | `us-east-1` | `eu-west-1` | `ap-southeast-1` |
| :--- | ---: | ---: | ---: |
| compute *(direct)* | $25.20 | $23.32 | $23.19 |
| storage *(direct)* | $1.70 | $1.79 | $1.96 |
| egress *(direct)* | $1.10 | $0.85 | $1.40 |
| feed direct costs (allocated) *(cross)* | $123.08 | $78.77 | $44.31 |
| Kubernetes control plane *(shared)* | $27.24 | $23.97 | $21.79 |
| Observability and tooling *(shared)* | $22.50 | $14.40 | $8.10 |
| **Total (point)** | **$200.82** | **$143.10** | **$100.75** |

## Feeds

| Feed | Pair | Cadence | Revenue | Cost (low – high) | Margin (low – high) | Margin % (low – high) | Cost / 1M requests | Cost / 1k submissions |
| :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `xlm-usd` | XLM/USD | 30s | $4,095.00 | $86.94 ($61.26 – $107.54) | $4,008.06 ($3,987.46 – $4,033.74) | 97.88% (97.37% – 98.5%) | $12.85 | $1.01 |
| `usdc-usd` | USDC/USD | 30s | $3,003.00 | $76.90 ($61.26 – $90.25) | $2,926.10 ($2,912.75 – $2,941.74) | 97.44% (96.99% – 97.96%) | $15.50 | $0.89 |
| `btc-usd` | BTC/USD | 15s | $2,730.00 | $122.69 ($102.11 – $150.85) | $2,607.31 ($2,579.15 – $2,627.89) | 95.51% (94.47% – 96.26%) | $27.20 | $0.71 |
| `eth-usd` | ETH/USD | 20s | $2,457.00 | $96.29 ($82.48 – $113.66) | $2,360.71 ($2,343.34 – $2,374.52) | 96.08% (95.37% – 96.64%) | $23.72 | $0.74 |
| `usdt-usd` | USDT/USD | 30s | $1,365.00 | $61.84 ($51.52 – $82.00) | $1,303.16 ($1,283.00 – $1,313.48) | 95.47% (93.99% – 96.23%) | $27.42 | $0.72 |

| Cost item | `xlm-usd` | `usdc-usd` | `btc-usd` | `eth-usd` | `usdt-usd` |
| :--- | ---: | ---: | ---: | ---: | ---: |
| provider ingestion *(direct)* | $24.50 | $24.50 | $48.00 | $36.50 | $24.50 |
| on-chain gas and rent *(direct)* | $13.56 | $13.56 | $27.13 | $20.35 | $13.56 |
| regional direct costs (allocated) *(cross)* | $24.15 | $17.71 | $16.10 | $14.49 | $8.05 |
| Kubernetes control plane *(shared)* | $11.23 | $11.23 | $22.46 | $16.85 | $11.23 |
| Observability and tooling *(shared)* | $13.50 | $9.90 | $9.00 | $8.10 | $4.50 |
| **Total (point)** | **$86.94** | **$76.90** | **$122.69** | **$96.29** | **$61.84** |

## Reading the measures

- **Cost per 1M requests** compares regions and feeds of different size on one scale.
- **Cost per 1k submissions** compares feeds by on-chain publishing efficiency, independent of demand.
- **Margin %** is contribution margin over infrastructure, data and network costs only. Staff and
  overhead are not included.
- When two entities' margin ranges overlap, the data does not support ranking one above the
  other; tighten the allocation keys or error bands before acting on the difference.

## Review procedure and completion evidence

`npm run unit-economics:check` (run in CI) fails when shares do not sum to 1, the feeds here and in
`feed-cost-quality.json` diverge, an allocation key is unknown, either view fails to attribute
exactly the cost pool, a low-case margin falls below the 80% floor, or this document is
stale. `scripts/tests/unit-economics.test.mjs` covers conservation across both views, range
ordering, single-key and zero-band boundaries, and invalid inputs.

Monthly: update regional direct costs from the invoice split and request shares from usage
metrics, then regenerate.

## Compatibility, monitoring and operational impact

- **Compatibility**: Additive. Reads `feed-cost-quality.json` and `sustainability-model.json`
  without changing them and reuses `calculateRevenue` from `scripts/sustainability-model.mjs`, so
  revenue cannot drift from the sustainability model.
- **Monitoring**: Inputs come from the existing cost reconciliation (`npm run cost:reconcile`) and
  per-region request metrics. A margin-floor failure is the signal to review regional pricing or
  feed cadence.
- **Operational impact**: None. Offline report; no runtime service reads these files.

## Rollout and rollback

- **Rollout**: Merge, then refresh inputs monthly as above.
- **Rollback**: Revert the commit. Nothing at runtime depends on it.
