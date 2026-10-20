# Consumer-identifying telemetry: minimization and retention

Owner: observability and privacy maintainers (owners of `api/src/observability/` and `api/src/privacy/`). Code: `api/src/privacy/telemetryMinimizer.ts`; tests: `api/tests/telemetry-minimizer.test.ts`.

## Field audit (request log path)

| Field | Source | Necessity | Rule |
| --- | --- | --- | --- |
| `ip` | `req.ip` in `observability/request-logger.ts` | Abuse triage needs network, not host | Truncated by default (IPv4 /24, IPv6 /48). Modes via `TELEMETRY_IP_MODE`: `truncate` (default), `hash` (salted HMAC; needs `TELEMETRY_HASH_SALT`, else truncates), `drop`, `full` (explicit opt-in) |
| `query` | `req.query` | Debugging request shape | Values of sensitive keys (api_key, token, secret, signature, email, and any in `TELEMETRY_SENSITIVE_QUERY_KEYS`) replaced with `[redacted]` |
| `requestId`, `traceId`, `spanId` | request context | Correlation | Unchanged; not consumer identifiers |

Not covered by this change and still to be audited by the owners: the audit log (`governance/audit-logger.ts`, which stores `ip`, `userAgent` and `apiKeyPrefix` inside an HMAC chain and is governed by `docs/audit-log-retention.md`), usage tracking, and Prometheus label sets (see `observability/cardinality.ts`). Their treatment is intentionally unchanged here because rewriting HMAC-chained records would break integrity.

## Retention

`TELEMETRY_RETENTION_DAYS` (default 30 when unset or invalid) is parsed into the policy as the target retention for logs carrying the minimized fields. This module does not delete files itself; log retention must be enforced by the log shipper or storage lifecycle. The 30-day default is a proposal in this repository, not a statement of existing practice.

## Testing "identifiers not emitted"

`containsIdentifier()` flags unmasked IPv4 addresses and key-like tokens in text and is exercised in the unit tests; it can be used in log-capture tests for new emitters.

## Compatibility, monitoring, rollout, rollback

- Behavior change: log lines from `requestLogger` now carry truncated IPs and redacted query values. Dashboards or alerts that group by exact client IP will see /24 buckets. Set `TELEMETRY_IP_MODE=full` to restore the previous output.
- Monitoring: compare log volume and abuse-triage queries before and after rollout.
- Rollout: deploy with defaults; adjust the mode per environment.
- Rollback: set `TELEMETRY_IP_MODE=full` (query redaction remains), or revert the two-line change in `request-logger.ts`.
