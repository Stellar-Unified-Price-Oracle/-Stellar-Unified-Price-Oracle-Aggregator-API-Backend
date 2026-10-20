#!/usr/bin/env bash
set -euo pipefail

OUT="${1:-chaos-report-$(date -u +%Y%m%d).md}"
NS="${NAMESPACE:-stellar-oracle}"
ENV="${CHAOS_TARGET_ENV:-staging}"
# Machine-readable evidence consumed by the API DR status service.
JSON_OUT="${CHAOS_EVIDENCE_JSON:-${OUT%.md}.json}"
# Bounded exercise limits (blast radius / duration) enforced by the runner.
MAX_DURATION_SECONDS="${CHAOS_MAX_DURATION_SECONDS:-300}"
MAX_BLAST_RADIUS_PERCENT="${CHAOS_MAX_BLAST_RADIUS_PERCENT:-25}"
# SLO thresholds used to grade each dependency exercise.
SLO_RTO_SECONDS="${CHAOS_SLO_RTO_SECONDS:-120}"
SLO_ERROR_RATE_DELTA_PERCENT="${CHAOS_SLO_ERROR_RATE_DELTA_PERCENT:-5}"
SLO_RECOVERY_SECONDS="${CHAOS_SLO_RECOVERY_SECONDS:-180}"
# Dependencies exercised by the scheduled failure drills.
DEPENDENCIES=(database cache provider network)

if [[ "${ENV}" != "staging" ]]; then
  echo "ERROR: generate-report.sh only runs when CHAOS_TARGET_ENV=staging"
  exit 1
fi

if ! command -v kubectl >/dev/null 2>&1; then
  echo "ERROR: kubectl is required"
  exit 1
fi

# Emit a single dependency evidence record as JSON.
# Args: dependency name experiment duration blast_rto error_delta recovery
emit_evidence_json() {
  local dep="$1" experiment="$2" duration="$3" blast="$4" rto="$5" err_delta="$6" recovery="$7" result="$8"
  printf '{"dependency":"%s","experiment":"%s","durationSeconds":%s,"blastRadiusPercent":%s,"rtoSeconds":%s,"errorRateDeltaPercent":%s,"recoverySeconds":%s,"sloPass":%s}\n' \
    "${dep}" "${experiment}" "${duration:-0}" "${blast:-0}" "${rto:-0}" "${err_delta:-0}" "${recovery:-0}" "${result}"
}

