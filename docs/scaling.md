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
