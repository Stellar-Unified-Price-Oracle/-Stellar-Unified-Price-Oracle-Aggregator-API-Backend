# Stellar Unified Price Oracle & Aggregator API

A Soroban-based price oracle aggregator that pulls from **Chainlink**, **Redstone**, **Band Protocol**, and **Reflector**, normalises the data, and exposes it through a single clean API. Any DeFi protocol on Stellar can plug into it for reliable price feeds.

## Architecture

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Chainlink   │────▶│              │     │              │
│  Redstone    │────▶│  Aggregator  │────▶│  Soroban     │
│  Band        │────▶│  Service     │     │  Contract    │
│  Reflector   │────▶│  (poll+push) │     │  (on-chain)  │
└──────────────┘     └──────┬───────┘     └──────────────┘
                            │
                     ┌──────▼───────┐
                     │  REST + WS   │
                     │  API         │
                     │  :3000/3001  │
                     └──────────────┘
```

## Components

| Component | Tech | Description |
|-----------|------|-------------|
| **Soroban Contract** (`contracts/price-oracle/`) | Rust | On-chain price storage, admin auth, multi-source submissions, historical queries, multisig governance |
| **Aggregator** (`services/aggregator/`) | TypeScript/Node | Polls Chainlink, Redstone, Band, and Reflector every 30s, computes the median, pushes results to the Soroban contract, and tracks per-source health |
| **API** (`api/`) | Express | REST + WebSocket gateway — `GET /prices`, `/prices/:asset`, `/history/:asset`, `/sources`, `/health`, plus authentication, rate limiting, and Prometheus metrics |
| **WebSocket** | ws | Real-time price streams with per-asset subscription |
| **Deployment** | Docker / Kubernetes | `docker-compose.yml` for local/dev; `k8s/` manifests (base + overlays, blue-green, HPA, Istio) for cluster deployments; Terraform under `infrastructure/` for cloud resources |

## Data Flow

1. The **Aggregator** polls each configured oracle source (Chainlink, Redstone, Band, Reflector) on a fixed interval.
2. Prices are normalized to a common decimal format, and a median is computed across healthy sources.
3. The aggregated price is submitted on-chain via `submit_price` on the **Soroban Contract**, which persists it and exposes it to on-chain consumers.
4. The **API** reads current and historical prices (from its own store, kept in sync with the aggregator) and serves them over REST, and pushes live updates to subscribed clients over **WebSocket**.
5. Both services emit structured logs (Winston) and Prometheus metrics, scraped for the dashboards under `monitoring/`.

## Deployment Topology

- **Local development**: `make dev-aggregator` and `make dev-api` run each service directly against `.env` config.
- **Docker Compose**: `docker compose up -d` runs the aggregator, API, and their dependencies (Postgres, etc.) as containers on one host — see `docker-compose.yml` and `DEPLOY.md`.
- **Kubernetes**: `k8s/base` defines the core Deployments/Services; `k8s/overlays` layers environment-specific config, with `k8s/blue-green` and `k8s/istio` supporting zero-downtime rollouts and traffic shaping, and `k8s/hpa.yaml` / `k8s/custom-metrics-hpa.yaml` handling autoscaling.
- **Multi-region**: see `docs/multi-region.md` and `docs/active-active-multi-region.md` for cross-region topology.
- **On-chain**: the Soroban contract is deployed independently to Stellar testnet/mainnet via `scripts/deploy-soroban.js`.

## Documentation

- [`docs/index.md`](docs/index.md) — documentation home, architecture overview, and links to ADRs, runbooks, and the API reference
- [`docs/terms-of-service.md`](docs/terms-of-service.md) — consumer terms and legal boundaries for the API
- [`docs/acceptable-use-policy.md`](docs/acceptable-use-policy.md) — permitted use, security requirements, and abuse handling
- [`docs/service-sla.md`](docs/service-sla.md) — SLO-aligned uptime, latency, and response commitments
- [`docs/fee-schedule.md`](docs/fee-schedule.md) — billing model, tiered access, and fee collection path
- [`docs/audit-log-retention.md`](docs/audit-log-retention.md) — audit retention policy and tamper-evident verification steps
- [`DEPLOY.md`](DEPLOY.md) — step-by-step deploy guide (local, Docker, Soroban contract)
- [`INTEGRATION_TESTS.md`](INTEGRATION_TESTS.md) — integration test setup and execution
- [`api/docs/API.md`](api/docs/API.md) — full REST + WebSocket API reference: auth, rate limiting, error codes, request/response examples
- [`api/docs/`](api/docs) — other API-specific docs: migrations, tracing, security, deprecation policy, TimescaleDB
- [`docs/adr/`](docs/adr) — Architecture Decision Records
- [`docs/runbooks/`](docs/runbooks) — operational runbooks
- Swagger UI at `/api/v1/docs` (generated from `api/openapi.json`) — full REST API reference with request/response examples

## Quick Start

```bash
# Install dependencies
make install

