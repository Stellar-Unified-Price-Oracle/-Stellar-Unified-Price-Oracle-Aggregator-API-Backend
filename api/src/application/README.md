# application/

This directory contains **application use-cases** and service orchestrators.

Application services coordinate domain entities and call domain ports to fulfil
a single user-visible operation (e.g. "get latest price for XLM/USD").  They
may import from `domain/` but must not import directly from `infrastructure/`
— dependencies are injected via constructor parameters typed as domain ports.

## Contents

| File | Purpose |
|------|---------|
| `GetLatestPriceUseCase.ts` | Fetch and return the most recent price for a pair |
| `AggregatePricesUseCase.ts` | Poll all oracle providers, aggregate, and persist |

## Rules

- No HTTP/Express/database code here.
- Accept and return domain types only.
- Throw domain errors, not HTTP status codes.
