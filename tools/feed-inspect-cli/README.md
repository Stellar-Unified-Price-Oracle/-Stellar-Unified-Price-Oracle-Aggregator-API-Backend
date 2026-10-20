# feed-inspect CLI

Owner: SDK / developer-ecosystem maintainers (issue #760). Zero dependencies, Node 18+ (global `fetch`).

```
node tools/feed-inspect-cli/cli.mjs resolve xlm-usd
node tools/feed-inspect-cli/cli.mjs inspect XLM/USD --url https://api.example.invalid
node tools/feed-inspect-cli/cli.mjs freshness XLM/USD --max-age 120
node tools/feed-inspect-cli/cli.mjs check --json
```

Base URL: `--url`, else `$ORACLE_API_URL`, else `http://localhost:3000`.
Exit codes: `0` ok, `1` unhealthy (stale/missing/unreachable/HTTP error), `2` usage error, so it can gate scripts and monitors.

## Endpoints used (read-only GETs)

`/api/v2/prices/:asset`, `/api/v2/health/live`, `/api/v2/health/ready`. Responses are unwrapped from a `data` envelope when present.
Freshness reads the `timestamp` field (epoch seconds, epoch ms, or ISO string are all accepted).
Feed identifiers are `BASE/QUOTE`; `-`, `_` and space separators and lowercase are normalized.

## Tests

`cd tools/feed-inspect-cli && node --test` covers normal, boundary (max-age edge, invalid ids) and failure (404, 5xx, timeouts) cases using an injected fetch.
It can also be pointed at the fixture server in `tests/sdk-integration-harness/` for end-to-end checks.

## Operational impact and compatibility

Read-only; issues at most 3 requests per invocation. No API changes. Depends on the v2 route shapes above; if they change, update `lib.mjs`.
Monitoring: use `freshness`/`check` exit codes in cron or CI probes.

## Rollout / rollback

Rollout: merge; invoke by path (not wired into root package.json to avoid shared-file edits).
Rollback: delete `tools/feed-inspect-cli/`.
