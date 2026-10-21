#!/usr/bin/env bash
set -euo pipefail
namespace="${1:?Usage: $0 <namespace>}"
for resource in stellar-oracle-secrets timescaledb-credentials; do
  kubectl wait --for=condition=Ready "externalsecret/${resource}" -n "$namespace" --timeout=120s
 done
check_secret() {
  local secret="$1" key="$2" value
  value="$(kubectl get secret "$secret" -n "$namespace" -o "jsonpath={.data.${key}}" 2>/dev/null | base64 -d 2>/dev/null || true)"
  if [[ -z "$value" || "$value" =~ (replace-me|CHANGE_ME|changeme|placeholder|example) ]]; then
    echo "ERROR: required key ${secret}.${key} is missing or still a placeholder in namespace ${namespace}" >&2
    return 1
  fi
}
for key in API_KEYS ADMIN_SECRET_KEY ORACLE_API_KEY DATABASE_URL; do check_secret stellar-oracle-secrets "$key"; done
check_secret timescaledb-credentials password
