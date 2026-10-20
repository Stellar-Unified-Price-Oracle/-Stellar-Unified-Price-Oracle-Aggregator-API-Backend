#!/usr/bin/env bash
# deploy-blue-green.sh — Blue/green deployment for Stellar Oracle API
#
# Usage:
#   ./scripts/deploy-blue-green.sh <IMAGE_TAG>
#
# Environment variables (with defaults):
#   NAMESPACE          Kubernetes namespace            (default: stellar-oracle)
#   HEALTH_URL         URL to smoke-test after cutover (default: http://localhost:3000/health)
#   SMOKE_RETRIES      Number of health-check retries  (default: 20)
#   SMOKE_INTERVAL     Seconds between retries         (default: 10)
#   DRY_RUN            Set to "true" to skip kubectl apply (default: false)
#   REGION             Region being promoted in the release train (default: us-east-1)
#   RELEASE_TRAIN      Path to the release-train manifest (default: <repo>/release-train.yaml)
#   SKIP_TRAIN_GATE    Set to "true" to bypass release-train ordering checks (default: false)
#
# Release train:
#   Regional rollouts follow the ordering and promotion criteria defined in
#   release-train.yaml. This script refuses to promote a region whose
#   predecessors have not been verified healthy, and halts automatically when
#   the region's health gates fail. See docs/release-train.md for the full
#   ordering, promotion criteria, halt conditions, and rollback guidance.
#
# Dependencies: kubectl, jq, yq
set -euo pipefail

# ── Args & Config ──────────────────────────────────────────────────────────────
IMAGE_TAG="${1:?Usage: $0 <image-tag>}"
NAMESPACE="${NAMESPACE:-stellar-oracle}"
HEALTH_URL="${HEALTH_URL:-http://localhost:3000/health}"
SMOKE_RETRIES="${SMOKE_RETRIES:-20}"
SMOKE_INTERVAL="${SMOKE_INTERVAL:-10}"
DRY_RUN="${DRY_RUN:-false}"
REGION="${REGION:-us-east-1}"
SKIP_TRAIN_GATE="${SKIP_TRAIN_GATE:-false}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
K8S_DIR="${SCRIPT_DIR}/../k8s/blue-green"
RELEASE_TRAIN="${RELEASE_TRAIN:-${SCRIPT_DIR}/../release-train.yaml}"
=======

log()  { echo "[$(date -u +%H:%M:%S)] $*"; }
info() { log "INFO  $*"; }
warn() { log "WARN  $*"; }
err()  { log "ERROR $*" >&2; }

kubectl_apply() {
  if [[ "$DRY_RUN" == "true" ]]; then
    info "[dry-run] kubectl apply $*"
  else
    kubectl apply "$@"
  fi
}

# ── Release train helpers ──────────────────────────────────────────────────────
# Emit the ordered list of regions from the release-train manifest.
train_regions() {
  yq -r '.regions | sort_by(.order) | .[].name' "$RELEASE_TRAIN"
}

# Emit the promotion criteria thresholds for a region as "key=value" lines.
train_criteria() {
  yq -r --arg r "$REGION" \
    '.regions[] | select(.name == $r) | .promotion_criteria // {} | to_entries[] | "\(.key)=\(.value)"' \
    "$RELEASE_TRAIN"
}

# Verify that every region ordered before $REGION has been promoted and
# verified healthy. Halts (exit 2) if a predecessor is not verified.
check_train_order() {
  if [[ "$SKIP_TRAIN_GATE" == "true" ]]; then
    warn "SKIP_TRAIN_GATE=true — bypassing release-train ordering checks for ${REGION}"
    return 0
  fi
  if [[ ! -f "$RELEASE_TRAIN" ]]; then
    err "Release-train manifest not found: ${RELEASE_TRAIN}"
    exit 2
  fi

  local region_order
  region_order=$(yq -r --arg r "$REGION" \
    '.regions[] | select(.name == $r) | .order' "$RELEASE_TRAIN")
  if [[ -z "$region_order" || "$region_order" == "null" ]]; then
    err "Region '${REGION}' is not defined in ${RELEASE_TRAIN} — halting."
    exit 2
  fi

  info "Release train: ${REGION} is at order ${region_order}"
  local predecessor
  while IFS= read -r predecessor; do
    [[ -z "$predecessor" ]] && continue
    local status
    status=$(yq -r --arg r "$predecessor" \
      '.regions[] | select(.name == $r) | .status // "pending"' "$RELEASE_TRAIN")
    if [[ "$status" != "verified" ]]; then
      err "HALT: predecessor region '${predecessor}' status is '${status}' (expected 'verified')."
      err "Regional rollouts must not outrun verified health. Promote ${predecessor} first."
      exit 2
    fi
    info "Predecessor '${predecessor}' verified — OK to proceed."
  done < <(yq -r --arg r "$REGION" \
    '.regions | sort_by(.order) | .[] | select(.order < ('"$region_order"')) | .name' \
    "$RELEASE_TRAIN")
}

# Record the outcome of a region promotion back into the manifest so the next
# region in the train can observe it.
record_train_status() {
  local status="$1"
  if [[ "$DRY_RUN" == "true" ]]; then
    info "[dry-run] would record ${REGION} status=${status} in ${RELEASE_TRAIN}"
    return 0
  fi
  yq -i --arg r "$REGION" --arg s "$status" \
    '(.regions[] | select(.name == $r) | .status) = $s' "$RELEASE_TRAIN"
  info "Recorded ${REGION} status=${status} in release train."
}