# Collect dependency-specific exercise evidence from Chaos Mesh annotations.
# Experiments are expected to carry:
#   chaos.stellar.org/dependency, /duration-seconds, /blast-radius-percent,
#   /rto-seconds, /error-rate-delta-percent, /recovery-seconds
collect_dependency_evidence() {
  local dep="$1"
  local found=0
  for kind in "${experiments[@]}"; do
    while IFS='|' read -r name duration blast rto err_delta recovery; do
      [[ -z "${name}" ]] && continue
      found=1
      local result="true"
      if (( duration > MAX_DURATION_SECONDS )); then result="false"; fi
      if (( blast > MAX_BLAST_RADIUS_PERCENT )); then result="false"; fi
      if (( rto > SLO_RTO_SECONDS )); then result="false"; fi
      if (( recovery > SLO_RECOVERY_SECONDS )); then result="false"; fi
      # Compare error-rate delta as integer percent to avoid float math.
      if (( ${err_delta%.*} > SLO_ERROR_RATE_DELTA_PERCENT )); then result="false"; fi
      printf '%s|%s|%s|%s|%s|%s|%s|%s\n' \
        "${dep}" "${name}" "${duration}" "${blast}" "${rto}" "${err_delta}" "${recovery}" "${result}"
    done < <(kubectl -n "${NS}" get "${kind}" \
      -o jsonpath='{range .items[*]}{.metadata.name}|{.metadata.annotations.chaos\.stellar\.org/duration-seconds}|{.metadata.annotations.chaos\.stellar\.org/blast-radius-percent}|{.metadata.annotations.chaos\.stellar\.org/rto-seconds}|{.metadata.annotations.chaos\.stellar\.org/error-rate-delta-percent}|{.metadata.annotations.chaos\.stellar\.org/recovery-seconds}{"\n"}{end}' \
      2>/dev/null | while IFS='|' read -r n d b r e rec; do
        dep_ann="$(kubectl -n "${NS}" get "${kind}" "${n}" -o jsonpath='{.metadata.annotations.chaos\.stellar\.org/dependency}' 2>/dev/null || true)"
        if [[ "${dep_ann}" == "${dep}" ]]; then
          printf '%s|%s|%s|%s|%s|%s\n' "${n}" "${d}" "${b}" "${r}" "${e}" "${rec}"
        fi
      done)
  done
  if (( found == 0 )); then
    echo "_No ${dep} exercise evidence recorded_"
  fi
}

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
  echo "## Dependency exercise evidence"
  echo
  echo "Bounded limits: max duration ${MAX_DURATION_SECONDS}s, max blast radius ${MAX_BLAST_RADIUS_PERCENT}%."
  echo "SLOs: RTO <= ${SLO_RTO_SECONDS}s, error-rate delta <= ${SLO_ERROR_RATE_DELTA_PERCENT}%, recovery <= ${SLO_RECOVERY_SECONDS}s."
  echo
  for dep in "${DEPENDENCIES[@]}"; do
    echo "### ${dep}"
    echo
    echo "| Experiment | Duration (s) | Blast radius (%) | RTO (s) | Error-rate delta (%) | Recovery (s) | SLO |"
    echo "|------------|--------------|------------------|---------|----------------------|--------------|-----|"
    rows="$(collect_dependency_evidence "${dep}")"
    if [[ "${rows}" == _No* ]]; then
      echo "${rows}"
    else
      while IFS='|' read -r _ name duration blast rto err_delta recovery result; do
        [[ -z "${name}" ]] && continue
        verdict="PASS"
        [[ "${result}" == "false" ]] && verdict="FAIL"
        echo "| ${name} | ${duration} | ${blast} | ${rto} | ${err_delta} | ${recovery} | ${verdict} |"
      done <<< "${rows}"
    fi
    echo
  done
  echo "## Health checks"
  echo
  api_ready="$(kubectl -n "${NS}" get pods -l app=api -o jsonpath='{.items[*].status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || echo unknown)"
  agg_ready="$(kubectl -n "${NS}" get pods -l app=aggregator -o jsonpath='{.items[*].status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || echo unknown)"
  echo "- API pods Ready: ${api_ready:-none}"
  echo "- Aggregator pods Ready: ${agg_ready:-none}"
} > "${OUT}"

# Emit machine-readable recovery evidence for the API DR status service.
{
  echo "{"
  echo "  \"generatedAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
  echo "  \"namespace\": \"${NS}\","
  echo "  \"environment\": \"${ENV}\","
  echo "  \"limits\": {\"maxDurationSeconds\": ${MAX_DURATION_SECONDS}, \"maxBlastRadiusPercent\": ${MAX_BLAST_RADIUS_PERCENT}},"
  echo "  \"slos\": {\"rtoSeconds\": ${SLO_RTO_SECONDS}, \"errorRateDeltaPercent\": ${SLO_ERROR_RATE_DELTA_PERCENT}, \"recoverySeconds\": ${SLO_RECOVERY_SECONDS}},"
  echo "  \"dependencies\": ["
  first=1
  for dep in "${DEPENDENCIES[@]}"; do
    rows="$(collect_dependency_evidence "${dep}")"
    [[ "${rows}" == _No* ]] && continue
    while IFS='|' read -r d name duration blast rto err_delta recovery result; do
      [[ -z "${name}" ]] && continue
      if (( first == 0 )); then echo ","; fi
      first=0
      printf '    %s' "$(emit_evidence_json "${d}" "${name}" "${duration}" "${blast}" "${rto}" "${err_delta}" "${recovery}" "${result}")"
    done <<< "${rows}"
  done
  echo
  echo "  ]"
  echo "}"
} > "${JSON_OUT}"

echo "Report written to ${OUT}"
echo "Evidence written to ${JSON_OUT}"
