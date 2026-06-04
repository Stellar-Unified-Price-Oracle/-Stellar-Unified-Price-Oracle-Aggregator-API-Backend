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
| **Soroban Contract** | Rust | On-chain price storage, admin auth, multi-source submissions, historical queries |
| **Aggregator** | TypeScript/Node | Polls 4 sources every 30s, computes median, pushes to contract, tracks source health |
| **REST API** | Express | `GET /prices`, `/prices/:asset`, `/history/:asset`, `/sources`, `/health` |
| **WebSocket** | ws | Real-time price streams with per-asset subscription |
| **Deployment** | Docker | docker-compose, Dockerfiles for all services |

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
