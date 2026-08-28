#!/usr/bin/env bash
# Secret rotation orchestrator (issue #370).
#
# Drives rotation for every secret category the platform depends on:
# ENCRYPTION_KEY, admin/API keys, WS HMAC + CSRF secrets, DB credentials,
# and signer keys. Supports --dry-run so it can be exercised safely in a
# quarterly drill (see .github/workflows/secret-rotation-drill.yml and
# docs/security/secret-rotation.md).
#
# Usage:
#   scripts/rotate-secrets.sh <category> [--dry-run]
#   categories: encryption-key | api-keys | ws-secrets | db-credentials | signer-key | all
set -euo pipefail

CATEGORY="${1:-}"
DRY_RUN=false
for arg in "$@"; do
  [ "$arg" = "--dry-run" ] && DRY_RUN=true
done

log() { echo "[rotate-secrets] $*"; }

run() {
  if [ "$DRY_RUN" = true ]; then
    log "DRY-RUN would run: $*"
  else
    log "running: $*"
    eval "$@"
  fi
}

rotate_encryption_key() {
  log "Rotating ENCRYPTION_KEY"
  run "npx tsx scripts/encrypt-secret.ts genkey"
  log "Move the current ENCRYPTION_KEY to ENCRYPTION_KEY_PREVIOUS, set the new key as"
  log "ENCRYPTION_KEY in the secret store, then re-encrypt values with the new key."
  log "Drop ENCRYPTION_KEY_PREVIOUS only after every value has been re-encrypted."
}

rotate_api_keys() {
  log "Rotating admin/API keys via the admin API (requires ADMIN_API_URL, ADMIN_API_KEY, TARGET_KEY_HASH)"
  run "curl -sf -X POST \"\${ADMIN_API_URL:?}/admin/keys/\${TARGET_KEY_HASH:?}/rotate\" -H \"Authorization: Bearer \${ADMIN_API_KEY:?}\""
}

rotate_ws_secrets() {
  log "Rotating WS HMAC and CSRF secrets"
  run "openssl rand -hex 32"
  log "Store the generated value as WS_HMAC_SECRET / CSRF_SECRET in the secret store and"
  log "roll the deployment so pods pick up the new value."
}

rotate_db_credentials() {
  log "Rotating DB credentials (requires K8S_NAMESPACE)"
  run "kubectl -n \${K8S_NAMESPACE:?} delete secret db-credentials --ignore-not-found"
  log "Provision a new DB user/password with the DB provider, write it to the"
  log "db-credentials k8s secret, then roll the api/aggregator deployments."
}

rotate_signer_key() {
  log "Rotating the Soroban signer key"
  log "Generate a new signer keypair, authorize it as a contract admin signer on-chain,"
  log "then revoke the previous signer key once the new one is confirmed active."
}

case "$CATEGORY" in
  encryption-key) rotate_encryption_key ;;
  api-keys) rotate_api_keys ;;
  ws-secrets) rotate_ws_secrets ;;
  db-credentials) rotate_db_credentials ;;
  signer-key) rotate_signer_key ;;
  all)
    rotate_encryption_key
    rotate_api_keys
    rotate_ws_secrets
    rotate_db_credentials
    rotate_signer_key
    ;;
  *)
    echo "Usage: $0 <encryption-key|api-keys|ws-secrets|db-credentials|signer-key|all> [--dry-run]" >&2
    exit 1
    ;;
esac
