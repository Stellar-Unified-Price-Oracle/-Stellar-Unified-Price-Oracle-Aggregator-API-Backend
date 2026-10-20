#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NAMESPACE="${CHAOS_NAMESPACE:-stellar-oracle}"
RELEASE="${CHAOS_MESH_RELEASE:-chaos-mesh}"
VALUES="${ROOT}/k8s/chaos/install/helm-values.yaml"

# Bounded blast radius / duration guards.
MAX_DURATION_SECONDS="${CHAOS_MAX_DURATION_SECONDS:-300}"
DEFAULT_DURATION="${CHAOS_DURATION:-120s}"
CELL_LABEL_KEY="${CHAOS_CELL_LABEL_KEY:-chaos-cell}"
CELL_LABEL_VALUE="${CHAOS_CELL:-staging-cell-a}"
SCHEDULE="${CHAOS_SCHEDULE:-*/30 * * * *}"
EXPERIMENTS_DIR="${ROOT}/k8s/chaos/experiments"

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

# Parse a duration like "120s", "2m", "1h" into seconds for the guard.
duration_to_seconds() {
  local d="$1"
  if [[ "${d}" =~ ^([0-9]+)s$ ]]; then
    echo "${BASH_REMATCH[1]}"
  elif [[ "${d}" =~ ^([0-9]+)m$ ]]; then
    echo "$(( BASH_REMATCH[1] * 60 ))"
  elif [[ "${d}" =~ ^([0-9]+)h$ ]]; then
    echo "$(( BASH_REMATCH[1] * 3600 ))"
  else
    echo "ERROR: Unsupported duration format '${d}'. Use <n>s, <n>m, or <n>h." >&2
    return 1
  fi
}

DURATION_SECONDS="$(duration_to_seconds "${DEFAULT_DURATION}")" || exit 1
if (( DURATION_SECONDS <= 0 || DURATION_SECONDS > MAX_DURATION_SECONDS )); then
  echo "ERROR: CHAOS_DURATION (${DEFAULT_DURATION} = ${DURATION_SECONDS}s) must be > 0 and <= ${MAX_DURATION_SECONDS}s."
  exit 1
fi

if [[ ! "${SCHEDULE}" =~ ^(\*|[0-9,\-\*/]+)([[:space:]]+(\*|[0-9,\-\*/]+)){4}$ ]]; then
  echo "ERROR: CHAOS_SCHEDULE '${SCHEDULE}' does not look like a valid 5-field cron expression."
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

echo "==> Applying base chaos configuration"
kubectl apply -k "${ROOT}/k8s/chaos"

# Render a bounded, dependency-specific experiment/schedule manifest.
# All selectors are scoped to the target namespace and cell label so the
# blast radius cannot leak into other cells or environments.
render_experiment() {
  local kind="$1"        # Schedule or <Kind> (e.g. PodChaos, NetworkChaos)
  local name="$2"
  local action="$3"
  local target_label="$4"
  local mode="$5"
  local extra_spec="$6"

  cat <<EOF
---
apiVersion: chaos-mesh.org/v1alpha1
kind: ${kind}
metadata:
  name: ${name}
  namespace: ${NAMESPACE}
  labels:
    app.kubernetes.io/part-of: chaos-exercises
    chaos.stellar-oracle.io/dependency: ${target_label}
    chaos.stellar-oracle.io/cell: ${CELL_LABEL_VALUE}
    chaos.stellar-oracle.io/bounded: "true"
spec:
  action: ${action}
  mode: ${mode}
  duration: ${DEFAULT_DURATION}
  selector:
    namespaces:
      - ${NAMESPACE}
    labelSelectors:
      ${CELL_LABEL_KEY}: ${CELL_LABEL_VALUE}
${extra_spec}
EOF
}

echo "==> Rendering bounded dependency-specific experiments (duration=${DEFAULT_DURATION}, cell=${CELL_LABEL_VALUE})"
mkdir -p "${EXPERIMENTS_DIR}"
RENDERED="${EXPERIMENTS_DIR}/rendered-${CELL_LABEL_VALUE}.yaml"
: > "${RENDERED}"

# Database: pod fault against timescaledb within the target cell.
render_experiment "PodChaos" "chaos-db-pod-fault" "pod-failure" "database" "one" \
"    labelSelectors:
      app.kubernetes.io/name: timescaledb
      ${CELL_LABEL_KEY}: ${CELL_LABEL_VALUE}" >> "${RENDERED}"

