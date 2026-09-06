#!/usr/bin/env bash
set -euo pipefail

VALID_ENVS="dev staging production"
REGISTRY="${REGISTRY:-ghcr.io}"
REPO="${REPO:-}"
NAMESPACE_PREFIX="stellar-oracle"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-60}"
ROLLOUT_TIMEOUT="${ROLLOUT_TIMEOUT:-120}"
DRY_RUN="${ROLLBACK_DRY_RUN:-false}"
LOG_FILE="logs/rollback-events.log"

usage() {
  echo "Usage: $0 <environment> [commit-sha|--freeze-only]"
  echo ""
  echo "  environment   One of: dev, staging, production"
  echo "  commit-sha    Optional. SHA to roll back to (default: HEAD~1)"
  echo "  --freeze-only Scale aggregator to 0 without redeploying"
  echo ""
  echo "  Environment variables:"
  echo "    ROLLBACK_DRY_RUN=true   Validate logic without deploying"
  echo "    CONFIRM_PRODUCTION=yes  Required to run against production"
  echo "    REGISTRY                Container registry (default: ghcr.io)"
  echo "    REPO                    Image repository path (e.g. myorg/stellar-oracle)"
  exit 1
}

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG_FILE"; }
err() { log "ERROR $*" >&2; }
die() { err "$*"; exit 1; }

kube() {
  if [[ "$DRY_RUN" == "true" ]]; then
    log "[dry-run] kubectl $*"
  else
    kubectl "$@"
  fi
}

record_event() {
  mkdir -p "$(dirname "$LOG_FILE")"
  log "$*"
}

validate_env() {
  local env="$1"
  for v in $VALID_ENVS; do
    [[ "$v" == "$env" ]] && return 0
  done
  die "Invalid environment '${env}'. Must be one of: ${VALID_ENVS}"
}

require_confirm_production() {
  local env="$1"
  if [[ "$env" == "production" && "${CONFIRM_PRODUCTION:-}" != "yes" ]]; then
    die "Refusing to run against production without CONFIRM_PRODUCTION=yes"
  fi
}

check_kubeconfig() {
  if [[ -z "${KUBECONFIG:-}" ]] && [[ ! -f "${HOME}/.kube/config" ]]; then
    die "KUBECONFIG is not set and ~/.kube/config does not exist"
  fi
}

resolve_sha() {
  local arg="${1:-}"
  if [[ -n "$arg" && "$arg" != "--freeze-only" ]]; then
    echo "$arg"
  else
    git rev-parse HEAD~1 2>/dev/null || die "Cannot resolve HEAD~1. Are you in a git repository?"
  fi
}

freeze_aggregator() {
  local namespace="$1"
  log "FREEZE start — namespace=${namespace}"
  kube scale deployment/aggregator --replicas=0 -n "$namespace"
  if [[ "$DRY_RUN" != "true" ]]; then
    kube rollout status deployment/aggregator -n "$namespace" --timeout="${ROLLOUT_TIMEOUT}s" || true
  fi
  log "FREEZE complete — aggregator scaled to 0"
}

wait_for_rollout() {
  local namespace="$1"
  log "Waiting for rollout (timeout=${ROLLOUT_TIMEOUT}s)..."
  kube rollout status deployment/api -n "$namespace" --timeout="${ROLLOUT_TIMEOUT}s"
  kube rollout status deployment/aggregator -n "$namespace" --timeout="${ROLLOUT_TIMEOUT}s"
}

