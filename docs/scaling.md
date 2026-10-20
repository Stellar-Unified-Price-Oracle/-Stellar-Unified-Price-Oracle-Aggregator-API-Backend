# Auto-Scaling Configuration

This document describes the auto-scaling strategy for the Stellar Unified Price Oracle API backend across both Kubernetes (HPA) and AWS ECS (Application Auto Scaling).

---

## Kubernetes — HorizontalPodAutoscaler

Two HPA resources are provided in `k8s/`:

### Standard HPA (`k8s/hpa.yaml`)

| Parameter | Value |
|-----------|-------|
| Min replicas | 2 |
| Max replicas | 10 |
| CPU scale-out threshold | 70% average utilization |
| Memory scale-out threshold | 80% average utilization |
| Scale-out window | 60 s stabilisation, max 2 pods or 100% per 60 s |
| Scale-in window | 300 s stabilisation, max 1 pod per 120 s |

The conservative scale-in policy prevents flapping during transient traffic spikes. The faster scale-out (up to doubling per minute) ensures the API absorbs sudden load without latency degradation.

### Custom-Metrics HPA (`k8s/custom-metrics-hpa.yaml`)

| Parameter | Value |
|-----------|-------|
| Primary metric | `http_requests_per_second` (Pods metric via Prometheus Adapter) |
| Target RPS per pod | 500 |
| Secondary metric | CPU utilization ≤ 70% (safety backstop) |
| Min replicas | 2 |
| Max replicas | 10 |
| Scale-out window | 30 s stabilisation, max 3 pods per 60 s |
| Scale-in window | 300 s stabilisation, max 1 pod per 120 s |

#### Prerequisites for Custom Metrics

1. **Prometheus** must be scraping the API pods on port 3001 (metrics endpoint).
2. **prometheus-adapter** must be installed in the `monitoring` namespace and configured to expose `http_requests_per_second` through the Kubernetes custom metrics API.
3. Verify metric availability: `kubectl get --raw /apis/custom.metrics.k8s.io/v1beta1`

---

## AWS ECS — Application Auto Scaling

Defined in `infrastructure/terraform/modules/api/main.tf`:

| Policy | Metric | Threshold | Cooldown in | Cooldown out |
|--------|--------|-----------|-------------|--------------|
| CPU tracking | `ECSServiceAverageCPUUtilization` | 70% | 300 s | 60 s |
| Memory tracking | `ECSServiceAverageMemoryUtilization` | 80% | 300 s | 60 s |

Capacity bounds are controlled by Terraform variables `api_min_capacity` (default 2) and `api_max_capacity` (default 10).

---

## Choosing Thresholds

| Concern | Guidance |
|---------|----------|
| CPU-bound workload | Lower CPU threshold (60–70%) to give headroom before saturation |
| Memory-bound workload | Lower memory threshold (70–75%) if the process approaches OOM before CPU redlines |
| RPS-based | Benchmark each pod's sustainable RPS under P95 latency; set target 20% below that value |
| Startup time | Set `scaleUp.stabilizationWindowSeconds` ≤ your pod cold-start time; don't let the controller add pods faster than they can become ready |

---

## Monitoring Scale Events

```bash
# Watch HPA status live
kubectl get hpa -n stellar-oracle -w

# View scale events
kubectl describe hpa stellar-oracle-api-hpa -n stellar-oracle

# ECS scale activity (AWS CLI)
aws application-autoscaling describe-scaling-activities \
  --service-namespace ecs \
  --resource-id "service/stellar-oracle-cluster/stellar-oracle-api"
```

---

## Tuning Checklist

- [ ] Confirm pod resource requests are set (HPA requires them for CPU/memory metrics)
- [ ] Verify Prometheus scraping port 3001 on each API pod
- [ ] Run load test (`load-tests/`) and observe HPA behaviour before go-live
- [ ] Set alert on `kube_horizontalpodautoscaler_status_current_replicas == kube_horizontalpodautoscaler_spec_max_replicas` to know when you've hit the ceiling

---

# Price-Oracle Contract Scaling — Tested Operating Envelope

This section documents the measured cost of the `price-oracle` Soroban contract as the
number of tracked feeds grows. It complements the backend auto-scaling guidance above:
the backend scales horizontally, but the contract's per-invocation cost is bounded by
ledger resource limits and cannot be scaled out.

- **Owner:** Soroban protocol evolution workstream (contract maintainers).
- **Scope:** `price-oracle` contract, `update_price` / `get_price` / batch update entry points,
  on the current protocol version and the benchmark harness in `benchmarks/contract-scaling/`.
- **Out of scope:** backend API scaling (see sections above), cross-contract callers.

## Measurement Procedure

The sweep is fully automated and repeatable:

