#!/usr/bin/env bash
# Tier 2 disaster recovery: full cluster/namespace/PVC loss.
# See docs/disaster-recovery/recovery-procedures.md#scenario-full-cluster--namespace--all-pvcs-loss-tier-2--full-recovery
#
# Usage: scripts/dr/recover.sh <env> [image-tag]
#   env        dev | staging | production
#   image-tag  Registry tag to redeploy (default: latest)
#
# Requires: kubectl (configured against the target cluster), kustomize,
#           API_BASE_URL and ADMIN_API_KEY env vars pointing at the API's admin routes.
set -euo pipefail

ENV="${1:?Usage: $0 <dev|staging|production> [image-tag]}"
IMAGE_TAG="${2:-latest}"
API_BASE_URL="${API_BASE_URL:?Set API_BASE_URL, e.g. https://staging.api.stellar-oracle.example}"
ADMIN_API_KEY="${ADMIN_API_KEY:?Set ADMIN_API_KEY (an admin-tier API key)}"
NAMESPACE="stellar-oracle-${ENV}"
HEALTH_TIMEOUT_S="${DR_HEALTH_TIMEOUT_S:-2700}" # 45 min ceiling, RTO target is 60 min

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
T0=$(date +%s)

log() { echo "[dr-recover $(( $(date +%s) - T0 ))s] $*"; }

REGISTRY="ghcr.io"
REPO="${GITHUB_REPOSITORY:-stellar-unified-price-oracle/-stellar-unified-price-oracle-aggregator-api-backend}"
API_IMAGE="${API_IMAGE:-${REGISTRY}/${REPO}/api:${IMAGE_TAG}}"
AGGREGATOR_IMAGE="${AGGREGATOR_IMAGE:-${REGISTRY}/${REPO}/aggregator:${IMAGE_TAG}}"

log "Starting Tier 2 recovery for '${ENV}' (namespace ${NAMESPACE})"
log "Target images: api=${API_IMAGE} aggregator=${AGGREGATOR_IMAGE}"

log "Step 1/5: reapplying k8s manifests from version control"
bash "${ROOT}/scripts/deploy-k8s.sh" "${ENV}" "${API_IMAGE}" "${AGGREGATOR_IMAGE}"

log "Step 2/5: waiting for timescaledb to become ready"
kubectl -n "${NAMESPACE}" rollout status statefulset/timescaledb --timeout="${HEALTH_TIMEOUT_S}s"

log "Step 3/5: waiting for api-stable to become ready"
kubectl -n "${NAMESPACE}" rollout status deployment/api-stable --timeout="${HEALTH_TIMEOUT_S}s"

log "Step 4/5: restoring latest encrypted snapshot"
LATEST_FILE=$(curl -sf -H "x-api-key: ${ADMIN_API_KEY}" "${API_BASE_URL}/api/v1/admin/backup/list" \
  | grep -o '"file":"[^"]*"' | tail -1 | sed -E 's/"file":"([^"]*)"/\1/')

if [ -z "${LATEST_FILE}" ]; then
  log "ERROR: no backups found via /admin/backup/list — cannot proceed automatically."
  log "Manual fallback: see docs/disaster-recovery/recovery-procedures.md"
  exit 1
fi

log "Restoring from backup: ${LATEST_FILE}"
RESTORE_RESULT=$(curl -sf -X POST \
  -H "x-api-key: ${ADMIN_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"file\":\"${LATEST_FILE}\"}" \
  "${API_BASE_URL}/api/v1/admin/backup/restore")

if ! echo "${RESTORE_RESULT}" | grep -q '"success":true'; then
  log "ERROR: restore failed: ${RESTORE_RESULT}"
  exit 1
fi

log "Step 5/5: verifying health"
DEADLINE=$(( $(date +%s) + HEALTH_TIMEOUT_S ))
until curl -sf "${API_BASE_URL}/api/v1/health" >/dev/null; do
  if [ "$(date +%s)" -ge "${DEADLINE}" ]; then
    log "ERROR: health check did not pass within ${HEALTH_TIMEOUT_S}s"
    exit 1
  fi
  sleep 5
done

ELAPSED=$(( $(date +%s) - T0 ))
log "Recovery complete in ${ELAPSED}s (RTO target: 3600s)"
if [ "${ELAPSED}" -gt 3600 ]; then
  log "WARNING: recovery exceeded the 1-hour RTO target"
fi

echo "${ELAPSED}"
