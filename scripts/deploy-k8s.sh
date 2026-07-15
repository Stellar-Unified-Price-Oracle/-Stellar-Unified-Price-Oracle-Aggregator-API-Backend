#!/usr/bin/env bash
set -euo pipefail

ENV="${1:?Usage: $0 <dev|staging|prod> <api-image> <aggregator-image>}"
API_IMAGE="${2:?}"
AGGREGATOR_IMAGE="${3:?}"

OVERLAY="k8s/overlays/${ENV}"

if [ ! -d "$OVERLAY" ]; then
  echo "ERROR: overlay directory not found: $OVERLAY"
  exit 1
fi

cd "$OVERLAY"

kustomize edit set image oracle-api="${API_IMAGE}" oracle-aggregator="${AGGREGATOR_IMAGE}"

echo "---"
echo "Deploying to ${ENV} with:"
echo "  API image:        ${API_IMAGE}"
echo "  Aggregator image: ${AGGREGATOR_IMAGE}"
echo "---"

kustomize build . | kubectl apply --server-side --field-manager=kustomize -f -

echo "Deployment to ${ENV} complete."
