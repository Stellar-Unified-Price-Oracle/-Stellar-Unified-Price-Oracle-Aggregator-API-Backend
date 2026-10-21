# Consumer Data Products — Issues #707, #708, #709, #710

Owner: Consumer API and data products workstream (API service team) + price
quality workstream (aggregator service team, #707).

## #707 — Detect provider semantic drift (aggregator)

`services/aggregator/src/price-aggregation/drift-baseline.ts` builds a
versioned baseline per `(asset, source)`: mean/stddev of values, `observedAt`
coverage, median provider reporting lag, and decimals. `drift-detector.ts`
compares live windows against the latest baseline and flags silent semantic
changes:

- mean-price shift beyond ±5% (field-meaning/value change),
- volatility shift beyond ±50%,
- `observedAt` coverage drop beyond 20 points (timestamp behaviour change),
- median reporting-lag shift beyond 300 s.

Results are published as `provider_drift_detected` domain events, logged,
and exported as Prometheus gauges
(`provider_drift_detected{asset,source,baseline_version}`,
`provider_drift_mean_price_change_percent`,
`provider_drift_observed_at_coverage_change`,
`provider_drift_reporting_lag_change_seconds`). A source with no current
samples is reported as data absence, never as drift. Baselines are seeded by
`driftDetector.establishBaseline('v1', …)` (e.g. after a known-good deploy);
the store keeps the last 5 versions per feed so drift is always measured
against explicit, reviewable state.

Rollout: ship with baselines unset — the detector emits nothing until the
first baseline is established, so this is inert by default. Rollback: revert
the two modules plus the poll-loop hook in `services/aggregator/src/index.ts`;
nothing else reads the drift metrics.

## #708 — Cryptographically signed price snapshots (API)

- Sign: `GET /api/{v1,v2}/consumer/snapshots/:asset` (auth required) returns
  a `SignedPriceSnapshot` with `schemaVersion: 2`, `feedId`, `asset`,
  `price`, `decimals`, `timestamp`, `observedAt`, `policyVersion`,
  `sources`, `keyId`, and a hex HMAC-SHA256 `signature`.
- Verify: `verifyPriceSnapshot` in `api/src/price-serving/snapshot-verifier.ts`.

Schema v2 canonical payload binds feed identity, price, precision,
observation time, catalog policy version, sources list, and signature key
id — none can be swapped after signing. The signature uses the same trusted
key material the verifier checks (`TRUSTED_KEYS`), so a signed snapshot
always round-trips. Schema v1 (unchanged payload, no key binding) is still
accepted. Tampered hex of a different length is rejected as
`INVALID_SIGNATURE` instead of throwing. `policyVersion` comes straight
from the feed-catalog policy; `feedId` defaults to the lowercased asset when
no catalog policy exists.

Rollout: additive routes and a new schema version; existing v1 clients are
unaffected. Operators publish real keys into `TRUSTED_KEYS` (the dev secret
is a placeholder). Rollback: unmount `snapshot-signer` in
`api/src/price-serving/consumer/index.ts` and remove the v2 block from the
verifier; v1 behaviour is untouched.

## #709 — Feed-catalog filters for API consumers (API)

`GET /api/{v1,v2}/consumer/feeds` (optional auth) lists catalog feeds with:

- `network` — derived from the canonical asset id (`public` → `mainnet`,
  `testnet` → `testnet`; `public` is accepted as an alias),
- `quoteUnit` — parsed from the feed id suffix (`btc-usd` → `USD`),
- `sourceCoverage` — minimum number of *eligible* sources (1..64),
- `lifecycleState` — catalog lifecycle state (e.g. `active`, `proposed`),
- `page`/`limit` — offset pagination over stable `feedId` ordering
  (total/totalPages/hasNext/hasPrev), max 100 per page.

Invalid filters fail with `VALIDATION_ERROR` (400); `GET
/api/{v1,v2}/consumer/feeds/:feedId` returns the same derivation plus
quorum, or `FEED_NOT_FOUND` (404). This surface is read-only — policy writes
stay behind the admin RBAC routes.

Rollout: additive, read-only, optional auth; safe to enable immediately.
Rollback: unmount `feed-catalog-consumer` in the consumer router.

## #710 — Asynchronous historical export jobs (API)

- `POST /api/{v1,v2}/consumer/exports` (auth required, body
  `{asset, from?, to?, format?}`) → `202` with `{jobId, status: 'pending',
  progress: 0, expiresAt, downloadUrl: null}`.
- `GET /api/{v1,v2}/consumer/exports/:jobId` → status machine
  `pending → running → completed|failed`, with `progress` (0–100),
  `totalRecords`/`processedRecords`, `completedAt`, `checksum`, `error`, and
  `downloadUrl` once complete. Bounded at 100 000 records per job;
  jobs expire after 24 h (auto-expire on read, `410` on expired downloads).
- `GET /api/{v1,v2}/consumer/exports/:jobId/download` → the JSON export
  with `X-Export-Checksum` and `X-Export-Record-Count` headers for integrity
  verification, plus `Content-Disposition` for resumable filename-based
  downloads.

Rollout: additive, in-memory job store (no migration); heavy windows are
capped by the record bound. Rollback: unmount `export-jobs` in the consumer
router; in-flight jobs are dropped with the process.
