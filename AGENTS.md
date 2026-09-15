# Stellar Unified Price Oracle & Aggregator API

A Soroban-based price oracle aggregator that polls off-chain oracle providers
(Chainlink, Redstone, Band Protocol, Reflector), normalizes and aggregates
prices via a median calculation, and publishes results on-chain via a Stellar
Soroban smart contract. A REST + WebSocket API and a TimescaleDB history store
serve the data to downstream DeFi protocols.

---

## Repository layout

```
.
├── api/                        # REST + WebSocket API (Express, TypeScript)
│   ├── src/
│   │   ├── index.ts            # Entrypoint: server, WS, synthetic probes, shutdown
│   │   ├── price-serving/      # /prices + /history serving, caching, versioning
│   │   │   ├── v1.ts           # v1 route handlers
│   │   │   ├── v2.ts           # v2 route handlers (assets, batch prices)
│   │   │   ├── price-store.ts  # Reads price data from the history files
│   │   │   ├── cache.ts        # LRU L1 + Redis L2 hybrid cache
│   │   │   ├── pagination.ts, conditional-cache.ts, deprecation.ts, hypermedia.ts
│   │   │   └── validation.ts   # Zod request schemas
│   │   ├── infrastructure/     # server.ts (REST + PriceWebSocketServer), config.ts,
│   │   │                       # database.ts, db-pool/retry/circuit-breaker,
│   │   │                       # openapi.ts, csrf.ts, ws-messages.ts, https.ts
│   │   ├── governance/         # API keys, RBAC, audit log, proposals, CORS, crypto
│   │   ├── observability/      # logger, prom-client metrics, tracing, uptime tracker
│   │   ├── middleware/         # logger, usage tracking
│   │   ├── platform/           # rate limiter, plugin system, lineage, self-healing
│   │   ├── graphql/, feeds/, webhooks/, routes/, release-notes/, services/
│   │   └── domain-events/
│   └── tests/                  # vitest; see "Integration tests" below
│
├── services/aggregator/        # Price aggregator service (TypeScript)
│   ├── src/
│   │   ├── index.ts            # Poll loop, WS broadcast, health server
│   │   ├── oracle-sources/     # base.ts (normalize + fetchWithBackoff) and one
│   │   │                       # module per provider: chainlink, redstone, band, reflector
│   │   ├── price-aggregation/  # aggregator.ts, median.ts, circuit-breaker.ts,
│   │   │                       # anomaly-detector.ts, source-circuit-breaker.ts
│   │   ├── contract-publishing/# publisher.ts, canary.ts, retry-queue.ts
│   │   ├── persistence/        # history.ts, database.ts, file-archival.ts
│   │   ├── replication/        # region replicator, CRDT, Kafka bus, quarantine
│   │   ├── observability/      # logger, metrics, health-server, alert-manager
│   │   ├── infrastructure/     # config, types, http-client, ssrf, ws-server, crypto
│   │   ├── performance/, migrations/, domain-events/
│   │   └── ws-server.ts is NOT here — it lives in infrastructure/ws-server.ts
│   └── tests/
│
├── contracts/price-oracle/     # Soroban smart contract (Rust, soroban-sdk pinned)
│   ├── src/
│   │   ├── lib.rs              # Crate root, module declarations, test module wiring
│   │   ├── contract/
│   │   │   ├── mod.rs          # The single #[contractimpl] block; delegates outward
│   │   │   ├── submission.rs   # submit_price, Merkle batch flow, stake/slash
│   │   │   ├── admin.rs        # Admin-only config, treasury, TTL extension
│   │   │   ├── governance.rs   # Multi-sig proposals, emergency pause
│   │   │   └── queries.rs      # Read-only queries (no mutation)
│   │   ├── storage.rs          # All storage reads/writes + TTL constants
│   │   ├── types.rs            # PriceDataPoint, AssetPrice, DataKey, config structs
│   │   ├── errors.rs           # OracleError enum (numbered, append-only)
│   │   ├── events.rs           # #[contractevent] types
│   │   ├── merkle.rs, proxy.rs, governance.rs, multisig.rs, utils.rs
│   │   └── *_test.rs           # test.rs, merkle_test.rs, governance_test.rs,
│   │                           # proxy_test.rs, staking_test.rs, events_test.rs,
│   │                           # compat_test.rs, upgrade_migration_test.rs, fuzz.rs
│   ├── fuzz/                   # cargo-fuzz harness
│   └── tests/                  # gas_benchmarks_module.rs
│
├── packages/types/             # @stellar-oracle/types — shared TS interfaces
├── packages/vault-client/      # @stellar-oracle/vault-client
├── specs/PriceOracle.tla       # TLA+ spec
├── verification/smt/           # SMT2 invariant checks + fixtures
├── k8s/                        # base/, overlays/ (dev, staging, prod*-<region>, sandbox),
│                               # blue-green/, chaos/
├── infrastructure/terraform/   # modules/ + environments/
├── monitoring/                 # Prometheus rules, Alertmanager config, synthetic checks
├── load-tests/k6/              # k6 scenarios
├── scripts/                    # deploy, benchmark, cost model, DR, chaos, TTL job
├── docs/                       # ~100 design/runbook documents
├── data/                       # Historical price JSON files (gitignored)
├── logs/                       # Runtime logs (gitignored)
├── Makefile                    # build/test/run shortcuts
├── docker-compose.yml          # Full local stack (see ports below)
└── AGENTS.md                   # This file
```

