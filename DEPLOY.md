# Stellar Price Oracle — Deploy Guide

## 1. Local Development

```bash
# Terminal 1 — Aggregator (polls sources, pushes to contract)
make dev-aggregator

# Terminal 2 — REST API
make dev-api
```

## 2. Docker

```bash
# Build and run everything
docker compose up --build

# Verify
curl http://localhost:3000/api/v1/health    # API health
curl http://localhost:4002/health            # Aggregator health
curl http://localhost:3000/metrics           # Prometheus metrics
```

## 3. Soroban Contract (Testnet)

**Prerequisites:**
- Rust + wasm32 target: `rustup target add wasm32-unknown-unknown`
- A Stellar testnet account with XLM (get from https://laboratory.stellar.org/#account-creator?network=test)
- Install the Soroban CLI: `cargo install soroban-cli`

**Steps:**

```bash
# 1. Set up your environment
cp .env.example .env
# Edit .env: set ADMIN_SECRET_KEY to your testnet secret key

# 2. Deploy the contract
node scripts/deploy-soroban.js

# 3. Copy the CONTRACT_ID from the output into .env

# 4. Verify on-chain
soroban contract invoke \
  --id <CONTRACT_ID> \
  --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015" \
  -- get_price --asset XLM
```

## 4. Cloud Deployment (Fly.io)

**Prerequisites:** Install `flyctl` from https://fly.io/docs/hands-on/install-flyctl/

```bash
# Deploy API
cd fly
fly launch --config api.fly.toml --image stellar-oracle-api:latest --no-deploy
fly deploy --config api.fly.toml

# Deploy Aggregator
fly launch --config aggregator.fly.toml --image stellar-oracle-aggregator:latest --no-deploy
fly deploy --config aggregator.fly.toml
```

## 5. Cloud Deployment (Railway)

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?url=https://github.com/Stellar-Unified-Price-Oracle/-Stellar-Unified-Price-Oracle-Aggregator-API-Backend)

Or manually:
1. Push to GitHub
2. Create two Railway projects (aggregator + api)
3. Connect each to its respective `Dockerfile`
4. Set environment variables from `.env.example`
5. Deploy

## 6. Verifying the Full Stack

```bash
# Check the API serves prices
curl http://localhost:3000/api/v1/prices

# Check Swagger docs
open http://localhost:3000/api/v1/docs

# Connect to WebSocket
wscat -c ws://localhost:3001
> {"type":"subscribe","assets":["XLM","BTC"]}
> {"type":"ping"}

# Check Prometheus metrics
curl http://localhost:3000/metrics
```
