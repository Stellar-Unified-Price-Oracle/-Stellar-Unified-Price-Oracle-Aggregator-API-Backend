# Integration Tests

This document describes how to run and understand the integration tests for the Stellar Price Oracle system.

## Overview

Integration tests validate the full data pipeline:
1. **Source Fetching** - Oracle sources (Chainlink, Redstone, Band, Reflector) fetch prices
2. **Aggregation** - Prices are aggregated using median calculation
3. **Storage** - Data is stored in PostgreSQL or file-based JSON
4. **API Serving** - Prices are served via REST API and WebSocket
5. **Alert Manager** - Price deviations and staleness are detected and alerted

## Running Integration Tests Locally

### With Docker Compose

The simplest way to run integration tests is using docker-compose:

```bash
# Start all services
docker-compose -f docker-compose.test.yml up

# In another terminal, run tests
npm run test:integration

# Tear down
docker-compose -f docker-compose.test.yml down
```

### Manual Setup

1. Start PostgreSQL:
```bash
docker run --name postgres-test \
  -e POSTGRES_DB=stellar_oracle_test \
  -e POSTGRES_PASSWORD=postgres \
  -p 5432:5432 \
  postgres:16-alpine
```

2. Create tables:
```bash
psql -h localhost -U postgres -d stellar_oracle_test -f scripts/schema.sql
```

3. Start aggregator service:
```bash
cd services/aggregator
npm install
npm start
```

4. Start API service:
```bash
cd api
npm install
DATABASE_ENABLED=true \
DATABASE_HOST=localhost \
DATABASE_PORT=5432 \
DATABASE_NAME=stellar_oracle_test \
DATABASE_USER=postgres \
DATABASE_PASSWORD=postgres \
npm start
```

5. Run integration tests:
```bash
cd api
npm run test:integration
```

## Test Categories

### 1. Price API Endpoints
- `GET /api/v1/prices` - All prices
- `GET /api/v1/prices/:asset` - Specific asset price
- `GET /api/v1/history/:asset` - Price history with filters
- Contract ID format validation

### 2. Health Check Endpoints
- `GET /api/v1/health` - API health status
- `GET /api/v1/sources` - Available oracle sources

### 3. WebSocket Real-Time Updates
- Connection establishment
- Price update reception
- Message format validation

### 4. Data Pipeline Consistency
- REST API and WebSocket data alignment
- Timestamp consistency
- Decimal precision

### 5. Error Handling
- 404 for non-existent assets
- 400 for invalid parameters
- Proper error response format

### 6. Performance and Caching
- LRU cache hit rates
- Response consistency
- Cache invalidation

### 7. Aggregator Service
- Service availability
- Health check endpoints
- Source health status

### 8. API Response Format
- Success flag presence
- Data/error mutual exclusivity
- Timestamp inclusion

## Test Configuration

Tests respect these environment variables:

```bash
API_URL=http://localhost:3000/api/v1          # API base URL
WS_URL=ws://localhost:3001                    # WebSocket URL
AGGREGATOR_URL=http://localhost:4000           # Aggregator health check
```

## CI/CD Integration

Integration tests run automatically on:
- Push to `main` or `develop` branches
- Pull requests to `main` branch

See `.github/workflows/integration-tests.yml` for the CI configuration.

## Debugging Tests

Enable debug output:

```bash
npm run test:integration -- --reporter=verbose
```

Check logs from services:

```bash
# API logs
tail -f logs/api-combined.log

# Aggregator logs
tail -f services/aggregator/logs/aggregator.log
```

## Common Issues

### Services Not Starting
- Check ports are available (3000, 3001, 4000, 5432)
- Verify docker daemon is running
- Check logs for startup errors

### Database Connection Failures
- Ensure PostgreSQL is running and accessible
- Verify credentials match configuration
- Check that required tables exist

### WebSocket Connection Timeouts
- Verify WebSocket server is running on port 3001
- Check firewall rules
- Ensure API service is healthy first

## Future Improvements

- [ ] Add performance benchmarking tests
- [ ] Add load testing scenarios
- [ ] Add failure recovery tests
- [ ] Add multi-asset aggregation tests
- [ ] Add alert delivery verification tests
