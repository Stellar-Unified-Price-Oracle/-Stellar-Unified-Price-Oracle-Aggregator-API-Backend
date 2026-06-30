#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ISTIO_VERSION="${ISTIO_VERSION:-1.22.3}"
APP_NAMESPACE="${STELLAR_ORACLE_NAMESPACE:-stellar-oracle}"

if ! command -v kubectl >/dev/null 2>&1; then
  echo "kubectl is required."
  exit 1
fi

if ! command -v istioctl >/dev/null 2>&1; then
  echo "istioctl is required. Install from https://istio.io/latest/docs/setup/getting-started/"
  exit 1
fi

echo "==> Ensuring application namespace ${APP_NAMESPACE}"
kubectl create namespace "${APP_NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -

echo "==> Installing Istio operator ${ISTIO_VERSION}"
istioctl operator init --istioVersion "${ISTIO_VERSION}" 2>/dev/null || true

echo "==> Applying IstioOperator and mesh policies"
kubectl apply -k "${ROOT}/k8s/istio"

echo "==> Waiting for istiod"
kubectl wait --for=condition=Available deployment/istiod -n istio-system --timeout=600s

echo "Istio mesh installed (meshID: stellar-oracle). Verify: istioctl proxy-status"
