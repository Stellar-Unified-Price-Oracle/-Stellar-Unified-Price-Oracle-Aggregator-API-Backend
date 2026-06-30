# Istio service mesh (Stellar Oracle)

Istio manifests for mTLS, canary routing, egress to oracle providers, and the observability stack (Prometheus alerts, Jaeger, Kiali, Grafana).

## Layout

```
k8s/istio/
├── istio-operator.yaml          # Istio control plane (meshID: stellar-oracle)
├── peer-authentication.yaml     # STRICT mTLS in stellar-oracle
├── authorization-policy.yaml    # Namespace-scoped ALLOW rules
├── destination-rules.yaml       # Subsets + ISTIO_MUTUAL for api/aggregator/timescaledb
├── virtual-services.yaml        # Ingress TLS, 90/10 API canary, WS + internal routes
├── telemetry.yaml               # 10% Jaeger trace sampling
├── observability/               # Jaeger, Kiali, Grafana, Prometheus monitors
└── service-profiles.yaml        # External oracle ServiceEntry + egress routing
```

## Prerequisites

- Kubernetes 1.26+
- `kubectl` and `istioctl` (or Istio operator installed)
- Prometheus Operator CRDs for `ServiceMonitor` / `PodMonitor`
- Jaeger Operator for `Jaeger` CR
- Kiali Operator for `Kiali` CR

## Install

```bash
./scripts/install-istio-mesh.sh
kubectl apply -k k8s/istio
```

Create TLS secret `stellar-oracle-tls` in `stellar-oracle` before exposing the HTTPS gateway.

## Validation

```bash
python3 scripts/validate-k8s-yaml.py
./scripts/validate-k8s.sh
```

## Traffic

| Route | Behavior |
|-------|----------|
| `api` VirtualService | 90% stable / 10% canary on HTTP `/api` |
| `api-ws` VirtualService | 90/10 split on TCP port 3001 |
| `aggregator-internal` | Stable subset to port 4000 |
| `oracle-egress` | HTTPS egress via `istio-egressgateway` |

Mesh identity: **stellar-oracle** (`meshID` on IstioOperator and proxy metadata).
