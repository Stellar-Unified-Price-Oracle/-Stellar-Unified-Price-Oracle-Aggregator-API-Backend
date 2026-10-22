# Feed Catalog and Lifecycle

Related: [Versioned feed metadata schema](./FEED_METADATA_SCHEMA.md),
[signed catalog releases](./FEED_CATALOG_RELEASES.md),
[catalog governance](./CATALOG_GOVERNANCE.md).

Owner: Feed catalog workstream (API team).
Scope: `api/src/feeds/**`, `api/src/governance/admin.ts` (feed routes),
`api/tests/feeds/**`.

The feed catalog is the single place where "which feed serves this request,
and under which participation rule" is decided. It is built from four
composable parts, one per issue in this workstream:

| Part | Module | Issue |
|---|---|---|
| Canonical asset identity | `api/src/feeds/asset-identity.ts` | #671 |
| Per-feed eligibility + quorum | `api/src/feeds/feed-policy.ts` | #674 |
| Governed onboarding lifecycle | `api/src/feeds/feed-lifecycle.ts` | #672 |
| Alias / retirement semantics | `api/src/feeds/feed-aliases.ts` | #673 |

`api/src/feeds/feed-catalog.ts` composes them, `api/src/feeds/feed-service.ts`
holds the process-wide catalog instance, and `api/src/routes/feed-catalog.ts`
exposes it under `/api/v1/catalog`.

---

## 1. Canonical asset identity (#671)

### Rule

A Stellar asset is only identified unambiguously by **network + code + issuer**.
The canonical id is plain text so it can be used in URLs, log lines, metric
labels and audit records without a serialisation step:

```
<network>:<CODE>:<ISSUER>      public:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN
<network>:XLM:native           public:XLM:native        (native asset has no issuer)
```

* `network` ∈ `public | testnet | futurenet | local`. Network passphrases are
  mapped with `networkFromPassphrase()`; an unknown passphrase is rejected
  rather than guessed, because a wrong network silently splits one asset into
  two identities.
* `CODE` is 1–12 characters of `[A-Z0-9]`.
* `ISSUER` is a 56-character Stellar account id (`G…`). The native asset uses
  the literal `native`, and only the native asset may use it.

### Supported aliases

`resolveAssetAlias()` accepts, in this precedence order:

1. canonical id — `public:USDC:GA5Z…`
2. code + issuer in either order — `USDC:GA5Z…`, `GA5Z…:USDC`
3. network-qualified native code — `public:XLM`
4. bare code resolved through the asset alias registry — `USDC`
5. bare native code — `XLM`

Resolution is **deterministic**. A bare code that matches more than one
issuer is reported as `AMBIGUOUS` with the candidate canonical ids, never
resolved to an arbitrary candidate. An unregistered code is `NOT_FOUND`; a
malformed value is `INVALID_ALIAS`.

### Compatibility

Existing `/api/v1/prices/:asset` and `/api/v2/prices/:asset` endpoints keep
accepting the legacy bare-symbol form (`XLM`, `USDC`). The catalog resolves
the legacy symbol to a canonical id internally; responses keep the legacy
`asset` field unchanged and add the canonical id under `meta.asset` when the
catalog is consulted. No consumer-visible field is removed or renamed by this
change.

### Monitoring

* `feed_policy_saved_total{result}` — policy writes (accepted / rejected).
* `feed_policy_validation_errors_total{feed}` — policy writes rejected.
* `feed_quorum_evaluated_total{feed,result}` — quorum evaluations.
* `feed_quorum_reporting_sources{feed}` — eligible sources reporting.
* `feed_transitions_total{transition,to}` — applied lifecycle transitions.
* `feed_transition_denied_total{code}` — refused lifecycle transitions.
* `feed_alias_hits_total{kind,expired}` — alias redirects served.

All are registered in `api/src/observability/metrics.ts` and emitted by
`api/src/feeds/feed-service.ts`.

### Rollout / rollback

* **Rollout**: ship the modules and the admin routes dark (no catalog entries
  registered ⇒ lookups behave exactly as today). Then register feeds
  one by one via `PUT /api/v1/catalog/feeds/:feedId/policy`, promote them
  through the lifecycle and only then enable catalog lookups in the price
  path.
* **Rollback**: remove the catalog entry (`DELETE` on the policy store) or
  transition the feed to `suspended`; the price path then falls back to the
  legacy symbol behaviour. The change log keeps the history either way.

