# Anomalous credential usage detection

Owner: security maintainers (issue #758). Code: `api/src/security/credentialAnomaly.ts`; tests: `api/tests/credential-anomaly.test.ts`.

## Scope

An in-memory, per-credential detector. Call `observe({ credentialId, timestamp, country?, endpoint, privilege })` from the auth path and route any returned `AnomalyAlert[]` to logging/alerting.

| Alert | Trigger (after `warmupEvents`, default 20) |
|-------|-------------------------------------------|
| `new_geography` | country never seen for this credential |
| `new_endpoint_pattern` | route template never used by this credential |
| `privilege_escalation` | privilege above the highest previously used (default order read < write < admin) |
| `usage_spike` | requests in the current window exceed `spikeFactor` x smoothed baseline and `spikeMinCount` |

Thresholds are options with defaults chosen as starting points; they have not been tuned on production traffic and should be reviewed before alerting pages anyone.

## Secret handling

The detector accepts an opaque credential id (key id/prefix), never the secret. State is keyed and alerts reference a 12-char SHA-256 prefix (`credentialRef`). Pass route templates, not URLs with identifiers.

## Integration status

Standalone and not yet wired into the request path, to keep this change free of conflicts with in-flight auth work. Wiring is a small follow-up: instantiate one detector, call `observe` after API key authentication (country from a trusted GeoIP/proxy header, `unspecified` source today), and log alerts with the existing logger.

## Compatibility, monitoring, operational impact

No API or schema changes; no new dependencies. State is per process and lost on restart (warmup restarts), bounded by `maxCredentials`. Multi-replica deployments learn independently, so expect duplicate first-seen alerts per replica. Suggested monitoring once wired: counter per `kind`; alert on sustained rates, not single events.

## Rollout / rollback

Rollout: wire behind an alert-only (log) mode first, observe false-positive rate, then enable paging. Rollback: remove the `observe` call (or the module and doc); there is no persisted state.
