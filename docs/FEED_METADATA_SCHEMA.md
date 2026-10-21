# Versioned Feed Metadata Schema

Issues: #669. Canonical artifact:
`packages/sdk-bindings/schema/feed-metadata.v2.schema.json`.
Runtime reader/writer: `api/src/feeds/feed-metadata-schema.ts`.

The older `feed-metadata.schema.json` (schema version 1) remains the generated
SDK binding for the minimal descriptor. New catalog entries use the v2 document
below; v1 readers are unchanged and continue to work.

## What a v2 document contains

| Concern | Fields | Rules |
|---|---|---|
| Identity | `feedId` | Lower-case kebab-case, stable, unique within a catalog |
| Network | `network` | `stellar:pubnet`, `stellar:testnet`, or `stellar:futurenet` |
| Base unit | `base.asset`, `base.issuer`, `base.decimals` | Issuer `null` for native/fiat; decimals 0–18 |
| Quote unit | `quote.asset`, `quote.issuer`, `quote.decimals` | Same rules as the base unit |
| Precision | `precision` | 0–18 decimals in the published integer price |
| Eligible sources | `eligibleSources[]` | 1–16 unique sources, each with `weightBps` 0–10000 and `required` |
| Freshness | `freshness.heartbeatSeconds`, `maxStalenessSeconds`, optional `deviationThresholdBps` | Positive integers; staleness ≥ heartbeat; deviation 0–10000 bps |
| Ownership | `ownership.team`, `owner`, `oncall` | Owner is an email; on-call is a rotation or channel |
| Lifecycle | `lifecycle.state`, `since`, optional `successorFeedId`, `reason` | `deprecated`/`retired` must name a different successor |

Example:

```json
{
  "schemaVersion": 2,
  "schemaRevision": 0,
  "feedId": "btc-usd",
  "network": "stellar:pubnet",
  "base": { "asset": "BTC", "issuer": null, "decimals": 8 },
  "quote": { "asset": "USD", "issuer": null, "decimals": 2 },
  "precision": 7,
  "eligibleSources": [
    { "source": "chainlink", "weightBps": 3000, "required": true },
    { "source": "redstone", "weightBps": 2500, "required": false }
  ],
  "freshness": { "heartbeatSeconds": 30, "maxStalenessSeconds": 120, "deviationThresholdBps": 50 },
  "ownership": { "team": "market-data", "owner": "feeds@example.com", "oncall": "pagerduty:market-data" },
  "lifecycle": { "state": "active", "since": "2026-01-01T00:00:00Z" }
}
```

## Version model

- `schemaVersion` is the **major** version. It changes only for a breaking
  change: removing or renaming a field, changing a type, or tightening a
  constraint so previously valid documents become invalid.
- `schemaRevision` is the **minor/additive** revision and defaults to `0`.
  Adding an optional field or documenting a new enum value increments it.
- Every document declares its major revision; catalogs and releases hash the
  document as written, so provenance covers the schema version too.

## Reader compatibility rules

A reader declares the version it implements
(`CURRENT_FEED_METADATA_READER`, currently `2.0`). On read:

| Document | Result |
|---|---|
| Same major, same revision | `exact` |
| Same major, lower revision | `backward-compatible`; absent optional fields use their documented defaults |
| Same major, higher revision | `forward-degraded`; the reader **must ignore unknown optional fields** and must not fail |
| Different major | Rejected with `UNSUPPORTED_VERSION`; deploy a new reader |

Writers and CI validate strictly (`validateFeedMetadata` default): unknown fields
fail so typos cannot silently enter the catalog. Readers validate leniently
(`readFeedMetadata` / `strict: false`) so a newer catalog can be rolled out
before every consumer is upgraded.

Unknown **required** semantics must not be hidden in an optional field. If a
consumer must understand a field to price safely, that is a major-version change,
not a revision.

## Monitoring and operation

- `GET /api/v1/catalog` responses exercise the reader path; a validation failure
  is a `FEED_NOT_FOUND`/`INVALID_POLICY` error and increments the catalog error
  metric.
- Catalog publication runs the strict validator and refuses to sign an invalid
  catalog (`npm run catalog:release -- --check`).
- A forward-degraded read is expected during rollout; a rejected major version is
  an incident-level alert because consumers cannot price that feed.

## Rollout and rollback

**Rollout.** Add the v2 schema and reader first (backward-compatible), then
publish catalog entries with `schemaRevision: 0`. Consumers can adopt
`readFeedMetadata` before any v2 entry exists. New optional fields increase the
revision; deploy readers that understand them before publishing them.

**Rollback.** Remove v2 catalog entries or republish the previous immutable
catalog release; the v1 binding and v2 reader remain in place. Never rewrite an
existing release or renumber enum values — append new values and treat unknown
ones as unsupported in writers.

Tests: `api/tests/feeds/feed-metadata-schema.test.ts` covers normal, boundary
(0/18 precision, revision boundaries), and failure (missing fields, duplicate
sources, inverted freshness, major mismatch) cases.