# Run in development (two terminals)
make dev-aggregator   # Terminal 1 — polls sources + WS on :4000
make dev-api          # Terminal 2 — REST on :3000, WS on :3001

# Build everything
make build
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1` | API root with endpoint listing |
| GET | `/api/v1/prices` | All current prices (optional `?asset=XLM` filter) |
| GET | `/api/v1/prices/:asset` | Single asset price |
| GET | `/api/v1/history/:asset` | Historical prices (`?from=&to=&limit=`) |
| GET | `/api/v1/sources` | Oracle source metadata |
| GET | `/api/v1/health` | Service health status |
| GET | `/api/v1/docs` | Swagger UI documentation |
| GET | `/metrics` | Prometheus metrics |

### WebSocket

Connect to `ws://localhost:3001` and subscribe:

```json
{"type": "subscribe", "assets": ["XLM", "BTC"]}
{"type": "unsubscribe", "assets": ["BTC"]}
{"type": "ping"}
```

## Soroban Contract

Located at `contracts/price-oracle/`. Key functions:

| Function | Description |
|----------|-------------|
| `initialize(admin)` | Set contract admin |
| `submit_price(source, asset, price, decimals, timestamp)` | Submit a price (authorized sources only) |
| `get_price(asset)` | Get latest price with USD conversion |
| `add_oracle_source(admin, source, name)` | Authorize a new oracle source |
| `get_price_history(asset, limit)` | Get historical price data points |

### Deploy

```bash
cp .env.example .env
# Edit .env with your ADMIN_SECRET_KEY
node scripts/deploy-soroban.js        # testnet
node scripts/deploy-soroban.js --mainnet  # mainnet
```

## Configuration

See `.env.example` for all options:

| Variable | Default | Description |
|----------|---------|-------------|
| `POLLING_INTERVAL_MS` | 30000 | Source polling frequency |
| `STALENESS_THRESHOLD_MS` | 120000 | Max age before price is stale |
| `WATCHED_ASSETS` | XLM,USDC,BTC,ETH,USDT | Assets to track |
| `SOROBAN_RPC_URL` | https://soroban-testnet.stellar.org | Stellar RPC endpoint |
| `API_PORT` | 3000 | REST API port |
| `WS_PORT` | 3001 | WebSocket port |
| `RATE_LIMIT_MAX` | 100 | Max requests per window |

## Testing

```bash
make test-soroban      # Rust contract tests (requires cargo)
make test-aggregator   # TypeScript aggregator tests
make test-api          # TypeScript API tests
make test              # All tests
```

## Production

```bash
docker compose up -d
```

## Monitoring

- **Prometheus**: `/metrics` endpoint with request duration, cache hit/miss, price query counters
- **Health**: `/api/v1/health` — per-service status, uptime, assets tracked
- **Logs**: Structured JSON logs written to `logs/` with Winston

## License

MIT
