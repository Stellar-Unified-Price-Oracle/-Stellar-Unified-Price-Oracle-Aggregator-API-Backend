#!/usr/bin/env bash
#
# scripts/maintenance-window.sh
#
# Guarded orchestrator for planned regional maintenance windows.
#
# Workflow:
#   1. Prechecks        (health, replication lag, quorum)
#   2. Drain traffic    (feature flags / load balancer)
#   3. Fence publishers (region quarantine)
#   4. Maintenance      (operator-supplied command)
#   5. Validate         (health, price freshness, replication catch-up)
#   6. Unfence          (region unquarantine)
#   7. Restore traffic  (feature flags / load balancer)
#
# Owner: Global Operations & Resilience (see docs/operations/maintenance-window.md)
#
# Exit codes:
#   0  Success - maintenance completed and region restored
#   1  Usage / configuration error
#   2  Precheck failure (nothing was changed)
#   3  Traffic drain failure
#   4  Publisher fencing failure
#   5  Maintenance command failure (region left fenced & drained)
#   6  Post-maintenance validation failure (region left fenced & drained)
#   7  Unfence failure
#   8  Traffic restore failure
#   9  Rollback performed after a mid-flight failure
#  10  Interrupted (signal received)
#
# Safety: on any failure after the drain step, the script attempts a best-effort
# rollback (unfence + restore traffic) unless --keep-fenced is supplied.
#
# See docs/operations/maintenance-window.md for rollout and rollback guidance.

set -Eeuo pipefail

# ---------------------------------------------------------------------------
# Defaults / configuration (all overridable via environment)
# ---------------------------------------------------------------------------
SCRIPT_NAME="$(basename "$0")"
REGION="${REGION:-}"
CELL="${CELL:-}"
MAINTENANCE_CMD="${MAINTENANCE_CMD:-}"
LOG_FILE="${LOG_FILE:-}"
DRY_RUN="${DRY_RUN:-0}"
KEEP_FENCED="${KEEP_FENCED:-0}"

# Thresholds
MAX_REPLICATION_LAG_SECONDS="${MAX_REPLICATION_LAG_SECONDS:-30}"
MAX_PRICE_STALENESS_SECONDS="${MAX_PRICE_STALENESS_SECONDS:-120}"
MIN_QUORUM_NODES="${MIN_QUORUM_NODES:-2}"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-60}"
REPLICATION_CATCHUP_TIMEOUT_SECONDS="${REPLICATION_CATCHUP_TIMEOUT_SECONDS:-300}"
POLL_INTERVAL_SECONDS="${POLL_INTERVAL_SECONDS:-5}"

# Control-plane hooks. Each is a command template; the orchestrator appends
# region/cell arguments. Override these to match your environment.
HEALTH_CHECK_CMD="${HEALTH_CHECK_CMD:-health-check --region}"
REPLICATION_LAG_CMD="${REPLICATION_LAG_CMD:-replication-lag --region}"
QUORUM_STATUS_CMD="${QUORUM_STATUS_CMD:-quorum-status --region}"
DRAIN_TRAFFIC_CMD="${DRAIN_TRAFFIC_CMD:-traffic-drain --region}"
RESTORE_TRAFFIC_CMD="${RESTORE_TRAFFIC_CMD:-traffic-restore --region}"
FENCE_PUBLISHERS_CMD="${FENCE_PUBLISHERS_CMD:-region-quarantine --region}"
UNFENCE_PUBLISHERS_CMD="${UNFENCE_PUBLISHERS_CMD:-region-unquarantine --region}"
PRICE_FRESHNESS_CMD="${PRICE_FRESHNESS_CMD:-price-freshness --region}"

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
log() {
  local level="$1"; shift
  local ts
  ts="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  local line="[${ts}] [${level}] [${SCRIPT_NAME}] $*"
  printf '%s\n' "${line}" >&2
  if [[ -n "${LOG_FILE}" ]]; then
    printf '%s\n' "${line}" >>"${LOG_FILE}"
  fi
}

