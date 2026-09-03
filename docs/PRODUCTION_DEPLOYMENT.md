# Production Deployment & Operations Guide

> Issue #305 — detailed production deployment guide covering environment
> setup, database provisioning, Soroban contract deployment, API key
> configuration, TLS/SSL setup, monitoring stack, and backup/restore
> procedures.

This guide is for operators deploying the Stellar Unified Price Oracle to a
production Kubernetes cluster.  It complements the quick-start in
[`DEPLOY.md`](../DEPLOY.md), the runbooks in
[`docs/runbooks/`](./runbooks/README.md), and the security controls in
[`docs/SECURITY_ARCHITECTURE.md`](./SECURITY_ARCHITECTURE.md).

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

## 7. Backup/restore procedures

**Backups** (issue #43):

- The API takes periodic encrypted backups of price history
  (`api/src/infrastructure/backup.ts`) — gzip-compressed and
  **AES-256-GCM encrypted** (same `enc:` scheme as secrets).  Metrics:
  `backup_total{result}`, `backup_size_bytes`, `backup_duration_ms`.
- For the database, snapshot at the storage layer (RDS automated snapshots
  + `pg_dump` to object storage for the TimescaleDB data).  Keep encrypted
  copies off-cluster.
- Secrets are re-creatable: `scripts/rotate-secrets.sh` can regenerate every
  category; never rely on a single `.env` copy.

**Restore:**

1. **Prices/history:** restore the latest encrypted backup through the API's
   restore path (verify decryption with the same `ENCRYPTION_KEY` /
   `ENCRYPTION_KEY_PREVIOUS` used at backup time).
2. **Database:** restore the `pg_dump` (or RDS snapshot) into a fresh
   instance, point `DATABASE_URL` at it, and re-run the TimescaleDB setup
   (`USE_TIMESCALEDB=true`).
3. **Contract state:** the Soroban contract is the source of truth on-chain;
   if the database is fully lost, prices re-populate from the contract on the
   next aggregation cycle — treat the DB as a cache/history store, not the
   feed's authority.
4. **Validate:** check `/health`, spot-check a few assets via the API, and
   confirm `onchain_price_staleness_seconds` is healthy before declaring the
   restore complete.  See `docs/runbooks/disaster-recovery.md`.

## 8. Operating the platform

- **Deploy a release:** build images, then
  `./scripts/deploy-k8s.sh <dev|staging|prod> <api-image> <aggregator-image>`
  (Kustomize + `kubectl apply --server-side`).  For a zero-downtime web cutover
  use `./scripts/deploy-blue-green.sh <image-tag>` (smoke-tests the health URL
  before/after cutover).
- **Multi-region:** production overlays exist for `prod-us-east-1` and
  `prod-eu-west-1` (active-active; see `k8s/overlays/prod-*` and
  `docs/active-active-multi-region.md`).
- **Scaling:** HPA manifests scale API/aggregator on CPU and custom metrics
  (rate, staleness).
- **Chaos validation:** `scripts/chaos/install-chaos-mesh.sh` +
  `k8s/chaos/` experiments validate resilience in staging before major
  changes (see `k8s/README.md`).
- **Incident response:** use the runbooks in `docs/runbooks/` — price feed
  stale, oracle source down, high error rate, contract failures, database
  issues, disaster recovery — and the post-mortem template.

## 9. Pre-flight checklist (production)

- [ ] `npm ci` clean; all test suites green (api, aggregator, contract).
- [ ] `.env` created from `.env.example`; secrets stored as `enc:v1:…`.
- [ ] Database provisioned (private subnet / restricted SG), migrations run,
      `DATABASE_URL` reachable from API pods.
- [ ] Contract deployed behind the proxy; `CONTRACT_ID` set;
      `get_api_version()` recorded; verification report generated.
- [ ] Admin API keys created and rotated into Vault; tier limits reviewed.
- [ ] TLS terminates at the gateway with a valid certificate; HTTPS only.
- [ ] Prometheus scraping both services; Grafana dashboard imported; SLO
      alerts configured; Jaeger receiving traces.
- [ ] Backups verified with a restore drill; retention set
      (`HISTORY_RETENTION_DAYS`).
- [ ] Istio mTLS enabled (or equivalent network policy — see
      `k8s/base/networkpolicy.yaml`).
- [ ] `docs/runbooks/*` reviewed by on-call; on-call has access to the
      encrypted secrets and rotation scripts.

## Related documents

- [`DEPLOY.md`](../DEPLOY.md) — quick start (local, Docker, Fly/Railway)
- [`docs/runbooks/README.md`](./runbooks/README.md) — incident runbooks
- [`docs/security/secret-rotation.md`](./security/secret-rotation.md) — secret rotation runbook
- [`docs/SECURITY_ARCHITECTURE.md`](./SECURITY_ARCHITECTURE.md) — security controls & threat model
- [`docs/CANARY_DEPLOYMENTS.md`](./CANARY_DEPLOYMENTS.md) — staged contract upgrades
- [`docs/CONTRACT_UPGRADE_GOVERNANCE.md`](./CONTRACT_UPGRADE_GOVERNANCE.md) — upgrade quorum & multisig