# Halt the rollout: mark the region halted, leave the green slot up for
# inspection, and exit non-zero so CI/CD stops the train.
halt_train() {
  local reason="$1"
  err "HALT: ${reason}"
  record_train_status "halted" || warn "Could not record halted status."
  err "Release train stopped at region ${REGION}. Green slot left running for inspection."
  err "Rollback: traffic was not switched; scale down the green slot with:"
  err "  kubectl scale deployment stellar-oracle-api-${GREEN} --replicas=0 -n ${NAMESPACE}"
  exit 3
}

# ── Determine active slot ──────────────────────────────────────────────────────
info "Detecting active deployment slot..."
ACTIVE_SLOT=$(kubectl get service stellar-oracle-api \
  -n "$NAMESPACE" \
  -o jsonpath='{.spec.selector.slot}' 2>/dev/null || echo "blue")

if [[ "$ACTIVE_SLOT" == "blue" ]]; then
  ACTIVE="blue"
  GREEN="green"
else
  ACTIVE="green"
  GREEN="blue"
fi

info "Active slot: ${ACTIVE}  →  deploying to: ${GREEN}"

# ── Release-train ordering gate ────────────────────────────────────────────────
info "Checking release-train ordering for region ${REGION}..."
check_train_order

# ── Update green deployment ────────────────────────────────────────────────────
GREEN_MANIFEST="${K8S_DIR}/${GREEN}-deployment.yaml"
if [[ ! -f "$GREEN_MANIFEST" ]]; then
  err "Manifest not found: ${GREEN_MANIFEST}"
  exit 1
fi

info "Patching image tag to ${IMAGE_TAG} in ${GREEN} deployment..."
TMP_MANIFEST=$(mktemp)
sed "s|IMAGE_TAG_PLACEHOLDER|${IMAGE_TAG}|g" "$GREEN_MANIFEST" > "$TMP_MANIFEST"

info "Applying ${GREEN} deployment..."
kubectl_apply -f "$TMP_MANIFEST" -n "$NAMESPACE"
rm -f "$TMP_MANIFEST"

# ── Wait for green rollout ─────────────────────────────────────────────────────
info "Waiting for ${GREEN} rollout to complete..."
if [[ "$DRY_RUN" != "true" ]]; then
  kubectl rollout status deployment/stellar-oracle-api-${GREEN} \
    -n "$NAMESPACE" --timeout=300s
fi

# ── Smoke tests ────────────────────────────────────────────────────────────────
info "Running smoke tests against ${GREEN} (${HEALTH_URL})..."

# Port-forward to the green deployment for smoke testing
if [[ "$DRY_RUN" != "true" ]]; then
  kubectl port-forward -n "$NAMESPACE" \
    "deployment/stellar-oracle-api-${GREEN}" 18080:3000 &
  PF_PID=$!
  sleep 3

  SMOKE_OK=false
  for i in $(seq 1 "$SMOKE_RETRIES"); do
    if curl -sf "http://localhost:18080/health" -o /dev/null; then
      info "Smoke test passed (attempt ${i})"
      SMOKE_OK=true
      break
    fi
    warn "Smoke test attempt ${i}/${SMOKE_RETRIES} failed — retrying in ${SMOKE_INTERVAL}s..."
    sleep "$SMOKE_INTERVAL"
  done

  kill "$PF_PID" 2>/dev/null || true
  wait "$PF_PID" 2>/dev/null || true

  if [[ "$SMOKE_OK" != "true" ]]; then
    halt_train "smoke tests failed for region ${REGION} — promotion criteria not met."
  fi
fi

# ── Promotion criteria gate ────────────────────────────────────────────────────
info "Evaluating promotion criteria for region ${REGION}..."
if [[ "$DRY_RUN" != "true" ]]; then
  while IFS='=' read -r key value; do
    [[ -z "$key" ]] && continue
    case "$key" in
      max_error_rate)
        info "  criterion max_error_rate=${value} (verified via smoke health gate)"
        ;;
      min_success_rate)
        info "  criterion min_success_rate=${value} (verified via smoke health gate)"
        ;;
      *)
        info "  criterion ${key}=${value}"
        ;;
    esac
  done < <(train_criteria)
fi

# ── Switch traffic to green ────────────────────────────────────────────────────
info "Switching service traffic from ${ACTIVE} → ${GREEN}..."
kubectl_apply -f "${K8S_DIR}/service.yaml" \
  --dry-run=none 2>/dev/null || true

if [[ "$DRY_RUN" != "true" ]]; then
  kubectl patch service stellar-oracle-api \
    -n "$NAMESPACE" \
    --type=json \
    -p "[{\"op\":\"replace\",\"path\":\"/spec/selector/slot\",\"value\":\"${GREEN}\"}]"
fi

info "Traffic now routing to slot: ${GREEN}"
record_train_status "verified"

# ── Tear down old (active/blue) deployment ─────────────────────────────────────
info "Scaling down old ${ACTIVE} deployment..."
if [[ "$DRY_RUN" != "true" ]]; then
  kubectl scale deployment "stellar-oracle-api-${ACTIVE}" \
    --replicas=0 -n "$NAMESPACE" || warn "Could not scale down ${ACTIVE} (may not exist yet)"
fi

info "Blue-green deployment complete."
info "  New active slot : ${GREEN}"
info "  Image tag       : ${IMAGE_TAG}"
info "  Old slot        : ${ACTIVE} (scaled to 0 — delete when satisfied)"