info()  { log INFO  "$@"; }
warn()  { log WARN  "$@"; }
error() { log ERROR "$@"; }

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
usage() {
  cat <<EOF
Usage: ${SCRIPT_NAME} --region <region> [options]

Guarded regional maintenance-window orchestrator.

Required:
  --region <region>            Region to place into maintenance
  --maintenance-cmd <cmd>      Shell command performing the maintenance work

Options:
  --cell <cell>                Optional cell identifier within the region
  --max-lag <seconds>          Max allowed replication lag (default: ${MAX_REPLICATION_LAG_SECONDS})
  --max-staleness <seconds>    Max allowed price staleness (default: ${MAX_PRICE_STALENESS_SECONDS})
  --min-quorum <n>             Minimum healthy quorum nodes (default: ${MIN_QUORUM_NODES})
  --log-file <path>            Append structured logs to this file
  --dry-run                    Print planned actions without executing them
  --keep-fenced                Do not auto-rollback on failure (leave fenced)
  -h, --help                   Show this help

Exit codes: see header of this script.
EOF
}

die() {
  local code="$1"; shift
  error "$*"
  exit "${code}"
}

# Run a control-plane hook. In dry-run mode, only log the command.
run_hook() {
  local description="$1"; shift
  local cmd="$1"; shift
  # shellcheck disable=SC2086
  local full_cmd="${cmd} $*"
  if [[ "${DRY_RUN}" == "1" ]]; then
    info "[dry-run] would run (${description}): ${full_cmd}"
    return 0
  fi
  info "running (${description}): ${full_cmd}"
  # shellcheck disable=SC2086
  if ! ${full_cmd}; then
    error "hook failed (${description}): ${full_cmd}"
    return 1
  fi
  return 0
}

# Capture stdout of a hook (used for numeric checks).
capture_hook() {
  local description="$1"; shift
  local cmd="$1"; shift
  # shellcheck disable=SC2086
  local full_cmd="${cmd} $*"
  if [[ "${DRY_RUN}" == "1" ]]; then
    info "[dry-run] would capture (${description}): ${full_cmd}"
    printf '0\n'
    return 0
  fi
  info "querying (${description}): ${full_cmd}"
  # shellcheck disable=SC2086
  ${full_cmd}
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --region)          REGION="${2:-}"; shift 2 ;;
      --cell)            CELL="${2:-}"; shift 2 ;;
      --maintenance-cmd) MAINTENANCE_CMD="${2:-}"; shift 2 ;;
      --max-lag)         MAX_REPLICATION_LAG_SECONDS="${2:-}"; shift 2 ;;
      --max-staleness)   MAX_PRICE_STALENESS_SECONDS="${2:-}"; shift 2 ;;
      --min-quorum)      MIN_QUORUM_NODES="${2:-}"; shift 2 ;;
      --log-file)        LOG_FILE="${2:-}"; shift 2 ;;
      --dry-run)         DRY_RUN=1; shift ;;
      --keep-fenced)     KEEP_FENCED=1; shift ;;
      -h|--help)         usage; exit 0 ;;
      *) usage; die 1 "unknown argument: $1" ;;
    esac
  done

  [[ -n "${REGION}" ]] || { usage; die 1 "--region is required"; }
  [[ -n "${MAINTENANCE_CMD}" ]] || { usage; die 1 "--maintenance-cmd is required"; }

  for v in MAX_REPLICATION_LAG_SECONDS MAX_PRICE_STALENESS_SECONDS MIN_QUORUM_NODES; do
    [[ "${!v}" =~ ^[0-9]+$ ]] || die 1 "${v} must be a non-negative integer (got: ${!v})"
  done
}

# ---------------------------------------------------------------------------
# State tracking for rollback
# ---------------------------------------------------------------------------
DRAINED=0
FENCED=0

rollback() {
  local reason="$1"
  warn "rollback triggered: ${reason}"
  if [[ "${KEEP_FENCED}" == "1" ]]; then
    warn "--keep-fenced set; leaving region ${REGION} fenced/drained for manual recovery"
    return 0
  fi
  if [[ "${FENCED}" == "1" ]]; then
    if run_hook "unfence publishers" "${UNFENCE_PUBLISHERS_CMD}" "${REGION}"; then
      FENCED=0
    else
      error "rollback: failed to unfence region ${REGION}"
    fi
  fi
  if [[ "${DRAINED}" == "1" ]]; then
    if run_hook "restore traffic" "${RESTORE_TRAFFIC_CMD}" "${REGION}"; then
      DRAINED=0
    else
      error "rollback: failed to restore traffic for region ${REGION}"
    fi
  fi
}