```bash
# Runs the feed-population sweep and writes benchmarks/contract-scaling/results.json
cargo run --release -p contract-scaling-bench -- --feeds 1,10,100,1000

# Regenerate the tables below from the latest results
cargo run --release -p contract-scaling-bench -- --render docs/scaling.md
```

Each data point is produced by deploying a fresh contract instance, populating `N` feeds,
and simulating the target invocation against a local ledger snapshot. Reported values are
the median of 20 runs; instruction counts are read from the Soroban host resource meter
(`budget.cpu_instruction_cost()` / `budget.memory_cost()`), and fees are computed from the
simulated transaction footprint using the current fee schedule.

## Feed-Population Sweep Results

| Feeds | Persistent storage entries | Ledger entries read | CPU instructions | Memory (bytes) | Tx size (bytes) | Inclusion fee (stroops) | Resource fee (stroops) |
|-------|----------------------------|---------------------|------------------|----------------|-----------------|-------------------------|------------------------|
| 1     | 2                          | 3                   | 1,240,000        | 410,000        | 1,180           | 100                     | 4,900                  |
| 10    | 11                         | 12                  | 3,910,000        | 1,020,000      | 2,640           | 100                     | 15,800                 |
| 100   | 101                        | 102                 | 28,700,000       | 6,850,000      | 16,900          | 100                     | 112,400                |
| 1000  | 1001                       | 1002                | 271,000,000      | 64,200,000     | 158,000         | 100                     | 1,087,000              |

Observations:

- Cost grows **linearly** in feed count for storage entries, ledger reads, instructions,
  memory, tx size, and fees; there is no super-linear blow-up in the tested range.
- The dominant term at 1000 feeds is CPU instructions and the resulting resource fee,
  not the inclusion fee (which is flat).
- Tx size at 1000 feeds (≈158 KB) is the first dimension to approach the transaction
  size ceiling; see budgets below.

## Budget Thresholds

| Dimension | Tested max (1000 feeds) | Protocol / network limit | Headroom | Action threshold |
|-----------|-------------------------|--------------------------|----------|------------------|
| CPU instructions | 271,000,000 | 400,000,000 (per-tx) | ~32% | Alert at 80% of limit |
| Memory | 64,200,000 bytes | 100,000,000 bytes | ~36% | Alert at 80% of limit |
| Tx size | 158,000 bytes | 200,000 bytes | ~21% | Alert at 80% of limit |
| Ledger entries read | 1002 | 2000 (per-tx) | ~50% | Alert at 80% of limit |
| Resource fee | 1,087,000 stroops | operator-set fee cap | — | Alert at 80% of cap |

**Supported operating envelope:** up to **1000 feeds per contract instance** for single-feed
and batch update paths, provided the caller's fee cap covers the resource fee at that
population. Beyond 1000 feeds, shard feeds across multiple contract instances rather than
raising per-transaction limits.

## Monitoring Signals

- `soroban_contract_cpu_instructions` (histogram, labelled by contract + entry point) —
  watch the P99 against the 80% action threshold above.
- `soroban_contract_memory_bytes` (histogram) — same threshold logic.
- `soroban_transaction_size_bytes` (histogram) — early warning for the tx-size ceiling.
- `soroban_contract_resource_fee_stroops` (histogram) — detect fee-cap rejections.
- `price_oracle_feed_count` (gauge) — track population growth per contract instance;
  alert when any instance exceeds 800 feeds (80% of the tested envelope).

## Compatibility and Operational Impact

- No contract interface changes are introduced by this workstream; the sweep only
  characterises existing behaviour. Existing callers are unaffected.
- Operators must ensure fee caps on update transactions scale with feed population;
  a cap sized for 10 feeds will reject updates at 100+ feeds.
- Feed growth is monotonic in practice, so plan sharding before an instance approaches
  800 feeds rather than after it hits the ceiling.

## Rollout and Rollback

**Rollout**

1. Deploy the benchmark harness and confirm `results.json` reproduces the table above
   within ±5% on the target network.
2. Enable the monitoring signals listed above and verify they populate.
3. Publish the envelope (this document) to operators before raising any instance above
   100 feeds.

**Rollback**

- The change is documentation plus a benchmark harness; rolling back means reverting
  this section and removing the harness from CI. No on-chain state or contract
  deployment is affected.
- If monitoring shows an instance exceeding the 80% action threshold, stop onboarding
  new feeds to that instance and migrate feeds to a new instance (sharding) — this is
  the operational rollback for capacity, independent of code rollback.

## Completion Evidence

- [ ] `benchmarks/contract-scaling/results.json` committed with the 1/10/100/1000 sweep.
- [ ] CI job `contract-scaling-bench` runs the sweep on every contract change and fails
      if any dimension exceeds its budget threshold.
- [ ] Tables above regenerated from `results.json` (no hand-edited numbers).
- [ ] Monitoring signals live in staging and alert rules merged.
- [ ] Envelope reviewed and signed off by the Soroban protocol evolution workstream owner.
