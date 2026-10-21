# Production Deployment & Operations Guide

> Issue #305 — detailed production deployment guide covering environment
> setup, database provisioning, Soroban contract deployment, API key
> configuration, TLS/SSL setup, monitoring stack, and backup/restore
> procedures.

This guide is for operators deploying the Stellar Unified Price Oracle to a
production Kubernetes cluster.  It complements the quick-start in
[`DEPLOY.md`](../DEPLOY.md), the runbooks in
[`docs/runbooks/`](./runbooks/README.md), and the security controls in
[`docs/SECURITY_ARCHITECTURE.md`](./SECURITY_ARCHITECTURE.md). Secret storage,
Vault fail-closed behaviour, and the staging/sandbox templates are documented in
[`docs/SECRET_STORAGE.md`](./SECRET_STORAGE.md).

## Architecture at a glance

| Component | Purpose | Config entrypoint |
|---|---|---|
| `api/` | Express REST + WebSocket gateway, auth, rate limiting, price serving | `.env` → `api/src/infrastructure/config.ts` |
| `services/aggregator/` | Polls oracle sources, aggregates, submits to the Soroban contract | `.env` → `services/aggregator/src/infrastructure/config.ts` |
| TimescaleDB/PostgreSQL | Historical price storage (hypertables, issue #42) | `DATABASE_URL` |
| Soroban proxy contract | On-chain source of truth for prices | `CONTRACT_ID`, `ADMIN_SECRET_KEY` |
| Prometheus + Grafana + Jaeger | Metrics, dashboards, tracing | `monitoring/`, `k8s/istio/observability/` |

Reference manifests: `k8s/base/` (workloads via Kustomize), overlays in
`k8s/overlays/{dev,staging,prod,prod-us-east-1,prod-eu-west-1,sandbox}`,
Istio mesh in `k8s/istio/`, Terraform in `infrastructure/terraform/`.

## 1. Environment setup

1. **Clone and install** — `npm ci` at the repo root (npm workspaces for
   `api`, `services/aggregator`, `packages/*`).
2. **Create `.env` from the template** — `cp .env.example .env` and fill in
   values (see §2–§5 below).  The template documents every variable with its
   default; the aggregator and API each load `../.env` from their own
   directory, so a single root `.env` serves both.
3. **Secrets are encrypted at rest** — sensitive values
   (`ADMIN_SECRET_KEY`, `DATABASE_URL`, source API keys) should be stored as
   `enc:v1:<keyId>:…` payloads produced by
   `scripts/encrypt-secret.ts` and decrypted transparently at startup by
   `decryptSecret` (issue #41, see `docs/SECURITY_ARCHITECTURE.md` §2/§6).
4. **Verify locally first** — run the API test suite (`cd api && npm test`),
   the aggregator suite (`cd services/aggregator && npm test`), and the
   contract suite (`cd contracts/price-oracle && cargo test`) before any
   deploy.

## 1.5 Topology-aware scheduling for stateless workloads

The stateless API and aggregator Deployments intentionally spread replicas across node and zone topology while keeping the scheduler permissive enough to support HPA-driven scale-up. The base manifests use:

- `topologySpreadConstraints` on `kubernetes.io/hostname` with `maxSkew: 1` and `whenUnsatisfiable: ScheduleAnyway`.
- `topologySpreadConstraints` on `topology.kubernetes.io/zone` with `maxSkew: 1` and `whenUnsatisfiable: ScheduleAnyway`.
- preferred pod anti-affinity for replicas of the same service (`app: api` and `app: aggregator`) on the same host.

This is intentionally not `DoNotSchedule`: in single-node or partially degraded environments, the scheduler should still place additional replicas when a domain is unavailable, rather than permanently blocking HPA scale-out. The production overlays (`prod`, `prod-us-east-1`, `prod-eu-west-1`) are treated as multi-zone-capable and therefore include both hostname and zone spreads; the single-node development environment keeps the same policy but the zone spread is a best-effort placement hint rather than a hard blocker.

Redis (`k8s/base/redis/`) and TimescaleDB (`k8s/base/timescaledb/`) are stateful services with their own placement assumptions; they are not covered by the stateless API/aggregator policy. The database stateful sets already use anti-affinity and zone-aware spread separately, so the stateless workload changes intentionally avoid interfering with their storage-backed topology requirements.

## 2. Database provisioning

- **Self-hosted (compose):** `docker-compose.yml` runs
  `timescale/timescaledb:latest-pg16` with `POSTGRES_USER/PASSWORD/DB`,
  a persistent volume, and a `pg_isready` healthcheck.
- **AWS RDS (Terraform):** `infrastructure/terraform/modules/database/main.tf`
  provisions a PostgreSQL instance in a private subnet with a security group
  that admits traffic **only from the API security group** on 5432 — no
  public exposure.  Drive it with
  `cd infrastructure/terraform && terraform plan/apply`.
- **Kubernetes:** `k8s/base/timescaledb/` provides the in-cluster option;
  wire the connection string via the `timescaledb` secret in
  `k8s/base/secrets.yaml`.
- **Connection settings** (`.env`): `DATABASE_POOL_MIN/MAX` (default 2/20),
  `DATABASE_IDLE_TIMEOUT_MS`, `DATABASE_CONNECTION_TIMEOUT_MS`,
  `DATABASE_STATEMENT_TIMEOUT_MS` (issue #44).  `USE_TIMESCALEDB=true`
  creates hypertables for the integer `timestamp` dimension with
  `TIMESCALE_CHUNK_INTERVAL_SECONDS` (default 7 days).  Optional retention:
  `HISTORY_RETENTION_DAYS` (0 = keep forever) — archived/deleted by
  `api/src/infrastructure/archival.ts` (issue #43).
- **Database URL is a secret** — encrypt it
  (`scripts/encrypt-secret.ts encrypt 'postgresql://…'`) before putting it
  in `.env` or the cluster secret.

## 3. Soroban contract deployment

1. **Build & deploy the implementation** —
   `node scripts/deploy-soroban.js` (testnet) or `--mainnet`, which builds
   `contracts/price-oracle` (`cargo build --release`), uploads the wasm, and
   creates the contract.  Record the resulting `CONTRACT_ID` in `.env`.
2. **Deploy behind the proxy** — production consumers point at the proxy
   contract id; deploy/upgrade it via the proxy's `upgrade`/`upgrade_wasm`
   flow (`contracts/price-oracle/src/proxy.rs`), using the multi-sig
   quorum where enabled (see `docs/CONTRACT_UPGRADE_GOVERNANCE.md`).
3. **Staged upgrades via canaries** — for any behavioral change, use the
   canary flow (`node scripts/deploy-canary.js deploy|promote|rollback`,
   `docs/CANARY_DEPLOYMENTS.md`) so a fraction of live traffic exercises the
   new implementation before promotion.  The aggregator routes the on-chain
   `canary_traffic_share_bps` automatically.
4. **Contract verification** — run `node scripts/generate-verification-report.mjs`
   after deploy; the CI workflow posts the report on PRs
   (`.github/workflows/ci.yml`).
5. **ABI stability** — confirm `get_api_version()` is unchanged for
   non-breaking upgrades (`docs/CONTRACT_VERSIONING.md`).

## 4. API key configuration

- **Admin bootstrap** — an initial admin key is created via the governance
  admin flow; the full key is shown exactly once, only its SHA-256 hash is
  stored (`api-key-manager.ts`).
- **Tiers & limits** — keys carry a tier (`free`/`pro`/`enterprise`/`admin`)
  with per-minute rate limits (60 / 500 / 10 000 / 100 000).  `express-rate-limit`
  enforces a global window (`RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`) and the
  key manager enforces per-key budgets.
- **Rotation** — use `scripts/rotate-secrets.sh api-keys` (with `--dry-run`
  first).  Rotation uses a grace window (`rotationExpiresAt`) so existing
  consumers keep working until the window closes.
- **Vault** — key metadata is synced to/from Vault via `packages/vault-client`
  (`api-key-manager.loadKeysFromVault` / `exportKeysForVault`); keep Vault
  reachable from the API pods (`VAULT_*` settings).

## 5. TLS/SSL setup

- **In-cluster (Istio):** enable the Istio mesh (`k8s/istio/`) and use
  mTLS (`k8s/istio/peer-authentication.yaml`) for east-west traffic.  For
  ingress TLS, terminate at the gateway with a `cert-manager`-issued
  certificate (or your provider's cert) and annotate the Gateway
  accordingly.  Reference: `k8s/overlays/prod-*/` and `k8s/istio/`.
- **Managed cloud:** on Fly.io/Railway use their platform TLS; on AWS ECS,
  attach the ALB certificate and force HTTPS via a redirect rule.
- **Enforce HTTPS end-to-end:** API must be reachable only over TLS;
  WebSocket upgrades inherit the same TLS listener (`WS_PORT`).
- **Verification:** `scripts/scan-image.sh` and
  `scripts/validate-k8s.sh` can be run in CI to catch TLS/config mistakes
  before they reach prod.

## 6. Monitoring stack

- **Metrics** — Prometheus scrapes the API and aggregator (`/metrics` via
  `prom-client`; see `services/aggregator/src/observability/metrics.ts` and
  the API equivalent).  Prebuilt dashboard:
  `monitoring/grafana-dashboard.json`; alert rules:
  `k8s/base/prometheus-rule.yaml`.
- **Tracing** — OpenTelemetry exporters send traces to Jaeger
  (`api/src/services/tracing.ts`); `docker-compose.yml` runs the all-in-one
  image for local dev; `k8s/istio/observability/` provisions Prometheus,
  Grafana, Jaeger, and Kiali.
- **Key SLOs to watch** (see `scripts/generate-slo-report.ts`):
  - Price staleness: `onchain_price_staleness_seconds` must stay under
    `STALENESS_THRESHOLD_MS`.
  - Source health/uptime and SLA breaches (`oracleSourceUptimePercent`,
    `oracleSourceSlaBreaches`).
  - API availability/error rates (`uptimeTracker`, WS reachability checks on
    `/health`).
  - Canary health during staged upgrades (`canary_*` metrics, issue #105).
- **Health endpoints** — the API exposes `/health` (with WS reachability
  check); configure the k8s probes (`k8s/base/` deployments) and HPA
  (`k8s/hpa.yaml`, `k8s/custom-metrics-hpa.yaml`) against them.

## 7. Maintenance-capacity guarantees (PDBs & rollouts)

A voluntary disruption — node drain, cluster upgrade, autoscaler scale-down —
may evict every replica of a workload unless a `PodDisruptionBudget` caps the
number of simultaneous evictions.  For a price oracle consumed by DeFi
protocols, a drain-induced total outage is a real availability event, so every
stateless workload ships with a PDB and a capacity-preserving rollout strategy.

### PDB minimum math

The API and aggregator each run at **2 replicas** and the HPA floor is
`minReplicas: 2`.  The SLOs in `monitoring/slo.yml` assume availability during
maintenance, so we must always keep **at least one** replica serving:

- `minAvailable: 1` with `replicas: 2` permits exactly one voluntary eviction
  at a time — a drain takes one pod, the other keeps serving, and the evicted
  pod is rescheduled before the next eviction is allowed.
- `minAvailable: 2` with `replicas: 2` would forbid **all** voluntary
disruptions (no drain could ever complete) — a different failure mode, and
  the reason the PDB minimum must stay strictly below the HPA minimum.

**Compatibility rule:** `PDB.minAvailable < HPA.minReplicas`.  With
`minReplicas: 2` the only valid value is `minAvailable: 1`.  If the HPA floor
is ever raised to 3, the PDB may be raised to 2 — never to the HPA floor.

### Rolling-update strategy

Each Deployment sets an explicit strategy so a rollout cannot reduce capacity
to zero:

- `strategy.rollingUpdate.maxUnavailable: 0` — never take a pod out of
  service before its replacement is Ready.
- `strategy.rollingUpdate.maxSurge: 1` — bring one extra pod up first, then
  retire the old one.

With `replicas: 2` this keeps 2 pods serving throughout the rollout (surge to
3, then settle back to 2).  Verify the strategy against the replica count and
the HPA minimum whenever either changes: `maxUnavailable` must be `0` while
`replicas == HPA.minReplicas`, otherwise a rollout can dip below the PDB
minimum.

### Blue-green pair

The blue-green deployments (`k8s/overlays/*/blue-green/`) are a pair of
Deployments behind a single Service.  Each colour gets its own PDB with the
same `minAvailable: 1` math, so a drain during a cutover cannot evict both the
active and the standby colour at once.  The failover policy resources
(`k8s/base/failover-policy.yaml`) reference the Service, not the individual
Deployments, so they inherit the PDB guarantee — confirm the failover policy
still points at the Service after any blue-green change.

### CI enforcement

`scripts/validate-k8s.sh` (run in `.github/workflows/ci.yml`) fails the build
when a Deployment has no matching `PodDisruptionBudget` in the same overlay,
so a new workload cannot ship without one.  The check matches PDBs to
Deployments by `spec.selector.matchLabels`, the same selector the Deployment
uses for its pods.

## 8. Backup/restore procedures

**Backups** (issue #43):

- The API takes periodic encrypted backups of p

/* … truncated 3920 chars — edit only what you need near the top … */
