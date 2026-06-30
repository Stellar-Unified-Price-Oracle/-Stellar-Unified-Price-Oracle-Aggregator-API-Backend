# Chaos Engineering

Chaos engineering validates that the Stellar Unified Price Oracle remains available and correct under failure conditions. Experiments run in the **staging** Kubernetes namespace `stellar-oracle` using [Chaos Mesh](https://chaos-mesh.org/).

## Goals

- Confirm API and aggregator recover from pod termination
- Measure behavior under network latency, partition, and packet loss
- Validate oracle source fetch resilience when DNS or egress fails
- Detect resource exhaustion before it reaches production
- Produce weekly reports for continuous improvement

## Components

| Path | Purpose |
|------|---------|
| `k8s/chaos/experiments/` | Individual Chaos Mesh CRDs |
| `k8s/chaos/schedules/weekly-chaos-schedule.yaml` | Sunday 03:00 UTC serial workflow |
| `k8s/chaos/schedules/weekly-resilience-workflow.yaml` | Staging-guard CronJob |
| `k8s/chaos/reporting/report-cronjob.yaml` | Monday 08:00 UTC report |
| `scripts/chaos/install-chaos-mesh.sh` | Helm install (staging only) |
| `scripts/chaos/generate-report.sh` | On-demand report generator |

## Install

```bash
export CHAOS_TARGET_ENV=staging
./scripts/chaos/install-chaos-mesh.sh
```

## Experiments

| Experiment | Type | Target | Duration |
|------------|------|--------|----------|
| pod-kill-api | PodChaos | API pods | 2m |
| pod-kill-aggregator | PodChaos | Aggregator pods | 2m |
| network-latency | NetworkChaos | API → aggregator | 5m |
| network-partition | NetworkChaos | API ↔ aggregator | 3m |
| dns-failure | DNSChaos | Aggregator oracle DNS | 3m |
| packet-loss | NetworkChaos | Aggregator egress | 4m |
| cpu-stress | StressChaos | API pods | 5m |
| memory-stress | StressChaos | Aggregator pods | 5m |
| node-failure | PodChaos (pod-failure) | All stellar-oracle pods | 3m |

## Weekly schedule

Every **Sunday at 03:00 UTC**, the `weekly-chaos-schedule` Schedule runs all nine experiments **serially** via a Chaos Mesh Workflow. A companion CronJob at 03:05 UTC verifies the staging guard before confirming the schedule is active.

Every **Monday at 08:00 UTC**, the reporting CronJob collects experiment status and stores a ConfigMap snapshot.

## Alerting

Prometheus rules in `monitoring/prometheus-rules-chaos.yml` fire when experiments fail, workflows fail, staging guard CronJobs fail, or SLOs degrade during active chaos. Apply alongside `monitoring/prometheus-rules.yml`.

Alertmanager routes for chaos notifications are in `monitoring/alertmanager-chaos.yml` and `k8s/chaos/reporting/alertmanager-config.yaml`.

## Manual run

```bash
kubectl -n stellar-oracle annotate schedule weekly-chaos-schedule \
  chaos.stellar-oracle.io/manual-run="$(date -u +%Y-%m-%dT%H:%M:%SZ)" --overwrite
```

## Documentation

- [Game days](game-days.md) — planned chaos sessions
- [Incident review](incident-review.md) — post-experiment review template
- [Rollback](rollback.md) — abort and recovery steps
- [Resilience findings](resilience-findings.md) — tracked improvements

## Safety rules

1. Never set `CHAOS_TARGET_ENV` to anything other than `staging`.
2. Do not install Chaos Mesh with `clusterScoped: true`.
3. Abort immediately if production namespaces are affected.
4. Review [rollback.md](rollback.md) before every game day.
