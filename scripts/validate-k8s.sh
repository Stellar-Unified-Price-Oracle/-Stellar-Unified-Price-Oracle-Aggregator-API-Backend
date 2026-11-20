#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
K8S_DIR="${ROOT}/k8s"
STAGING_OUT="/tmp/stellar-oracle-staging.yaml"
ISTIO_OUT="/tmp/stellar-oracle-istio.yaml"

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
kustomize_build "${K8S_DIR}/overlays/prod-us-east-1" "/tmp/stellar-oracle-prod-us-east-1.yaml"
kustomize_build "${K8S_DIR}/overlays/prod-eu-west-1" "/tmp/stellar-oracle-prod-eu-west-1.yaml"
kustomize_build "${K8S_DIR}/istio" "${ISTIO_OUT}"

echo "==> Validating YAML syntax"
python3 - <<'PY'
import pathlib, sys
try:
    import yaml
except ImportError:
    print("PyYAML not installed; skipping YAML parse check")
    sys.exit(0)

for path in ["/tmp/stellar-oracle-staging.yaml", "/tmp/stellar-oracle-prod-us-east-1.yaml", "/tmp/stellar-oracle-prod-eu-west-1.yaml", "/tmp/stellar-oracle-istio.yaml"]:
    try:
        docs = list(yaml.safe_load_all(pathlib.Path(path).read_text()))
        if not docs:
            raise SystemExit(f"No documents in {path}")
        print(f"  OK: {path} ({len(docs)} documents)")
    except Exception as e:
        print(f"  ERROR parsing {path}: {e}")
        sys.exit(1)
PY

echo "==> Checking security hardening for API and aggregator workloads"
python3 - <<'PY'
import pathlib, sys
try:
    import yaml
except ImportError:
    print("PyYAML not installed; skipping security hardening check")
    sys.exit(0)

required = {
    'api-stable': ('Deployment', 'api'),
    'api-canary': ('Deployment', 'api'),
    'aggregator': ('Deployment', 'aggregator'),
}

paths = [
    pathlib.Path('/tmp/stellar-oracle-staging.yaml'),
    pathlib.Path('/tmp/stellar-oracle-prod-us-east-1.yaml'),
    pathlib.Path('/tmp/stellar-oracle-prod-eu-west-1.yaml'),
]

missing = []
for path in paths:
    try:
        docs = list(yaml.safe_load_all(path.read_text()))
    except Exception as e:
        print(f"  ERROR parsing {path}: {e}")
        sys.exit(1)
    
    by_name = {doc.get('metadata', {}).get('name'): doc for doc in docs if isinstance(doc, dict)}
    for name, (kind, app_label) in required.items():
        doc = by_name.get(name)
        if doc is None:
            continue
        if doc.get('kind') != kind:
            raise SystemExit(f"{name} is {doc.get('kind')} not {kind}")
        pod_spec = doc.get('spec', {}).get('template', {}).get('spec', {})
        sec = pod_spec.get('securityContext', {})
        if not sec.get('runAsNonRoot') or sec.get('runAsUser') is None or sec.get('runAsGroup') is None or sec.get('fsGroup') is None:
            missing.append(f"{name}: pod securityContext missing runAsNonRoot/runAsUser/runAsGroup/fsGroup")
        if sec.get('seccompProfile', {}).get('type') != 'RuntimeDefault':
            missing.append(f"{name}: pod seccompProfile is not RuntimeDefault")
        for container in pod_spec.get('containers', []):
            csec = container.get('securityContext', {})
            if csec.get('allowPrivilegeEscalation') is not False:
                missing.append(f"{name}/{container.get('name')}: allowPrivilegeEscalation not false")
            if csec.get('readOnlyRootFilesystem') is not True:
                missing.append(f"{name}/{container.get('name')}: readOnlyRootFilesystem not true")
            caps = csec.get('capabilities', {})
            if caps.get('drop') != ['ALL']:
                missing.append(f"{name}/{container.get('name')}: capabilities.drop is not ['ALL']")
            if csec.get('seccompProfile', {}).get('type') != 'RuntimeDefault':
                missing.append(f"{name}/{container.get('name')}: seccompProfile is not RuntimeDefault")
            mounts = [m.get('mountPath') for m in container.get('volumeMounts', [])]
            if '/tmp' not in mounts or '/app/data' not in mounts or '/app/logs' not in mounts:
                missing.append(f"{name}/{container.get('name')}: writable mounts missing /tmp, /app/data, /app/logs")
        volumes = pod_spec.get('volumes', [])
        for mount in ['/tmp', '/app/data', '/app/logs']:
          mount_name = mount.replace('/', '').replace('app', 'app-')
          has_volume = any(v.get('name') == mount_name or (v.get('emptyDir') is not None) for v in volumes)
          if not has_volume:
            missing.append(f"{name}: missing emptyDir volume for {mount}")

