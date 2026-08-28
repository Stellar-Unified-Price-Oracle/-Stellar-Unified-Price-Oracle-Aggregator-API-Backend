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

## Sandbox environment

The sandbox overlay is isolated in the `stellar-oracle-sandbox` namespace and
does not configure a production database. It serves deterministic fixtures for
XLM, USDC, BTC, ETH, and USDT. Apply it with a local reset token:

```bash
kubectl apply -k k8s/overlays/sandbox
kubectl create secret generic sandbox-credentials \
  -n stellar-oracle-sandbox \
  --from-literal=reset-token='<local-token>'
curl https://sandbox.example/api/v1/sandbox/info
curl -X POST https://sandbox.example/api/v1/sandbox/reset \
  -H 'x-sandbox-reset-token: <local-token>'
curl -X POST https://sandbox.example/api/v1/sandbox/replay \
  -H 'content-type: application/json' \
  -d '{"path":"/prices/XLM"}'
```

Sandbox data is synthetic, read-only through replay, and resettable on demand.
It has a separate namespace, endpoint, credentials, and no production database
connection. Do not use sandbox prices for financial decisions.

## Production cost controls

The production overlay applies right-sized resource requests, cost-allocation
labels, a namespace quota, and monthly run-rate alerts. Generate and verify the
cost report with:

```bash
npm run cost:analyze
npm run cost:check
```

See [the cost optimization report](../docs/COST_OPTIMIZATION.md) for assumptions,
savings by service and team, budget thresholds, and rollout guardrails.
