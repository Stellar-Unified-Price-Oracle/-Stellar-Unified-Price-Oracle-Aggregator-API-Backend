.PHONY: all build clean test deploy help deploy-soroban canary-deploy canary-deploy-mainnet canary-promote canary-rollback

help:
	@echo "Stellar Price Oracle Aggregator"
	@echo ""
	@echo "  build targets:"
	@echo "  make build-soroban    Build the Soroban contract"
	@echo "  make build-aggregator Build the aggregator service"
	@echo "  make build-api        Build the REST API"
	@echo "  make build            Build all components"
	@echo ""
	@echo "  test targets:"
	@echo "  make test-soroban     Test the Soroban contract"
	@echo "  make test-aggregator  Test the aggregator service"
	@echo "  make test-api         Test the REST API"
	@echo "  make test             Test all components"
	@echo ""
	@echo "  dev targets:"
	@echo "  make install          Install all dependencies"
	@echo "  make dev-aggregator   Run aggregator in dev mode"
	@echo "  make dev-api          Run API in dev mode"
	@echo ""
	@echo "  deploy targets:"
	@echo "  make deploy-soroban      Deploy Soroban contract (requires env)"
	@echo "  make canary-deploy       Deploy canary contract (testnet)"
	@echo "  make canary-deploy-mainnet Deploy canary contract (mainnet)"
	@echo "  make canary-promote      Promote canary to stable"
	@echo "  make canary-rollback     Rollback / disable canary"
	@echo "  make deploy-dev          Deploy to dev K8s cluster"
	@echo "  make deploy-staging      Deploy to staging K8s cluster"
	@echo "  make deploy-prod         Deploy to production K8s cluster"
	@echo "  make rollback            Rollback deployment (ENV=<env> TAG=<tag>)"
	@echo ""
	@echo "  utility:"
	@echo "  make clean            Clean build artifacts"

install:
	cd services/aggregator && npm install
	cd api && npm install

build-soroban:
	@if command -v cargo >/dev/null 2>&1; then \
		cd contracts/price-oracle && cargo build --release; \
	else \
		echo "Skipping Soroban contract build (cargo not installed)"; \
	fi

build-aggregator:
	@if [ ! -d services/aggregator/node_modules ]; then cd services/aggregator && npm install; fi
	cd services/aggregator && npm run build

build-api:
	@if [ ! -d api/node_modules ]; then cd api && npm install; fi
	cd api && npm run build

build: build-soroban build-aggregator build-api

test-soroban:
	cd contracts/price-oracle && cargo test

test-aggregator:
	cd services/aggregator && npm test

test-api:
	cd api && npm test

test: test-soroban test-aggregator test-api

dev-aggregator:
	cd services/aggregator && npm run dev

dev-api:
	cd api && npm run dev

clean:
	cd contracts/price-oracle && cargo clean 2>/dev/null || true
	rm -rf services/aggregator/dist
	rm -rf api/dist
	rm -rf services/aggregator/node_modules
	rm -rf api/node_modules
	rm -rf data/
	rm -rf logs/
	rm -rf target/

deploy-soroban:
	node scripts/deploy-soroban.js

canary-deploy:
	node scripts/canary-deploy-soroban.js $(ARGS)

canary-deploy-mainnet:
	node scripts/canary-deploy-soroban.js --mainnet $(ARGS)

canary-promote:
	node scripts/canary-deploy-soroban.js --promote

canary-rollback:
	node scripts/canary-deploy-soroban.js --rollback