on_signal() {
  error "received termination signal; aborting"
  rollback "signal"
  exit 10
}

trap 'on_signal' INT TERM

# ---------------------------------------------------------------------------
# Phase 1: Prechecks
# ---------------------------------------------------------------------------
precheck_health() {
  info "precheck: health of region ${REGION}"
  if ! run_hook "health check" "${HEALTH_CHECK_CMD}" "${REGION}"; then
    die 2 "precheck failed: region ${REGION} is unhealthy"
  fi
}

precheck_replication_lag() {
  info "precheck: replication lag for region ${REGION}"
  local lag
  if ! lag="$(capture_hook "replication lag" "${REPLICATION_LAG_CMD}" "${REGION}")"; then
    die 2 "precheck failed: could not read replication lag"
  fi
  lag="$(printf '%s' "${lag}" | tr -dc '0-9')"
  [[ -n "${lag}" ]] || die 2 "precheck failed: replication lag output not numeric"
  if (( lag > MAX_REPLICATION_LAG_SECONDS )); then
    die 2 "precheck failed: replication lag ${lag}s exceeds ${MAX_REPLICATION_LAG_SECONDS}s"
  fi
  info "precheck: replication lag ${lag}s within threshold"
}

precheck_quorum() {
  info "precheck: quorum for region ${REGION}"
  local healthy
  if ! healthy="$(capture_hook "quorum status" "${QUORUM_STATUS_CMD}" "${REGION}")"; then
    die 2 "precheck failed: could not read quorum status"
  fi
  healthy="$(printf '%s' "${healthy}" | tr -dc '0-9')"
  [[ -n "${healthy}" ]] || die 2 "precheck failed: quorum output not numeric"
  if (( healthy < MIN_QUORUM_NODES )); then
    die 2 "precheck failed: ${healthy} healthy nodes < required ${MIN_QUORUM_NODES}"
  fi
  info "precheck: ${healthy} healthy nodes (>= ${MIN_QUORUM_NODES})"
}

run_prechecks() {
  info "=== Phase 1: Prechecks ==="
  precheck_health
  precheck_replication_lag
  precheck_quorum
  info "prechecks passed"
}

# ---------------------------------------------------------------------------
# Phase 2: Drain traffic
# ---------------------------------------------------------------------------
drain_traffic() {
  info "=== Phase 2: Drain traffic ==="
  if ! run_hook "drain traffic" "${DRAIN_TRAFFIC_CMD}" "${REGION}"; then
    die 3 "failed to drain traffic for region ${REGION}"
  fi
  DRAINED=1
  info "traffic drained from region ${REGION}"
}

# ---------------------------------------------------------------------------
# Phase 3: Fence publishers
# ---------------------------------------------------------------------------
fence_publishers() {
  info "=== Phase 3: Fence publishers ==="
  if ! run_hook "fence publishers" "${FENCE_PUBLISHERS_CMD}" "${REGION}"; then
    rollback "publisher fencing failed"
    die 4 "failed to fence publishers for region ${REGION}"
  fi
  FENCED=1
  info "publishers fenced (region ${REGION} quarantined)"
}

# ---------------------------------------------------------------------------
# Phase 4: Maintenance
# ---------------------------------------------------------------------------
run_maintenance() {
  info "=== Phase 4: Maintenance ==="
  if [[ "${DRY_RUN}" == "1" ]]; then
    info "[dry-run] would run maintenance: ${MAINTENANCE_CMD}"
    return 0
  fi
  info "running maintenance: ${MAINTENANCE_CMD}"
  if ! bash -c "${MAINTENANCE_CMD}"; then
    rollback "maintenance command failed"
    die 5 "maintenance command failed for region ${REGION}"
  fi
  info "maintenance completed"
}

