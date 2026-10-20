# API conformance kit

Versioned (`KIT_VERSION` in `src/checks.mjs`, currently 1.0.0) conformance checks for external
integrators and third-party implementations of the oracle API. Owner: Developer ecosystem and
integration. Zero dependencies; Node 18+.

## What it validates

| Area | Check |
| --- | --- |
| Response schemas | `AssetPrice`, `HistoryData`, etc. against `api/openapi.json` |
| Price encoding | `price` is a string integer, `decimals` a non-negative integer |
| Pagination | cursor traversal: `hasMore` iff `nextCursor`, limit respected, no cursor loops, complete traversal |
| Errors | `{code, message}` body, 4xx/5xx status, `UPPER_SNAKE_CASE` code |
| Streaming | each event is a valid `AssetPrice`; per-asset timestamps never regress |

## Run

```
node conformance/api-conformance-kit/src/cli.mjs --base-url https://oracle.example.com --asset XLM
node --test conformance/api-conformance-kit/test/      # kit self-tests using fixtures/generated
```

Exit codes: 0 conformant, 1 failures, 2 usage or network error. Stream events can be checked
programmatically with `checkStreamSemantics(spec, events)`.

## Versioning and compatibility

The kit version follows the API contract: a breaking contract change bumps the kit major.
Pin the kit version you certify against and record it in your integration notes.

## Monitoring and operational impact

The CLI issues about 6 read-only GETs; run it against staging, or production at low frequency
(for example in a daily CI job) so it stays well inside your rate-limit tier. Alert on any non-zero exit.

## Rollout and rollback

Rollout: publish the kit directory with each API release alongside release notes. Rollback: pin
the previous kit version; the kit holds no state and has no runtime impact on the service.
