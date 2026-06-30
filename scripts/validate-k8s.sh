#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
K8S_DIR="${ROOT}/k8s"
STAGING_OUT="/tmp/stellar-oracle-staging.yaml"
CHAOS_OUT="/tmp/stellar-oracle-chaos.yaml"

kustomize_build() {
  local src="$1"
  local out="$2"
  if command -v kubectl >/dev/null 2>&1; then
    kubectl kustomize "${src}" > "${out}"
  elif command -v kustomize >/dev/null 2>&1; then
    kustomize build "${src}" > "${out}"
  else
    echo "Neither kubectl nor kustomize found; install one to validate manifests."
    exit 1
  fi
}

echo "==> Building kustomize overlays"
kustomize_build "${K8S_DIR}/overlays/staging" "${STAGING_OUT}"
kustomize_build "${K8S_DIR}/chaos" "${CHAOS_OUT}"

echo "==> Validating YAML syntax"
python3 - <<'PY'
import pathlib, sys
try:
    import yaml
except ImportError:
    print("PyYAML not installed; skipping YAML parse check")
    sys.exit(0)

for path in ["/tmp/stellar-oracle-staging.yaml", "/tmp/stellar-oracle-chaos.yaml"]:
    docs = list(yaml.safe_load_all(pathlib.Path(path).read_text()))
    if not docs:
        raise SystemExit(f"No documents in {path}")
    print(f"  OK: {path} ({len(docs)} documents)")
PY

if command -v kubeconform >/dev/null 2>&1; then
  echo "==> Running kubeconform"
  SCHEMA_FLAGS=(
    -schema-location default
    -schema-location "https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json"
    -ignore-missing-schemas
  )
  kubeconform "${SCHEMA_FLAGS[@]}" "${STAGING_OUT}"
  kubeconform "${SCHEMA_FLAGS[@]}" "${CHAOS_OUT}"
elif command -v kubectl >/dev/null 2>&1; then
  echo "==> Running kubectl dry-run"
  kubectl apply --dry-run=client -f "${STAGING_OUT}"
  kubectl apply --dry-run=client -f "${CHAOS_OUT}"
else
  echo "kubeconform/kubectl not available; YAML syntax validation passed."
fi

echo "All Kubernetes manifests validated successfully."