# Database: network delay/loss to timescaledb to exercise retry/backoff paths.
render_experiment "NetworkChaos" "chaos-db-network-fault" "delay" "database" "one" \
"    labelSelectors:
      app.kubernetes.io/name: timescaledb
      ${CELL_LABEL_KEY}: ${CELL_LABEL_VALUE}
  delay:
    latency: 200ms
    correlation: "50"
    jitter: 50ms
  direction: to" >> "${RENDERED}"

# Cache: Redis pod kill to exercise cache-miss / failover behavior.
render_experiment "PodChaos" "chaos-cache-pod-kill" "pod-kill" "cache" "one" \
"    labelSelectors:
      app.kubernetes.io/name: redis
      ${CELL_LABEL_KEY}: ${CELL_LABEL_VALUE}" >> "${RENDERED}"

# Provider: network partition to oracle provider endpoints.
render_experiment "NetworkChaos" "chaos-provider-partition" "partition" "provider" "all" \
"    labelSelectors:
      app.kubernetes.io/component: oracle-provider-client
      ${CELL_LABEL_KEY}: ${CELL_LABEL_VALUE}
  direction: to
  target:
    selector:
      namespaces:
        - ${NAMESPACE}
      labelSelectors:
        app.kubernetes.io/component: oracle-provider-endpoint
        ${CELL_LABEL_KEY}: ${CELL_LABEL_VALUE}
    mode: all" >> "${RENDERED}"

# Network: DNS fault to exercise resolver failure handling.
render_experiment "DNSChaos" "chaos-network-dns-fault" "error" "network" "all" \
"    labelSelectors:
      app.kubernetes.io/component: oracle-provider-client
      ${CELL_LABEL_KEY}: ${CELL_LABEL_VALUE}
  patterns:
    - "*.oracle-provider.example.com"" >> "${RENDERED}"

# Network: partition between application pods and external network.
render_experiment "NetworkChaos" "chaos-network-partition" "partition" "network" "all" \
"    labelSelectors:
      app.kubernetes.io/name: stellar-oracle
      ${CELL_LABEL_KEY}: ${CELL_LABEL_VALUE}
  direction: both
  target:
    selector:
      namespaces:
        - ${NAMESPACE}
      labelSelectors:
        app.kubernetes.io/component: external-egress
        ${CELL_LABEL_KEY}: ${CELL_LABEL_VALUE}
    mode: all" >> "${RENDERED}"

echo "==> Applying rendered experiments from ${RENDERED}"
kubectl apply -f "${RENDERED}"

# Wrap each experiment in a bounded Schedule so exercises run on a cadence
# and never exceed the configured duration.
echo "==> Creating bounded schedules (cron='${SCHEDULE}', duration=${DEFAULT_DURATION})"
for exp in \
  "chaos-db-pod-fault:PodChaos" \
  "chaos-db-network-fault:NetworkChaos" \
  "chaos-cache-pod-kill:PodChaos" \
  "chaos-provider-partition:NetworkChaos" \
  "chaos-network-dns-fault:DNSChaos" \
  "chaos-network-partition:NetworkChaos"; do
  exp_name="${exp%%:*}"
  exp_kind="${exp##*:}"
  cat <<EOF | kubectl apply -f -
---
apiVersion: chaos-mesh.org/v1alpha1
kind: Schedule
metadata:
  name: schedule-${exp_name}
  namespace: ${NAMESPACE}
  labels:
    app.kubernetes.io/part-of: chaos-exercises
    chaos.stellar-oracle.io/cell: ${CELL_LABEL_VALUE}
    chaos.stellar-oracle.io/bounded: "true"
spec:
  schedule: "${SCHEDULE}"
  concurrencyPolicy: Forbid
  historyLimit: 5
  type: ${exp_kind}
  ${exp_kind}:
    action: $(case "${exp_kind}" in
      PodChaos) echo "pod-failure" ;;
      NetworkChaos) echo "partition" ;;
      DNSChaos) echo "error" ;;
      *) echo "pod-failure" ;;
    esac)
    mode: one
    duration: ${DEFAULT_DURATION}
    selector:
      namespaces:
        - ${NAMESPACE}
      labelSelectors:
        ${CELL_LABEL_KEY}: ${CELL_LABEL_VALUE}
EOF
done

echo "Chaos Mesh installed for ${CHAOS_TARGET_ENV} environment in namespace ${NAMESPACE}."
echo "Bounded experiments applied (max duration ${MAX_DURATION_SECONDS}s, cell ${CELL_LABEL_VALUE})."
echo "To roll back: kubectl delete -f ${RENDERED} && kubectl delete schedules -n ${NAMESPACE} -l app.kubernetes.io/part-of=chaos-exercises"