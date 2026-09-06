# Synthetic Monitoring & Black-Box Probes (#415)

**Goal:** verify the public API from a customer's perspective.

Internal health checks (`/health`, readiness probes, in-cluster Prometheus
scrapes) all sit *inside* the trust boundary. They cannot see a broken external
DNS record, an expired or mis-chained TLS certificate, a mis-configured
ingress / WAF rule, a CDN outage, or BGP-level routing loss. Synthetic probes run
from **outside the cluster** and exercise the same path a downstream DeFi
protocol would.

## Probe targets

| Probe | Target | Success criteria | Interval |
|-------|--------|------------------|----------|
| `prices` | `GET https://api.<domain>/api/v1/prices?pair=XLM-USD` | HTTP 200, `Content-Type: application/json`, body has numeric `price`, latency < 1s | 30s |
| `history` | `GET https://api.<domain>/api/v1/history?pair=XLM-USD&interval=1h&limit=10` | HTTP 200, JSON array length ≥ 1, latency < 2s | 60s |
| `health` | `GET https://api.<domain>/health` | HTTP 200, body `{"status":"ok"}` | 30s |
| `ws-subscribe` | `wss://api.<domain>/ws` → send `{"type":"subscribe","pair":"XLM-USD"}` | connection upgrades, a `price` message received within 10s, clean close | 60s |
| `tls-expiry` | TLS handshake to `api.<domain>:443` | cert valid, chain complete, `notAfter` > 21 days away | 300s |
| `dns` | resolve `api.<domain>` | resolves, answer matches expected ingress IP set | 60s |

Probes run from **at least two regions** that are *not* the primary serving
region, plus one third-party vantage point, so a single-region network fault does
not create a false positive or mask a real one.

## Deployment

Two mechanisms, both feeding the same Prometheus/Alertmanager:

1. **In-cluster-adjacent** — `prometheus-blackbox-exporter` deployed in a
   separate failure domain (different node pool / cloud project), scraped via the
   `Probe` CRD. Manifests: `k8s/base/synthetic-probes.yaml`
   (blackbox-exporter Deployment + Service + ConfigMap of modules, and `Probe`
   resources for the HTTP targets).
2. **Fully external** — a scheduled job (`monitoring/synthetic/probe.mjs`, run
   from CI cron / a serverless function in another provider) that performs the
   HTTP + WebSocket checks end-to-end and pushes results to the Pushgateway /
   remote-write endpoint. This is the only probe that can catch a total
   cloud-provider outage.

The WebSocket subscribe flow is not expressible in blackbox-exporter, so it is
always driven by the external `probe.mjs` script.

## Alerting — independent of internal signals

See `k8s/base/synthetic-probes.yaml` rule group `stellar-oracle.synthetic`:

- `SyntheticProbeFailed` — `probe_success == 0` for a target, 2m. **Routed to a
  different Alertmanager receiver** than internal alerts, and evaluated on probe
  data only, so a broken internal scrape path cannot suppress it.
- `SyntheticProbeLatencyHigh` — `probe_duration_seconds` over the per-target SLO.
- `SyntheticProbeTLSExpiringSoon` — `probe_ssl_earliest_cert_expiry - time()` < 21d.
- `SyntheticProbeMultiRegionDown` — the same target failing from ≥ 2 vantage
  points → `critical`, page immediately (true customer-facing outage).
- `SyntheticProbeSingleRegionDown` — one vantage point only → `warning`
  (likely a probe-side network issue, investigate before paging).

Because these fire from data collected outside the cluster, they still alert even
if the cluster, its Prometheus, or its ingress is completely down — as long as
the external probe runner and its remote-write target survive.

## SLO dashboard

Probe results are added to the SLO dashboard
(`docs/dashboards/` / `monitoring/grafana-dashboard.json`) as:

- **Availability** row: `avg_over_time(probe_success[30d])` per public endpoint,
  compared against the 99.9% target error budget.
- **Latency** row: `probe_duration_seconds` p50/p95/p99 per endpoint and region.
- **TLS** stat panel: days until earliest cert expiry.
- **Blackbox vs. internal** overlay: `probe_success` next to the internal
  `up` / error-rate series, so divergence (external red, internal green =
  routing/DNS/TLS fault) is visible at a glance.

These panels are the customer-truth source for the public status page (#416).
