# Deterministic request-cost estimates (issue #720)

A consumer sees what a planned request costs **before executing it**. The
estimate is deterministic: identical query parameters always produce an
identical answer, because it is a pure function of the request shape and a
versioned rule table — no wall-clock time, no cache state, no per-key state.

## Endpoint

`GET /api/v2/prices/cost-estimate` (v2 router, `api/src/price-serving/v2.ts`;
model: `api/src/price-serving/cost-estimate.ts`)

| Parameter | Meaning |
|---|---|
| `operation` | One of `single_price`, `batch_prices`, `price_history` |
| `assetCount` | Proposed asset-list size for `batch_prices` (1..50) |
| `historyLimit` | Proposed `limit` for `price_history` (1..1000; defaults to 100) |

The response always carries HTTP 200 for *well-formed* estimates; a planned
request that would not pass validation is reported as `accepted: false` with
the exact rejection the executed request would return (so a client can budget
around boundaries without spending the request), while malformed query values
(letters in `assetCount`, etc.) are a plain `400 VALIDATION_ERROR`.

## Rule alignment with enforcement and billing

The estimate is expressed **only in dimensions that are actually enforced or
billed**:

| Dimension | Value | Where it is enforced / metered |
|---|---|---|
| Quota | **1 request unit per request**, success or failure | `platform/tenant-window.ts` consumes one fixed-window slot per request; there is no per-asset quota |
| Billing | **1 metered unit per request per API key**, failures included | `governance/usage-tracking.ts` counters reconcile per `docs/fee-schedule.md` § 3 |
| Tier fit | Per-minute defaults identical to `platform/limit-model.ts` (`TIER_RATE_LIMITS`) | The same table answers `X-RateLimit-Limit` |

Batching 50 assets costs the same one request unit as a single-asset lookup —
that is the enforced semantics, and the estimate reflects it instead of
inventing a per-asset cost that the limiter never charges.

## Owner, scope, evidence

- **Owner:** Consumer API workstream (api team).
- **Supported scope:** the three bounded read operations above; estimate of
  the *request* cost only (not storage writes or webhook deliveries).
- **Completion evidence:** `api/tests/cost-estimate.test.ts` asserts
  determinism (byte-identical repeat responses), boundary acceptance at
  `assetCount = 1/50` and `historyLimit = 1/1000`, rejection with consequence
  text beyond them, unknown operations, and that the published tier table
  equals `platform/limit-model.ts` (the enforced numbers).

## Compatibility, monitoring, operational impact

- **Compatibility:** additive v2 read endpoint; the frozen v1 contract is
  untouched. `assetCount`/`historyLimit` bounds are mirrored from the schemas
  the actual handlers enforce (`BatchQuerySchema`, `HistoryQuerySchema`,
  `pagination.ts`), so bumping those bounds means bumping
  `cost-estimate.ts` in the same release — the shared constants live in one
  module and the tests fail if they diverge.
- **Evolution:** a rule change bumps `COST_MODEL_VERSION` and the estimate
  always identifies the rule set it answered from, so a consumer can pin a
  version until it re-reads the contract.
- **Monitoring:** estimates are metered and rate-limited like every other
  request (usage counters + per-key window), so no new enforcement surface is
  introduced; the endpoint itself reads no store and cannot hammer the
  database.
- **Operational impact:** none — pure computation, no cache invalidation, no
  new dependencies.

## Rollout and rollback

- **Rollout:** ships behind the v2 router with the usual deploy; the endpoint
  is reachable immediately, and `GET /api/v2` lists it in `endpoints`.
- **Rollback:** revert the route registration (single route in
  `v2.ts`); the pure model module has no side effects, and no migration or
  config change exists to undo.