verify_health() {
  local namespace="$1"
  local health_url="${HEALTH_URL:-}"

  if [[ -z "$health_url" ]]; then
    log "HEALTH_URL not set — attempting port-forward to api deployment"
    if [[ "$DRY_RUN" == "true" ]]; then
      log "[dry-run] would verify health via port-forward"
      return 0
    fi
    kubectl port-forward -n "$namespace" deployment/api 18081:3000 &
    local pf_pid=$!
    sleep 3
    health_url="http://localhost:18081/api/v1/health"

    local ok=false
    for i in $(seq 1 "$HEALTH_TIMEOUT"); do
      if curl -sf "$health_url" -o /dev/null 2>/dev/null; then
        ok=true
        break
      fi
      sleep 1
    done

    kill "$pf_pid" 2>/dev/null || true
    wait "$pf_pid" 2>/dev/null || true

    [[ "$ok" == "true" ]] || die "Health check failed after ${HEALTH_TIMEOUT}s"
    log "Health check passed"
    return 0
  fi

  if [[ "$DRY_RUN" == "true" ]]; then
    log "[dry-run] would verify ${health_url}"
    return 0
  fi

  local ok=false
  for i in $(seq 1 "$HEALTH_TIMEOUT"); do
    if curl -sf "$health_url" -o /dev/null 2>/dev/null; then
      ok=true
      break
    fi
    sleep 1
  done

  [[ "$ok" == "true" ]] || die "Health check at ${health_url} failed after ${HEALTH_TIMEOUT}s"
  log "Health check passed: ${health_url}"
}

main() {
  [[ $# -lt 1 ]] && usage

  local env="$1"
  local sha_arg="${2:-}"
  local freeze_only=false

  [[ "$sha_arg" == "--freeze-only" ]] && freeze_only=true

  validate_env "$env"
  require_confirm_production "$env"
  check_kubeconfig

  local namespace="${NAMESPACE_PREFIX}-${env}"
  local start_ts
  start_ts=$(date +%s)

  mkdir -p logs
  record_event "ROLLBACK_START env=${env} freeze_only=${freeze_only} dry_run=${DRY_RUN}"

  log "Step 1: Freeze — scaling aggregator to 0"
  freeze_aggregator "$namespace"

  if [[ "$freeze_only" == "true" ]]; then
    record_event "FREEZE_ONLY_COMPLETE env=${env}"
    log "Freeze complete. Exiting (--freeze-only mode)."
    exit 0
  fi

  log "Step 2: Identify rollback SHA"
  local sha
  sha=$(resolve_sha "$sha_arg")
  local short_sha="${sha:0:7}"
  log "Rolling back to SHA=${sha} (short=${short_sha})"

  local api_image="${REGISTRY}/${REPO}/api:sha-${short_sha}"
  local aggregator_image="${REGISTRY}/${REPO}/aggregator:sha-${short_sha}"

  if [[ -z "$REPO" ]]; then
    log "WARNING: REPO env var is not set. Image paths will be incomplete."
    log "Set REPO=<org>/<project> (e.g. myorg/stellar-oracle) to build correct image names."
    api_image="<registry>/<repo>/api:sha-${short_sha}"
    aggregator_image="<registry>/<repo>/aggregator:sha-${short_sha}"
  fi

  log "  API image:        ${api_image}"
  log "  Aggregator image: ${aggregator_image}"

  log "Step 3: Deploy rollback images via scripts/deploy-k8s.sh"
  if [[ "$DRY_RUN" == "true" ]]; then
    log "[dry-run] bash scripts/deploy-k8s.sh ${env} ${api_image} ${aggregator_image}"
  else
    bash "$(dirname "$0")/deploy-k8s.sh" "$env" "$api_image" "$aggregator_image"
  fi

  log "Step 4: Wait for rollout"
  wait_for_rollout "$namespace"

  log "Step 5: Verify health endpoint"
  verify_health "$namespace"

  local end_ts
  end_ts=$(date +%s)
  local ttr=$(( end_ts - start_ts ))

  record_event "ROLLBACK_COMPLETE env=${env} sha=${sha} ttr_seconds=${ttr}"
  log "Rollback complete. TTR=${ttr}s (target: <600s)"

  if [[ "$ttr" -gt 600 ]]; then
    log "WARNING: TTR exceeded 10-minute target (${ttr}s > 600s)"
  fi
}

main "$@"
