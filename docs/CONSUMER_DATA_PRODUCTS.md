# Consumer Data Products — Issues #711–#718

Owner: Consumer API and data products workstream (API service team).

Four consumer-facing endpoints let tenants observe and audit the prices
they receive, all served from the API service with no cross-service calls.

This API service team owns the consumer products. The supported measurement
scope is the samples and credentials visible to one API deployment, with
explicit response windows and no claim of historical completeness beyond the
documented in-memory retention.

## Endpoints

| Issue | Endpoint | Auth | Purpose |
|---|---|---|---|
| #715 | `GET /api/{v1,v2}/consumer/latency-freshness` | optional | Feed latency (p50/p95/p99) + freshness by feed and region, with methodology and sample windows |
| #716 | `GET /api/{v1,v2}/consumer/usage/export` | required | Privacy-safe machine-readable export of the caller's own usage (JSON or CSV) |
| #717 | `GET /api/{v1,v2}/consumer/delivery-objectives` | required | Attainment of contracted delivery objectives with exclusions, incident windows and auditable calculation |
| #718 | `GET /api/{v1,v2}/prices/:asset/provenance` | required | Links a price to its catalog version, aggregation policy, source set and observation-time semantics |
| #711 | `GET /api/{v1,v2}/consumer/quality-report` | required | Quality and sample coverage for 1–50 selected feeds over a reproducible Unix-second window (maximum 30 days) |
| #713 | `GET /api/{v1,v2}/consumer/schemas` | none | Machine-readable REST and WebSocket schema registry with compatibility policy and deprecation headers |

The #711 endpoint takes `assets` as a comma-separated list and requires
`from` and `to` Unix-second values. Its `reportId` is SHA-256 over the report
content and selected window, so repeating the request over unchanged retained
samples produces the same identifier. `no_data` feeds remain in the result and
count against coverage. The #713 registry is versioned independently from API
paths; breaking changes require a new major schema version and a 180-day
deprecation period.

Issue #712 extends the API WebSocket `replay_complete` response with
`gapDetected` and `oldestReplayableSequence`. The global sequence checkpoint is
atomically written to `WS_SEQUENCE_FILE` (default `./data/ws-sequence.json`)
after each published update. Replay remains bounded by message, byte, and
request-rate limits. The sequence survives process restarts, while replay
payloads remain in the bounded process-local ring; when a cursor predates the
oldest retained update, clients must refetch a REST snapshot and resume from
its returned `sequenceId`. Each API replica needs a shared checkpoint path to
preserve a common cursor; the default file is suitable for a single replica.

Region for #715 is read from the `X-Region` header or the `region` query
parameter and defaults to `global`. Latency samples are recorded in-memory
whenever a price response is served (bounded at 50 000 samples) — empty
`feeds` means no price responses matched the filters in the window, not an
error.

`usage/export` (JSON) returns stable billing dimensions
(`endpoint`, `method`, `asset`, `status`, `timestamp`) plus aggregates
(`byEndpoint`, `byAsset`, `byStatus`); `?format=csv` returns the same rows
as a CSV download. Only the authenticated caller's usage is ever returned —
no cross-tenant data.

Delivery objectives are computed from the same measured samples (latency
and freshness p95 vs. target over 24 h); exclusions and incident windows are
listed so the calculation is independently reproducible. Provenance is built
on the existing lineage record (`provenanceId` + `verificationUrl`) and adds
`catalogVersion`, `aggregationPolicy`, `sourceSet` and
`observationTimeSemantics`.

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `PRICE_CATALOG_VERSION` | `1.0.0` | Catalog version reported in provenance responses |
| `WS_SEQUENCE_FILE` | `./data/ws-sequence.json` | Durable global API WebSocket sequence checkpoint |

Issue #714 uses the existing admin key-management boundary: an operator with
`keys:write` may replace a consumer key's feed entitlement at
`PUT /api/v1/admin/consumer-entitlements/{keyHash}`. The request requires an
`effectiveAt` ISO timestamp, a non-empty `feeds` list, and
optional operations, environments, and `expiresAt`. Omitted dimensions default
to `read` and `production`; expiry revokes access automatically. The signed
audit record captures the previous and new policy. Future-dated policies are
rejected by key validation until `effectiveAt`; `expiresAt` must be later than
the activation time. Existing key deletion and revocation endpoints remain the
immediate revoke controls.

No migrations, schema changes or new dependencies are required.

## Rollout

1. Deploy the API service as usual (existing pipeline, no flags).
2. Verify: `GET /api/v2/consumer/latency-freshness` returns `200` with an
   explanatory `sampleNote`; after serving a price, `feeds` starts
   populating.
3. Verify auth-scoped endpoints reject unauthenticated calls with `401`
   and return tenant-scoped data with a valid key.
4. Provenance responses include `verificationUrl` pointing at the existing
   lineage verification endpoint.
5. For #711, call the quality report twice over a fixed window and compare
   `reportId`; verify a requested feed with no samples remains `no_data`.
6. For #712, restart the API with the same sequence file, reconnect using the
   previous cursor, and confirm the sequence advances; overflow a replay ring
   and confirm `gapDetected: true` drives snapshot refetch.
7. For #713, fetch the registry and check every emitted envelope has a listed
   schema and deprecation metadata remains machine-readable.
8. For #714, update a test consumer key, verify its policy and audit-chain
   entry, then revoke it and confirm authentication rejects it.

## Rollback

Revert the API deployment. All new routes are additive; v1/v2 price, history,
sources and health endpoints are untouched. The only behavioral change to
existing paths is that price serves record an in-memory latency sample —
dropping the deployment removes both the routes and the sampler with no
leftover state.

## Monitoring and compatibility

- Existing Prometheus metrics and logs are unchanged; the only addition is
  a debug-level `Consumer data store initialized` line at startup.
- Old clients are unaffected: no request/response shapes were modified on
  existing endpoints; provenance and consumer routes are new paths.
- In-memory latency samples do not persist across restarts; usage export
  reads from the existing usage-analytics ring (last ~5000 events), same
  coverage as the existing usage dashboard.
- Quality report windows are capped at 30 days, but measured samples are
  process-local and capped at 50,000; the response methodology discloses this
  coverage boundary. Replay sequence checkpoints are durable but replay payload
  retention is not. Monitor `ws_api_replay_requests_total{result="truncated"}`
  and `ws_api_buffer_bytes`; clients should track `gapDetected` and resync on
  gaps. The #714 administration route emits `admin.entitlements_updated` audit
  events; existing key-management audit and store health signals cover rollout.
