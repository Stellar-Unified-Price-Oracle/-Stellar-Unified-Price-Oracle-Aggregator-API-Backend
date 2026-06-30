# Chaos Engineering (Kubernetes)

Chaos Mesh manifests for validating Stellar Unified Price Oracle resilience in **staging** only.

## Directory layout

```
k8s/chaos/
├── namespace.yaml              # stellar-oracle namespace (environment: staging)
├── kustomization.yaml          # Kustomize entrypoint
├── install/
│   ├── rbac.yaml               # chaos-operator and chaos-reporting RBAC
│   └── helm-values.yaml        # Namespace-scoped Chaos Mesh Helm values
├── experiments/                # Pod, network, DNS, and stress experiments
├── schedules/                  # Weekly serial workflow + staging-guard CronJob
└── reporting/                  # Monday post-game report CronJob
```

## Quick start

```bash
export CHAOS_TARGET_ENV=staging
./scripts/chaos/install-chaos-mesh.sh
```

Validate manifests locally:

```bash
./scripts/validate-k8s.sh
```

Generate a report after experiments:

```bash
export CHAOS_TARGET_ENV=staging
./scripts/chaos/generate-report.sh reports/chaos-report.md
```

## Safety

- All automation requires `CHAOS_TARGET_ENV=staging`.
- The weekly resilience CronJob verifies the `stellar-oracle` namespace carries `environment: staging`.
- Chaos Mesh is installed with `clusterScoped: false` and limited to the `stellar-oracle` namespace.

See [docs/chaos-engineering/README.md](../docs/chaos-engineering/README.md) for runbooks and game-day procedures.