# ---------------------------------------------------------------------------
# Phase 5: Validation
# ---------------------------------------------------------------------------
validate_health() {
  info "validate: health of region ${REGION}"
  local deadline=$(( $(date +%s) + HEALTH_TIMEOUT_SECONDS ))
  while :; do
    if run_hook "health check" "${HEALTH_CHECK_CMD}" "${REGION}"; then
      info "validate: region healthy"
      return 0
    fi
    if (( $(date +%s) >= deadline )); then
      return 1
    fi
    warn "validate: region not yet healthy; retrying in ${POLL_INTERVAL_SECONDS}s"
    sleep "${POLL_INTERVAL_SECONDS}"
  done
}

validate_price_freshness() {
  info "validate: price freshness for region ${REGION}"
  local staleness
  if ! staleness="$(capture_hook "price freshness" "${PRICE_FRESHNESS_CMD}" "${REGION}")"; then
    return 1
  fi
  staleness="$(printf '%s' "${staleness}" | tr -dc '0-9')"
  [[ -n "${staleness}" ]] || return 1
  if (( staleness > MAX_PRICE_STALENESS_SECONDS )); then
    error "validate: price staleness ${staleness}s exceeds ${MAX_PRICE_STALENESS_SECONDS}s"
    return 1
  fi
  info "validate: price staleness ${staleness}s within threshold"
  return 0
}

validate_replication_catchup() {
  info "validate: replication catch-up for region ${REGION}"
  local deadline=$(( $(date +%s) + REPLICATION_CATCHUP_TIMEOUT_SECONDS ))
  while :; do
    local lag
    if lag="$(capture_hook "replication lag" "${REPLICATION_LAG_CMD}" "${REGION}")"; then
      lag="$(printf '%s' "${lag}" | tr -dc '0-9')"
      if [[ -n "${lag}" ]] && (( lag <= MAX_REPLICATION_LAG_SECONDS )); then
        info "validate: replication lag ${lag}s within threshold"
        return 0
      fi
      warn "validate: replication lag ${lag:-unknown}s; waiting for catch-up"
    else
      warn "validate: could not read replication lag; retrying"
    fi
    if (( $(date +%s) >= deadline )); then
      return 1
    fi
    sleep "${POLL_INTERVAL_SECONDS}"
  done
}

run_validation() {
  info "=== Phase 5: Validation ==="
  if ! validate_health; then
    rollback "post-maintenance health validation failed"
    die 6 "post-maintenance health validation failed for region ${REGION}"
  fi
  if ! validate_price_freshness; then
    rollback "post-maintenance price freshness validation failed"
    die 6 "post-maintenance price freshness validation failed for region ${REGION}"
  fi
  if ! validate_replication_catchup; then
    rollback "post-maintenance replication catch-up failed"
    die 6 "post-maintenance replication catch-up failed for region ${REGION}"
  fi
  info "validation passed"
}

# ---------------------------------------------------------------------------
# Phase 6: Unfence
# ---------------------------------------------------------------------------
unfence_publishers() {
  info "=== Phase 6: Unfence publishers ==="
  if ! run_hook "unfence publishers" "${UNFENCE_PUBLISHERS_CMD}" "${REGION}"; then
    die 7 "failed to unfence publishers for region ${REGION}"
  fi
  FENCED=0
  info "publishers unfenced (region ${REGION} released from quarantine)"
}

# ---------------------------------------------------------------------------
# Phase 7: Restore traffic
# ---------------------------------------------------------------------------
restore_traffic() {
  info "=== Phase 7: Restore traffic ==="
  if ! run_hook "restore traffic" "${RESTORE_TRAFFIC_CMD}" "${REGION}"; then
    die 8 "failed to restore traffic for region ${REGION}"
  fi
  DRAINED=0
  info "traffic restored to region ${REGION}"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  parse_args "$@"

  info "starting maintenance window: region=${REGION} cell=${CELL:-<none>} dry_run=${DRY_RUN}"
  info "thresholds: max_lag=${MAX_REPLICATION_LAG_SECONDS}s max_staleness=${MAX_PRICE_STALENESS_SECONDS}s min_quorum=${MIN_QUORUM_NODES}"

  run_prechecks
  drain_traffic
  fence_publishers
  run_maintenance
  run_validation
  unfence_publishers
  restore_traffic

  info "maintenance window complete for region ${REGION}"
  exit 0
}

main "$@"