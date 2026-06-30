# Stellar Unified Price Oracle & Aggregator API

A Soroban-based price oracle aggregator that polls off-chain oracle providers
(Chainlink, Redstone, Band Protocol, Reflector), normalizes and aggregates
prices via median calculation, and stores results on-chain via a Stellar
Soroban smart contract. A REST + WebSocket API serves the data to downstream
DeFi protocols.

---

## Project navigation

```
.
├── api/                          # REST + WebSocket API service (Express, TypeScript)
│   ├── src/
│   │   ├── index.ts              # Express entrypoint, middleware registration
│   │   ├── config.ts             # Port, rate-limit, cache, RPC config
│   │   ├── routes/v1.ts          # /prices, /history, /sources, /health
│   │   ├── services/
│   │   │   ├── cache.ts          # LRU in-memory cache
│   │   │   ├── price-store.ts    # Reads price data from JSON files
│   │   │   ├── validation.ts     # Zod input schemas
│   │   │   └── openapi.ts        # Swagger/OpenAPI spec
│   │   ├── middleware/
│   │   │   ├── logger.ts         # Winston logger
│   │   │   ├── error.ts         # Error/404 handlers
│   │   │   ├── metrics.ts       # Prometheus metrics
│   │   │   └── request-logger.ts
│   │   └── websocket/server.ts   # WS with per-asset subscriptions
│   └── tests/services.test.ts
│
├── services/aggregator/          # Price aggregator service (TypeScript)
│   ├── src/
│   │   ├── index.ts              # Poll loop, WS broadcast, health server
│   │   ├── aggregator.ts         # Median calculation, staleness checks
│   │   ├── publisher.ts          # Pushes aggregated prices to Soroban
│   │   ├── config.ts             # Poll interval, assets, source URLs
│   │   ├── types.ts              # NormalizedPrice, AggregatedPrice, etc.
│   │   ├── sources/
│   │   │   ├── base.ts           # Abstract source (fetchWithBackoff)
│   │   │   ├── chainlink.ts
│   │   │   ├── redstone.ts
│   │   │   ├── band.ts
│   │   │   └── reflector.ts
│   │   ├── utils/
│   │   │   ├── logger.ts
│   │   │   └── history.ts        # Read/write history JSON files
│   │   ├── ws-server.ts          # Internal WS broadcast
│   │   └── health-server.ts      # HTTP /health endpoint
│   └── tests/aggregator.test.ts
│
├── contracts/price-oracle/       # Soroban smart contract (Rust)
│   └── src/
│       ├── lib.rs                # Crate root, module declarations
│       ├── contract.rs           # initialize, submit_price, get_price, etc.
│       ├── storage.rs            # On-chain storage operations
│       ├── types.rs              # PriceDataPoint, AssetPrice, DataKey, etc.
│       ├── errors.rs             # OracleError enum
│       └── test.rs               # Unit tests
│
├── .husky/
│   ├── pre-push                  # Backend build on git push
│   └── _/                        # Husky internal stubs (managed)
├── data/                         # Historical price JSON files (gitignored)
├── logs/                         # Runtime logs (gitignored)
├── scripts/deploy-soroban.js     # Contract deployment script
├── fly/                          # Fly.io deployment configs
├── k8s/                          # Kubernetes + Istio service mesh manifests
│   ├── base/                     # API, aggregator, TimescaleDB workloads
│   ├── overlays/staging/         # Staging Kustomize overlay
│   └── istio/                    # mTLS, canary routing, observability stack
├── .github/workflows/ci.yml      # CI: backend build (aggregator + API)
├── Makefile                      # Build/test/run shortcuts
├── docker-compose.yml
├── AGENTS.md                     # This file
└── package.json                  # Root scripts + husky config
```

---

## Architecture

```
Chainlink ─┐
Redstone  ─┤
Band      ─┤──► Aggregator Service ──► Soroban Smart Contract
Reflector ─┤    (poll 30s, median)      (on-chain storage)
                │
                ▼
          history JSON files
                │
                ▼
          REST API + WebSocket (ports 3000/3001)
```

---

## What to push / not push

**Push to `main`** — source code only:
- `api/src/`, `services/aggregator/src/`, `contracts/price-oracle/src/`
- `Makefile`, `docker-compose.yml`, `package.json`, `AGENTS.md`
- `.husky/`, `.github/workflows/`, `fly/`, `k8s/`, `scripts/`
- Configuration: `.env.example`, `.gitignore`

**Never push** (already gitignored):
- `.env`, `node_modules/`, `dist/`, `target/`, `data/`, `logs/`
- `.kiro/` (AI tool artifacts)

---

## Verification checklist

After any change, confirm:

1. **TypeScript** — no type errors:
   ```
   npm run build:aggregator && npm run build:api
   ```
   Or individually:
   ```
   cd services/aggregator && npx tsc --noEmit
   cd ../../api && npx tsc --noEmit
   ```
2. **Tests** — all pass:
   ```
   npm run test:backend
   ```
   Or individually:
   ```
   cd services/aggregator && npm test
   cd ../../api && npm test
   cd ../../contracts/price-oracle && cargo test
   ```
3. **Pre-push hook** — runs automatically via Husky at `git push`:
   - Aggregator build
   - API build
4. **CI** — `.github/workflows/ci.yml` runs backend build (aggregator + API) on push/PR.

---

## Source conventions

- No comments in code unless the logic genuinely requires explanation
- TypeScript sources use named exports, Zod for validation
- Rust contract follows Soroban SDK patterns (contracttype, contractimpl)
- Async/await throughout the Node services
- All prices stored as `bigint` scaled to their decimal precision
