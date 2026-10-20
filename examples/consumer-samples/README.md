# Consumer sample applications

Reproducible, dependency-free sample consumer of the price API. Owner: Developer ecosystem
and integration. Node 18+ (no `npm install` needed).

## `node-consumer/`

Demonstrates:

- **Feed discovery:** `GET /api/v1/sources`
- **Price verification:** string-integer price, decimals, non-zero, freshness (`ORACLE_MAX_PRICE_AGE_SEC`)
- **Error handling:** typed `OracleError` with API `code`; retries only for network errors, 429 (honours `Retry-After`) and 5xx with exponential backoff; 4xx never retried
- **Production-safe configuration:** env-only config, https enforced, bounded timeout/retries, API key from the environment only

### Run

```
ORACLE_BASE_URL=https://oracle.example.com ORACLE_API_KEY=... node examples/consumer-samples/node-consumer/src/main.mjs XLM
node --test examples/consumer-samples/node-consumer/test/
```

Tests use the shared `fixtures/generated/api-fixtures.json` and an injected fetch, so they
are deterministic and need no network. Reproducibility: no third-party dependencies and no
clock or randomness in the tests beyond an injected `now`.

## Compatibility, monitoring, operations

- Targets API v1 paths; see `docs/integrators/consumer-migration-playbook.md` before moving versions.
- Log `OracleError.code` and retry counts; alert on rising `STALE_PRICE` or `NETWORK` rates.
- Rollout: pin the sample's config values per environment. Rollback: revert the config or the sample commit; the sample has no server-side impact.