---

## Architecture

```
Chainlink ─┐
Redstone  ─┤
Band      ─┤──► Aggregator ──► Soroban contract
Reflector ─┘    (poll loop,      (on-chain storage)
                 median)
                     │
                     ├──► history JSON files ──► REST API (3000)
                     ├──► WS broadcast (4001) ──► consumers
                     └──► health server (4002)
```

**Ports** (from `config.port` and `docker-compose.yml`):

| Port | Service | What listens |
|---|---|---|
| 3000 | API | REST (`API_PORT`) |
| 3001 | API | WebSocket (`WS_PORT`), client-driven subscriptions |
| 4000 | — | Nothing. Exposed in compose, but unbound |
| 4001 | Aggregator | WebSocket broadcast — the price push path |
| 4002 | Aggregator | HTTP `/health` |
| 5432 | TimescaleDB | PostgreSQL / hypertables |
| 4317-4318 | Jaeger | OTLP receivers |
| 8200 | Vault | Dev-mode secret store |

The aggregator's ports are offset, not equal, to `PORT`: its WebSocket listens
on `PORT + 1` and its health server on `PORT + 2`, so `PORT=4000` means the push
socket is on **4001**. Do not assume `:4000/health` or `:4000` serve anything.

The API's WebSocket (3001) and the aggregator's (4001) are different servers.
The aggregator is what broadcasts `price_update`; the API's
`PriceWebSocketServer.broadcastToSubscribers` currently has **no callers**, so
the API never pushes prices on its own.

---

## Verification checklist

Run from the repository root unless stated otherwise.

1. **TypeScript** — no type errors. Build the shared packages first; both
   services resolve `@stellar-oracle/types` from `packages/types/dist`.
   ```
   npm run build:packages
   npm run build:aggregator && npm run build:api
   ```
   Or all at once, including the packages:
   ```
   npm run typecheck:all
   ```
2. **Tests**
   ```
   npm run test:backend      # aggregator + api (vitest)
   npm run test:contract     # cargo test in contracts/price-oracle
   ```
   `npm run test:backend` does **not** include the Rust contract.
3. **Build everything** (includes `cargo build --release`):
   ```
   npm run build:backend && npm run build:contract
   ```
4. **Pre-push hook** (`.husky/pre-push`) builds the aggregator and the API.
5. **CI** (`.github/workflows/ci.yml`) runs: cost-model check, price-correctness
   validation, aggregator (typecheck + coverage + build), api (typecheck +
   coverage + build), contract formal verification (cargo test + verification
   report), kustomize overlay validation, and a perf-regression benchmark.

### Integration tests

