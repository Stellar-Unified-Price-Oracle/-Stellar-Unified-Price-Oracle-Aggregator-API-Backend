# Consumer Data Products — Issues #715, #716, #717, #718

Owner: Consumer API and data products workstream (API service team).

Four consumer-facing endpoints let tenants observe and audit the prices
they receive, all served from the API service with no cross-service calls.

## Endpoints

| Issue | Endpoint | Auth | Purpose |
|---|---|---|---|
| #715 | `GET /api/{v1,v2}/consumer/latency-freshness` | optional | Feed latency (p50/p95/p99) + freshness by feed and region, with methodology and sample windows |
| #716 | `GET /api/{v1,v2}/consumer/usage/export` | required | Privacy-safe machine-readable export of the caller's own usage (JSON or CSV) |
| #717 | `GET /api/{v1,v2}/consumer/delivery-objectives` | required | Attainment of contracted delivery objectives with exclusions, incident windows and auditable calculation |
| #718 | `GET /api/{v1,v2}/prices/:asset/provenance` | required | Links a price to its catalog version, aggregation policy, source set and observation-time semantics |

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
