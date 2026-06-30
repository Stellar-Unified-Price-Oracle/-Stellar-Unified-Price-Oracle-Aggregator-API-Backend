#!/usr/bin/env bash
set -euo pipefail

OUT="${1:-chaos-report-$(date -u +%Y%m%d).md}"
NS="${NAMESPACE:-stellar-oracle}"
ENV="${CHAOS_TARGET_ENV:-staging}"

if [[ "${ENV}" != "staging" ]]; then
  echo "ERROR: generate-report.sh only runs when CHAOS_TARGET_ENV=staging"
  exit 1
fi

if ! command -v kubectl >/dev/null 2>&1; then
  echo "ERROR: kubectl is required"
  exit 1
fi

experiments=(
  podchaos
  networkchaos
  stresschaos
  dnschaos
)

{
  echo "# Stellar Oracle Chaos Engineering Report"
  echo
  echo "| Field | Value |"
  echo "|-------|-------|"
  echo "| Generated (UTC) | $(date -u +%Y-%m-%dT%H:%M:%SZ) |"
  echo "| Namespace | ${NS} |"
  echo "| Environment | ${ENV} |"
  echo
  echo "## Summary"
  echo
  for kind in "${experiments[@]}"; do
    count="$(kubectl -n "${NS}" get "${kind}" --no-headers 2>/dev/null | wc -l | tr -d ' ')"
    echo "- **${kind}**: ${count} resource(s)"
  done
  echo
  echo "## Experiment phases"
  echo
  for kind in "${experiments[@]}"; do
    echo "### ${kind}"
    if kubectl -n "${NS}" get "${kind}" >/dev/null 2>&1; then
      kubectl -n "${NS}" get "${kind}" \
        -o custom-columns='NAME:.metadata.name,PHASE:.status.experiment.phase,START:.status.experiment.startTime,END:.status.experiment.endTime' \
        2>/dev/null || echo "_No resources_"
    else
      echo "_CRD not installed or no resources_"
    fi
    echo
  done
  echo "## Workflows"
  echo
  kubectl -n "${NS}" get workflows.chaos-mesh.org \
    -o custom-columns='NAME:.metadata.name,ENTRY:.status.entryNode,PHASE:.status.phase,AGE:.metadata.creationTimestamp' \
    2>/dev/null | tail -n +1 || echo "_No workflows_"
  echo
  echo "## Schedules"
  echo
  kubectl -n "${NS}" get schedules.chaos-mesh.org \
    -o custom-columns='NAME:.metadata.name,SCHEDULE:.spec.schedule,NEXT:.status.nextScheduledTime' \
    2>/dev/null || echo "_No schedules_"
  echo
  echo "## Recent events"
  echo
  echo '```'
  kubectl -n "${NS}" get events --sort-by=.lastTimestamp 2>/dev/null | tail -30 || true
  echo '```'
  echo
  echo "## Health checks"
  echo
  api_ready="$(kubectl -n "${NS}" get pods -l app=api -o jsonpath='{.items[*].status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || echo unknown)"
  agg_ready="$(kubectl -n "${NS}" get pods -l app=aggregator -o jsonpath='{.items[*].status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || echo unknown)"
  echo "- API pods Ready: ${api_ready:-none}"
  echo "- Aggregator pods Ready: ${agg_ready:-none}"
} > "${OUT}"

echo "Report written to ${OUT}"
