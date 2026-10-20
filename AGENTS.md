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
│   │   │   └── feeds/                   # Feed catalog: asset identity, per-feed
│   │   │                                # policy/quorum, lifecycle, aliases
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
│   │   ├── migrations/, domain-events/
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
| 4001 | Aggregator | WebSocket broadcast — the price push path |
| 4002 | Aggregator | HTTP `/health` and `/metrics` |
| 5432 | TimescaleDB | PostgreSQL / hypertables |
| 4317-4318 | Jaeger | OTLP receivers |
| 8200 | Vault | Dev-mode secret store |

The aggregator's ports are offset, not equal, to `PORT`: its WebSocket listens
on `PORT + 1` and its health/metrics server on `PORT + 2`, so `PORT=4000` means
the push socket is on **4001** and `/health` + `/metrics` are on **4002**.
Nothing listens on `PORT` itself — no manifest, compose file or Service
declares it (enforced by `scripts/check-port-consistency.mjs`).

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
   report), aggregator port consistency (`scripts/check-port-consistency.mjs`),
   kustomize overlay validation, and a perf-regression benchmark.

### Integration tests

`api/tests/integration.test.ts`, `v2-assets.test.ts` and `v2-batch-prices.test.ts`
are gated behind `RUN_INTEGRATION_TESTS` and need a running stack. Run them
locally with a single command from the repository root:

```
npm run test:integration
```

This calls `scripts/integration-test.mjs`, which:

1. Builds all backend packages (`npm run build:backend`).
2. Starts `scripts/stub-oracle-server.mjs` as a stand-in for the four upstream
   oracle APIs.
3. Creates a hermetic temporary data directory shared by both services — no
   manual symlink required (the `HISTORY_DIR` env var replaces the old
   `rm -rf api/data && ln -s …` step).
4. Boots the aggregator and API with the correct env, including a deterministic
   `TEST_API_KEY` so requests never produce confusing `401 MISSING_API_KEY`
   errors.
5. Waits for the API `/api/v1/health` and the aggregator `/health` to return 200.
6. Runs the three gated vitest files with `RUN_INTEGRATION_TESTS=1`.
7. Tears down all child processes and removes the temporary data directory on
   both success and failure — no orphaned node processes, no partial state.
8. Propagates the vitest exit code.

The CI `api-integration` job runs the same command (`npm run test:integration`)
so contributors and CI always use the same entry point.

To skip the build (e.g. when iterating quickly after a first `npm run build:backend`):

```
SKIP_BUILD=1 npm run test:integration
```

Two notes that previously tripped contributors up — now handled automatically:

- **No symlink**: `HISTORY_DIR` points both services at the same temporary
  directory; `api/data` is never touched.
- **API key**: `TEST_API_KEY` defaults to `test-key` and is seeded automatically
  via `API_KEYS`; the `401 MISSING_API_KEY` trap is gone.

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
