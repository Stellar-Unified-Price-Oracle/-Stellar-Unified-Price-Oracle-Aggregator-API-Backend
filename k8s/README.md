# Kubernetes Deployment & Chaos Engineering

Kubernetes manifests for the Stellar Unified Price Oracle **staging** environment, with Chaos Mesh for resilience validation.

## Directory layout

```
k8s/
├── base/                       # Application workloads (Kustomize)
├── overlays/staging/           # Staging overlay + secret templates
├── istio/                      # Istio mesh: mTLS, canary, observability
└── chaos/                      # Chaos Mesh experiments, schedules, reporting
```

## Quick start

```bash
./scripts/validate-k8s.sh
cp k8s/overlays/staging/secrets.example.yaml k8s/overlays/staging/secrets.yaml
kubectl apply -k k8s/overlays/staging

export CHAOS_TARGET_ENV=staging
./scripts/chaos/install-chaos-mesh.sh
```

## Multi-region deployment

The repository now includes dedicated production overlays for two regions:

- k8s/overlays/prod-us-east-1 — primary region deployment with a larger replica footprint
- k8s/overlays/prod-eu-west-1 — secondary region deployment for failover readiness

Each overlay includes the shared multi-region ConfigMaps and a global load balancer service definition under k8s/base/multi-region so the stack can be deployed in more than one cloud region with replication and automated failover settings.

See [docs/chaos-engineering/README.md](../docs/chaos-engineering/README.md) for full documentation.

## Service mesh

```bash
./scripts/install-istio-mesh.sh
kubectl apply -k k8s/istio
```

See [k8s/istio/README.md](istio/README.md).
