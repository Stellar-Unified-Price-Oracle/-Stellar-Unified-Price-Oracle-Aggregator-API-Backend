#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NAMESPACE="${CHAOS_NAMESPACE:-stellar-oracle}"
RELEASE="${CHAOS_MESH_RELEASE:-chaos-mesh}"
VALUES="${ROOT}/k8s/chaos/install/helm-values.yaml"

if [[ "${CHAOS_TARGET_ENV:-}" != "staging" ]]; then
  echo "ERROR: CHAOS_TARGET_ENV must be set to 'staging' before installing Chaos Mesh."
  echo "  export CHAOS_TARGET_ENV=staging"
  exit 1
fi

if ! command -v helm >/dev/null 2>&1; then
  echo "ERROR: helm is required but not installed."
  exit 1
fi

if ! command -v kubectl >/dev/null 2>&1; then
  echo "ERROR: kubectl is required but not installed."
  exit 1
fi

echo "==> Applying namespace and RBAC"
kubectl apply -f "${ROOT}/k8s/chaos/namespace.yaml"
kubectl apply -f "${ROOT}/k8s/chaos/install/rbac.yaml"

echo "==> Adding Chaos Mesh Helm repository"
helm repo add chaos-mesh https://charts.chaos-mesh.org 2>/dev/null || true
helm repo update chaos-mesh

echo "==> Installing Chaos Mesh (namespace-scoped, target: ${NAMESPACE})"
helm upgrade --install "${RELEASE}" chaos-mesh/chaos-mesh \
  --namespace "${NAMESPACE}" \
  --create-namespace \
  -f "${VALUES}" \
  --wait \
  --timeout 10m

echo "==> Applying chaos experiments and schedules"
kubectl apply -k "${ROOT}/k8s/chaos"

echo "Chaos Mesh installed for ${CHAOS_TARGET_ENV} environment in namespace ${NAMESPACE}."