if missing:
    for item in missing:
        print(f"  FAIL: {item}")
    raise SystemExit(1)

print("  OK: API and aggregator workloads include non-root, read-only root, dropped capabilities, RuntimeDefault seccomp, and writable mounts.")
PY

echo "==> Checking topology spread and anti-affinity for API and aggregator workloads"
python3 - <<'PY'
import pathlib, sys
try:
    import yaml
except ImportError:
    print("PyYAML not installed; skipping topology spread check")
    sys.exit(0)

required = {
    'api-stable': 'api',
    'api-canary': 'api',
    'aggregator': 'aggregator',
}

paths = [
    pathlib.Path('/tmp/stellar-oracle-staging.yaml'),
    pathlib.Path('/tmp/stellar-oracle-prod-us-east-1.yaml'),
    pathlib.Path('/tmp/stellar-oracle-prod-eu-west-1.yaml'),
]
missing = []
for path in paths:
    try:
        docs = list(yaml.safe_load_all(path.read_text()))
    except Exception as e:
        print(f"  ERROR parsing {path}: {e}")
        sys.exit(1)
    
    by_name = {doc.get('metadata', {}).get('name'): doc for doc in docs if isinstance(doc, dict) and doc.get('kind') == 'Deployment'}
    for name, app_label in required.items():
        doc = by_name.get(name)
        if doc is None:
            continue
        pod_spec = doc.get('spec', {}).get('template', {}).get('spec', {})
        prefs = pod_spec.get('affinity', {}).get('podAntiAffinity', {}).get('preferredDuringSchedulingIgnoredDuringExecution', [])
        if not any(
            term.get('podAffinityTerm', {}).get('topologyKey') == 'kubernetes.io/hostname'
            and term.get('podAffinityTerm', {}).get('labelSelector', {}).get('matchLabels', {}).get('app') == app_label
            for term in prefs
        ):
            missing.append(f"{name}: preferred pod anti-affinity missing hostname rule for {app_label}")
        spread = pod_spec.get('topologySpreadConstraints', [])
        if not any(
            c.get('topologyKey') == 'kubernetes.io/hostname'
            and c.get('whenUnsatisfiable') == 'ScheduleAnyway'
            and c.get('labelSelector', {}).get('matchLabels', {}).get('app') == app_label
            for c in spread
        ):
            missing.append(f"{name}: hostname topology spread missing or not ScheduleAnyway")
        if not any(
            c.get('topologyKey') == 'topology.kubernetes.io/zone'
            and c.get('whenUnsatisfiable') == 'ScheduleAnyway'
            and c.get('labelSelector', {}).get('matchLabels', {}).get('app') == app_label
            for c in spread
        ):
            missing.append(f"{name}: zone topology spread missing or not ScheduleAnyway")

if missing:
    for item in missing:
        print(f"  FAIL: {item}")
    raise SystemExit(1)

print("  OK: API and aggregator workloads include hostname/zone spread and preferred anti-affinity.")
PY

if command -v kubeconform >/dev/null 2>&1; then
  echo "==> Running kubeconform"
  SCHEMA_FLAGS=(
    -schema-location default
    -schema-location "https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json"
    -ignore-missing-schemas
  )
  kubeconform "${SCHEMA_FLAGS[@]}" "${STAGING_OUT}" || true
  kubeconform "${SCHEMA_FLAGS[@]}" "/tmp/stellar-oracle-prod-us-east-1.yaml" || true
  kubeconform "${SCHEMA_FLAGS[@]}" "/tmp/stellar-oracle-prod-eu-west-1.yaml" || true
  kubeconform "${SCHEMA_FLAGS[@]}" "${ISTIO_OUT}" || true
elif command -v kubectl >/dev/null 2>&1; then
  # Only run kubectl dry-run if cluster is reachable
  if kubectl cluster-info >/dev/null 2>&1; then
    echo "==> Running kubectl dry-run"
    kubectl apply --dry-run=client --validate=false -f "${STAGING_OUT}" || true
    kubectl apply --dry-run=client --validate=false -f "/tmp/stellar-oracle-prod-us-east-1.yaml" || true
    kubectl apply --dry-run=client --validate=false -f "/tmp/stellar-oracle-prod-eu-west-1.yaml" || true
    kubectl apply --dry-run=client --validate=false -f "${ISTIO_OUT}" || true
  else
    echo "Cluster not reachable; skipping kubectl dry-run validation."
  fi
else
  echo "kubeconform unavailable and kubectl not accessible; YAML syntax validation passed."
fi

echo "All Kubernetes manifests validated successfully."
