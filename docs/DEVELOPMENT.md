# Development Setup & Contribution Guide

This guide covers everything needed to run the Stellar Unified Price Oracle Aggregator API locally and contribute changes.

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | 18+ | Used by `api/` and `services/aggregator/` |
| npm | 9+ | Package manager for both Node services |
| Rust + Cargo | stable | Only needed to build/test the Soroban contract (`contracts/price-oracle/`) |
| Soroban CLI | latest | For deploying/invoking the contract against testnet |
| Docker & Docker Compose | latest | For running the full stack (Postgres, Redis, services) via `docker-compose.yml` |

Rust and the Soroban CLI are optional for pure API/aggregator work — `make build-soroban` skips the contract build if `cargo` isn't installed.

## Local environment setup

1. Clone the repo and copy the environment template:
   ```bash
   git clone <repo-url>
   cd -Stellar-Unified-Price-Oracle-Aggregator-API-Backend
   cp .env.example .env
   ```
2. Fill in `.env`. For local development the defaults work out of the box — `DATABASE_URL` and `REDIS_URL` can be left empty to fall back to file-based storage and an in-memory LRU cache respectively.
3. Install dependencies:
   ```bash
   make install
   ```

## Running the full stack locally

**Option A — Makefile (two terminals, no Docker):**
```bash
make dev-aggregator   # Terminal 1 — polls oracle sources, WS on :4000
make dev-api          # Terminal 2 — REST on :3000, WS on :3001
```

**Option B — Docker Compose (full stack incl. Postgres/Redis):**
```bash
docker-compose up
```

Once running, verify with:
```bash
curl http://localhost:3000/api/v1/health
```
Swagger UI is available at `http://localhost:3000/api/v1/docs`.

## Testnet configuration

To exercise the Soroban contract path against Stellar testnet:

1. Set in `.env`:
   ```bash
   SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
   NETWORK_PASSPHRASE=Test SDF Network ; September 2015
   ```
2. Generate and fund a testnet admin identity:
   ```bash
   soroban keys generate admin --network testnet
   soroban keys fund admin --network testnet
   ```
3. Build and deploy the contract:
   ```bash
   make build-soroban
   soroban contract deploy \
     --wasm contracts/price-oracle/target/wasm32-unknown-unknown/release/price_oracle.wasm \
     --source admin \
     --network testnet
   ```
4. Set the returned contract ID as `CONTRACT_ID` in `.env` and restart the aggregator so it can push prices on-chain.

## Contributing

1. Create a branch off `main`: `feature/<short-description>` or `fix/<short-description>`.
2. Keep changes scoped to the linked issue — avoid unrelated refactors in the same PR.
3. Run the relevant checks before opening a PR:
   ```bash
   make test           # all components
   make test-api        # or scope to the service you changed
   make test-aggregator
   make test-soroban
   ```
4. Follow [Conventional Commits](https://www.conventionalcommits.org/) for commit messages (e.g. `fix(api): ...`, `feat(aggregator): ...`, `docs: ...`).
5. Open a PR against `main` with a concise summary, `Closes #<issue>` where applicable, and a note on what validation you ran.
6. See [docs/runbooks/](runbooks/) for operational context and [docs/adr/](adr/) for architectural decisions that may affect your change.