---

## 2. Per-feed eligibility and quorum (#674)

### Rule

Each feed carries a `FeedPolicy`:

```jsonc
{
  "feedId": "btc-usd",
  "asset": "public:BTC:GA5Z…",
  "version": 3,
  "sources": [
    { "name": "chainlink", "eligible": true, "weight": 2 },
    { "name": "redstone",  "eligible": true, "weight": 1 },
    { "name": "band",      "eligible": false, "disabledReason": "stale feed" }
  ],
  "quorum": { "minSources": 2, "minWeightBps": 5000, "distinctIssuersOnly": false }
}
```

* A source that is **not eligible** can never contribute to the feed; the
  contribution is rejected with an explicit reason.
* `quorum.minSources` — minimum number of eligible sources that must report.
* `quorum.minWeightBps` — optional; minimum share of the total eligible
  weight that must report, in basis points.
* `quorum.distinctIssuersOnly` — optional; a second contribution from an
  issuer that already reported is ignored, so a single issuer cannot
  manufacture quorum.

`validateFeedPolicy()` is the gate: an invalid policy is rejected with a list
of errors and is never stored. `evaluateQuorum()` is the runtime check and
returns both the verdict and the evidence (counted sources, rejected
sources with reasons, reporting weight in bps, failure reasons).

### Boundary rules

* `minSources` must be a positive integer ≤ 64 and ≤ the number of eligible
  sources.
* `minWeightBps` must be an integer in `[1, 10000]`.
* An ineligible source without a `disabledReason` is a **warning**, not an
  error — the reason is required for the audit trail, but the policy is still
  usable.
* Duplicate source declarations are an error.

### Compatibility

The global aggregator configuration keeps working unchanged. The catalog
policy is an *additional, per-feed* rule; a feed with no policy registered is
not governed by the catalog and behaves exactly as before. Nothing in the
aggregator's poll loop changes in this issue — the policy is data, evaluated
by the API, so no redeploy of the aggregator is required.

### Monitoring

* `feed_quorum_evaluated_total{feed,result}` — quorum evaluations by outcome;
  `result="unsatisfied"` is the alert signal.
* `feed_quorum_reporting_sources{feed}` (gauge) — eligible sources reporting.
* `feed_policy_validation_errors_total{feed}` — rejected policy writes.

### Rollout / rollback

Start with `minSources` equal to the current effective source count so the
verdict is unchanged, then tighten. Rollback = write the previous policy
version back; the version number is bumped on every write so the previous
policy is recoverable from the change log.

---

## 3. Governed feed onboarding lifecycle (#672)

### States and transitions

```
proposed ──validate──▶ validated ──promote-to-canary──▶ canary ──activate──▶ active
   │ reject                │ reject                        │ suspend            │ suspend
   ▼                       ▼                               ▼                    ▼
retired                 retired                          suspended           suspended
                                                                        resume │  retire
                                                                               ▼   ▼
                                                                            active retired
```

* `retired` is terminal.
* Every transition requires a **reason** and appends a `FeedChangeRecord`
  (sequence, from, to, actor, role, timestamp, reason, metadata) to the feed's
  append-only change log.
* Authorisation is two-part: the transition must exist for the current state
  *and* the actor's role must meet the transition's minimum role.

| Transition | Minimum role |
|---|---|
| `validate`, `promote-to-canary`, `suspend`, `resume`, `reject` | operator |
| `activate`, `retire` | admin |

`registerFeed()` creates a feed in `proposed` (operator+). Registering an
existing feed id is a conflict, not an update.

### Compatibility

The lifecycle is a pure state machine with an injectable store; it does not
change the price-serving path until a feed is wired into the catalog. A feed
whose lifecycle entry is missing is treated as `active` for lookups so that
existing feeds keep serving.

### Monitoring

* `feed_transitions_total{transition,to}` — applied transitions.
* `feed_transition_denied_total{code}` — refused transitions by reason code.

### Rollout / rollback

`activate` is the point at which a feed starts serving to consumers, so it is
the last step of the rollout and the first step of the rollback
(`suspend`). `retire` is deliberately separate from `suspend`: retirement is
for feeds that will not come back, and it is what makes an alias expire.

---

## 4. Feed alias and retirement semantics (#673)

### Rule

When a feed is renamed, merged or retired, the old identifier keeps working
for a bounded window:

| Alias kind | `successor` | Behaviour |
|---|---|---|
| `rename` | new feed id | requests for the old id are served by the successor |
| `merge`  | surviving feed id | requests for the merged id are served by the survivor |
| `retirement` | `null` | the old id resolves to nothing; the notice explains why |

Each alias entry records `sunsetAt` (the end of the compatibility window) and
a consumer-facing `notice`. A merge **must** name a successor; a retirement
**must not**. `sunsetAt` must be strictly after `registeredAt`.

### Response metadata

A price response served through an alias carries the alias metadata:

```jsonc
"meta": {
  "alias": {
    "requestedAlias": "BTC-USD-OLD",
    "canonicalFeed": "btc-usd",
    "aliasKind": "rename",
    "notice": "renamed to BTC/USD",
    "sunsetAt": "2026-04-01T00:00:00.000Z",
    "deprecated": false
  }
}
```

`deprecated` is `true` once the sunset date has passed. An expired alias
still resolves to its successor — a consumer is never silently pointed at the
wrong feed — but the flag tells it to migrate.

### Removal notices

* The alias notice is returned in `meta.alias.notice` for as long as the alias
  is registered.
* `expiredFeedAliases()` lists the aliases whose sunset date has passed; they
  can be removed from the registry (`registry.remove()`), after which the old
  identifier returns a `FEED_NOT_FOUND`.
* A retired feed's alias has no successor, so `meta.alias` is absent and the
  request fails with `FEED_NOT_FOUND`; the notice is available from the
  catalog so the API can return a deprecation notice alongside the error.

### Compatibility

The alias window is opt-in and per-alias. Feeds that never register an alias
keep their current behaviour exactly.

### Monitoring

* `feed_alias_hits_total{kind,expired}` — alias redirects served; the
  `expired="true"` series is the migration-pressure signal.
* `feed_alias_expired_total` — aliases past their sunset that are still
  registered (should trend to zero).

### Rollout / rollback

Register the alias **before** announcing the rename, so consumers never see
a gap. Rollback = remove the alias entry; consumers then get
`FEED_NOT_FOUND` for the old id, which is the intended end state after the
sunset date anyway.

---

## 5. Admin API

All routes live under `/api/v1/catalog` (`api/src/routes/feed-catalog.ts`) and
use the existing admin authentication plus per-route RBAC. The catalog has its
own router (rather than living inside the wider admin router) so it can be
rolled back independently.

| Method | Path | Role | Permission |
|---|---|---|---|
| GET | `/api/v1/catalog/feeds` | viewer | `feeds:read` |
| GET | `/api/v1/catalog/feeds/:feedId` | viewer | `feeds:read` |
| PUT | `/api/v1/catalog/feeds/:feedId/policy` | operator | `feeds:write` |
| POST | `/api/v1/catalog/feeds/:feedId/transitions` | operator | `feeds:write` |
| POST | `/api/v1/catalog/feeds/:feedId/aliases` | operator | `feeds:write` |
| GET | `/api/v1/catalog/feeds/:feedId/quorum?contributions=a,b` | viewer | `feeds:read` |
| GET | `/api/v1/catalog/assets/:alias` | viewer | `feeds:read` |

`feeds:read` is granted to viewer, operator and admin; `feeds:write` to
operator and admin. The lifecycle enforces a second, finer-grained gate on
top of the route role: `activate` and `retire` need the `admin` role even
though the route itself only requires `operator`.

Every lifecycle transition is recorded in the feed's own append-only change
log (see §3), which is returned by `GET /api/v1/catalog/feeds/:feedId`.

## 6. Tests

`api/tests/feeds/` covers, for every part, the normal path, the boundary
cases and the failure cases:

* `asset-identity.test.ts` — parsing, issuer/network validation, alias
  resolution order, ambiguity, unknown and malformed aliases.
* `feed-policy.test.ts` — policy validation boundaries (quorum vs. eligible
  count, bps range, duplicates, weights) and quorum evaluation (ineligible
  sources, duplicates, issuer distinctness, weight quorum).
* `feed-lifecycle.test.ts` — the full transition walk, illegal transitions,
  insufficient role, missing reason, terminal state, change-log contents.
* `feed-aliases.test.ts` — rename / merge / retirement, sunset boundaries,
  duplicate and invalid registrations, cleanup list, response metadata.
* `feed-catalog.test.ts` — lookup by feed id, canonical asset id and alias,
  non-publishable feeds, alias redirection with metadata, invalid policy.