`api/tests/integration.test.ts`, `v2-assets.test.ts` and `v2-batch-prices.test.ts`
are gated behind `RUN_INTEGRATION_TESTS` and need a running stack, so they are
not part of `npm run test:backend`. The CI `api-integration` job runs them
against a fully local stack (stub oracle + aggregator + API, no database, no
network).

To run them locally, build first and then reproduce that job:

```
npm ci && npm run build:backend
node scripts/stub-oracle-server.mjs &                 # stub upstream oracle APIs
rm -rf api/data && ln -s "$PWD/services/aggregator/data" api/data
cd services/aggregator && SSRF_ALLOW_PRIVATE_IPS=true WS_REQUIRE_ORIGIN=false \
  PORT=4000 POLLING_INTERVAL_MS=5000 WATCHED_ASSETS=XLM,USDC \
  CHAINLINK_BASE_URL=http://localhost:4010 REDSTONE_BASE_URL=http://localhost:4010 \
  BAND_BASE_URL=http://localhost:4010 REFLECTOR_BASE_URL=http://localhost:4010 \
  node dist/index.js &
cd ../../api && API_PORT=3000 WS_PORT=3001 WS_REQUIRE_ORIGIN=false \
  API_KEYS='test-key:10000:local:pro:viewer' node dist/index.js &
cd .. && cd api && RUN_INTEGRATION_TESTS=1 TEST_API_KEY=test-key \
  npx vitest run tests/integration.test.ts tests/v2-assets.test.ts tests/v2-batch-prices.test.ts
```

Two notes that trip this up:

- `api/data` must point at `services/aggregator/data`. Each service resolves
  its history directory relative to its own `dist` folder, so without the
  symlink the API reads a different, usually empty, directory.
- Requests to `/api/v1/prices` and `/api/v1/history` need an API key; without
  one they return `401 MISSING_API_KEY`. Seed a key with the `API_KEYS`
  variable, whose format is `key:rateLimit:description:tier:role`.

### Rust toolchain

`cargo` may not be on `PATH`. If `cargo` is missing:
```
export PATH="$HOME/.cargo/bin:$PATH"
cd contracts/price-oracle && cargo test
```

---

## What to push / not push

**Push to `main`** — source and configuration:
- `api/src/`, `services/aggregator/src/`, `contracts/price-oracle/src/`
- `packages/`, `specs/`, `verification/`, `scripts/`, `monitoring/`
- `k8s/`, `infrastructure/`, `load-tests/`
- `docs/`, `Makefile`, `docker-compose*.yml`, `package.json`, `AGENTS.md`
- `.husky/`, `.github/workflows/`, `.env.example`, `.gitignore`

**Never push** (already gitignored):
- `.env`, `node_modules/`, `dist/`, `target/`, `data/`, `logs/`
- `.terraform/`, `coverage/`, `*.log`
- `.kiro/`, `.claude/` (AI tool artifacts), and any similar scratch directory

Note: `.github/workflows/deploy.yml` has **no path filter**, so every push to
`main` rebuilds and signs both Docker images and auto-deploys to staging when
`KUBECONFIG_STAGING` is set. Production deployment requires a manual
`workflow_dispatch`.

---

## Source conventions

- No comments in code unless the logic genuinely requires explanation
- TypeScript uses named exports; Zod for request validation
- Rust contract follows Soroban SDK patterns (`contracttype`, `contractimpl`);
  all contract entrypoints live in the single `#[contractimpl]` block in
  `contract/mod.rs` and delegate to focused submodules
- New `OracleError` variants are appended with the next number; never renumber
- Prices are stored as `bigint` scaled by their own `decimals`. **Sources do not
  agree on `decimals`**, so any comparison or aggregation across sources must
  normalize to a common scale first — use `price-aggregation/median.ts`
- `NormalizedPrice.timestamp` is the best-known observation time. When it must
  reflect the provider's own observation time, read `observedAt` (null means the
  provider reported none and the value is only local fetch time)
- Async/await throughout the Node services
- The Soroban SDK version is pinned exactly; bumping it is a reviewed change
  (see `contracts/price-oracle/SDK_UPGRADE_POLICY.md`)
