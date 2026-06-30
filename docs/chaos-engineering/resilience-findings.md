# Resilience Findings

Tracked outcomes from chaos experiments. Update after each game day or automated weekly run.

## Open findings

| ID | Experiment | Finding | Severity | Status | Issue |
|----|------------|---------|----------|--------|-------|
| R-001 | pod-kill-api | Pending first run | — | open | — |
| R-002 | network-partition | Pending first run | — | open | — |
| R-003 | dns-failure | Pending first run | — | open | — |

## Resolved findings

| ID | Experiment | Finding | Resolution | Date |
|----|------------|---------|------------|------|
| — | — | — | — | — |

## SLO targets (staging)

| Metric | Target | Observed (last run) |
|--------|--------|---------------------|
| API health availability | ≥ 99.5% during experiment | — |
| Price staleness | < 120s after aggregator recovery | — |
| Pod recovery time | < 90s after pod-kill | — |
| WebSocket reconnect | < 30s p95 | — |

## Improvement backlog

- Add StatusCheck resources for automated pass/fail gates
- Wire chaos report ConfigMaps into Grafana annotations
- Tune aggregator `fetchWithBackoff` after packet-loss results
- Evaluate PDB minAvailable for API stable deployment

## Report archive

Weekly reports are stored as ConfigMaps named `chaos-report-YYYYMMDD` in `stellar-oracle`. Export with:

```bash
kubectl -n stellar-oracle get configmap -l chaos.stellar-oracle.io/report=weekly -o yaml
```

Or generate on demand:

```bash
export CHAOS_TARGET_ENV=staging
./scripts/chaos/generate-report.sh reports/latest.md
```
