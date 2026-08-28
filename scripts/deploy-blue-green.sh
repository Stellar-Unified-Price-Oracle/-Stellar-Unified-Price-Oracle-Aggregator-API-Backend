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
#
# Dependencies: kubectl, jq
set -euo pipefail

# ── Args & Config ──────────────────────────────────────────────────────────────
IMAGE_TAG="${1:?Usage: $0 <image-tag>}"
NAMESPACE="${NAMESPACE:-stellar-oracle}"
HEALTH_URL="${HEALTH_URL:-http://localhost:3000/health}"
SMOKE_RETRIES="${SMOKE_RETRIES:-20}"
SMOKE_INTERVAL="${SMOKE_INTERVAL:-10}"
DRY_RUN="${DRY_RUN:-false}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
K8S_DIR="${SCRIPT_DIR}/../k8s/blue-green"

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
    err "Smoke tests failed — aborting traffic switch. ${GREEN} deployment left running for inspection."
    exit 1
  fi
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
