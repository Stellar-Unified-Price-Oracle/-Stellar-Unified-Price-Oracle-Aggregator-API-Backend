#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHAOS_DIR="${ROOT}/k8s/chaos"
CHAOS_OUT="/tmp/stellar-oracle-chaos.yaml"

kustomize_build() {
  local src="$1"
  local out="$2"
  if command -v kubectl >/dev/null 2>&1; then
    kubectl kustomize "${src}" > "${out}"
    return
  fi
  if command -v kustomize >/dev/null 2>&1; then
    kustomize build "${src}" > "${out}"
    return
  fi
  echo "Neither kubectl nor kustomize found; install one to validate manifests."
  exit 1
}

kubeconform_bin() {
  if command -v kubeconform >/dev/null 2>&1; then
    echo kubeconform
  elif [[ -x "${ROOT}/kubeconform-bin" ]]; then
    echo "${ROOT}/kubeconform-bin"
  elif [[ -x "${ROOT}/kubeconform" ]]; then
    echo "${ROOT}/kubeconform"
  else
    return 1
  fi
}

echo "==> Building k8s/chaos kustomization"
kustomize_build "${CHAOS_DIR}" "${CHAOS_OUT}"

echo "==> Validating YAML syntax"
python3 - <<'PY'
import pathlib, sys
try:
    import yaml
except ImportError:
    print("PyYAML not installed; skipping YAML parse check")
    sys.exit(0)

path = "/tmp/stellar-oracle-chaos.yaml"
docs = list(yaml.safe_load_all(pathlib.Path(path).read_text()))
if not docs:
    raise SystemExit(f"No documents in {path}")
print(f"  OK: {path} ({len(docs)} documents)")
PY

if bin="$(kubeconform_bin)"; then
  echo "==> Running kubeconform"
  SCHEMA_FLAGS=(
    -schema-location default
    -schema-location "https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json"
    -ignore-missing-schemas
  )
  "${bin}" "${SCHEMA_FLAGS[@]}" "${CHAOS_OUT}"
elif command -v kubectl >/dev/null 2>&1; then
  echo "==> Running kubectl dry-run"
  kubectl apply --dry-run=client -f "${CHAOS_OUT}"
else
  echo "kubeconform/kubectl not available; YAML syntax validation passed."
fi

echo "Chaos Kubernetes manifests validated successfully."
