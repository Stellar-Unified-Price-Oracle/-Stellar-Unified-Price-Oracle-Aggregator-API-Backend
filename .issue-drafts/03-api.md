@@TITLE: Derive /sources from real source state instead of returning a hardcoded list
@@LABELS: api, javascript, bug, enhancement
@@BODY
## Problem

`GET /sources` in `api/src/price-serving/v1.ts` returns a literal array:

```ts
const allSources = [
  { name: 'Chainlink', active: true, type: 'off-chain', website: 'https://chain.link' },
  { name: 'Redstone', active: true, type: 'off-chain', website: 'https://redstone.finance' },
  ...
];
```

Every source is hardcoded `active: true`. The endpoint therefore reports a fixed, optimistic view regardless of reality: when Chainlink has been down for an hour, or its circuit breaker is open, or it is over its API budget, `/sources` still claims it is active. The `active` field is not merely decoration — it is the endpoint's only signal about source health, and consumers reasonably use it to judge how much of the feed is contributing. There is no way for a consumer to learn from this endpoint that the aggregator is running on two of four sources.

The real source state exists (`BaseSource.health` with `healthy`, `consecutiveFailures`, `uptimePercent`, `lastSuccess`, plus the circuit breaker's per-source state) but is not exposed through the API at all.

## Why this is hard

The interesting work is not plumbing the data but deciding what to expose, because the API and the aggregator are separate services with no shared state today — the API reads price JSON files via `price-store.ts` and has no channel to the aggregator's in-memory health. So the first decision is architectural: push source health into a shared store the API can read (Redis is already used by `cache.ts`), expose it on the aggregator's health server and have the API proxy it, or derive it from the aggregate metadata already being written. Each choice has different failure characteristics — a proxied read makes source health unavailable exactly when the aggregator is unhealthy, which is when it matters. Then there is a semantic decision: does `active` mean authorized, reachable, contributing to the current round, or healthy over a window? Those differ, and the field is currently used to mean all of them ambiguously. Whatever is exported also has to be consistent with the aggregator-side changes to uptime and distrust reporting, or the API will expose a second, contradictory health model.

## Requirements

- Replace the hardcoded list with real source state, sourced through a defined channel between the aggregator and the API. Document the channel and its failure behaviour.
- Split the overloaded `active` field into explicit, separately meaningful fields (e.g. authorized, reachable, contributing to the current round, health over the window) or document precisely which single meaning it carries.
- Include enough per-source detail to be actionable: last success, consecutive failures, and the circuit-breaker state at minimum.
- Define and implement the API's behaviour when source state is unavailable — an explicit error or an explicitly-marked unknown, never a stale optimistic default as today.
- Keep the response pagination intact (`applyOffsetPagination` is currently applied to the static array) and ensure it remains correct against a variable-length source list.
- Add tests that assert the endpoint reflects a degraded source rather than always reporting healthy.

## Acceptance Criteria

- [ ] `/sources` reflects real source state from a documented channel
- [ ] Ambiguous `active` split into explicit fields, or its single meaning documented
- [ ] Per-source detail includes last success, consecutive failures, breaker state
- [ ] Unavailable source state is signalled explicitly, never rendered as healthy
- [ ] Pagination correct against a variable-length list, with tests
- [ ] Test asserts a failing source renders as degraded
- [ ] `api/openapi.json` and `api/docs/API.md` updated to match
@@END

@@TITLE: Replace Redis KEYS with SCAN and pipelined UNLINK in cache invalidation
@@LABELS: api, javascript, performance, enhancement
@@BODY
## Problem

`HybridCache.invalidate` in `api/src/price-serving/cache.ts` runs:

```ts
const keys = await this.redis.keys(pattern);
if (keys.length > 0) await this.redis.del(...keys);
```

`KEYS` is O(N) over the entire keyspace and, critically, **blocks the Redis server** for the duration — it is single-threaded, so every other client stalls while the scan runs. This cache shares a Redis instance with anything else in the deployment (`docker-compose.redis-ha.yml`, `k8s/base/redis/`), so an invalidation triggered by a price update can stall unrelated traffic. The instance also stores a growing key set, since cache keys include asset, cursor, page, limit and `to`-timestamp combinations (`history:${asset}:c${cursor}:l${limit}:t${to}`), so the keyspace is large and `KEYS` cost grows with it.

Three further problems in the same function:

1. `redis.del(...keys)` splats every matched key into a single variadic call; with a large match set that is a huge command and a single point of failure.
2. The `DEL`/`UNLINK` and the subsequent `publish(INVALIDATION_CHANNEL, pattern)` are not atomic, so a concurrent `set` between them can repopulate a key that the other replicas then drop, or vice versa.
3. If `keys()` throws, the `catch` logs and swallows it, so invalidation silently fails and stale data is served indefinitely with no metric to notice.

## Why this is hard

`SCAN` is the obvious replacement but not a drop-in: it is a cursor-based, non-atomic iteration that may return duplicates and gives no guarantee about keys added or removed during the scan. Making invalidation correct under concurrent writes therefore requires reasoning the current code does not do — a key written during the scan may or may not be invalidated, and that has to be either made safe (e.g. versioned keys or an invalidation epoch) or bounded and documented. Then there is the multi-replica question, which is the part that makes this more than a mechanical swap: every instance holds an L1 in-process cache, and pub/sub tells other instances to clear theirs. A `SCAN` that runs locally while other replicas still hold an entry produces a window where instances serve different data, so the invalidation protocol itself (epoch counter, versioned keys, or a proper broadcast) needs a decision rather than a patch. All of this has to hold when Redis is degraded, since the cache is explicitly designed to fall back to L1 (`useRedis = false` on error with the L1 restored to full TTL) — an invalidation that only exists in Redis leaves those fallback instances permanently stale.

## Requirements

- Replace `KEYS` with cursor-based `SCAN`, batching deletions and using `UNLINK` rather than `DEL` where supported, so neither the scan nor the delete blocks.
- Handle `SCAN`'s non-atomicity explicitly: state what guarantees invalidation provides under concurrent writes, and either make it correct or bound the staleness window in documentation.
- Make the delete-and-broadcast sequence atomic or otherwise safe against interleaving with concurrent `set` calls.
- Surface invalidation failure as a metric and log rather than swallowing it; a failed invalidation should be alertable.
- Address the L1 fallback path: an instance running without Redis must still see invalidations, or the staleness must be bounded and documented.
- Bound the work per invalidation and document the cost characteristics of the new approach.

## Acceptance Criteria

- [ ] No `KEYS` usage remains; invalidation uses `SCAN` with batched `UNLINK`
- [ ] Concurrency guarantees of invalidation documented; staleness window bounded if not eliminated
- [ ] Delete + broadcast are atomic or interleaving-safe, with a test
- [ ] Invalidation failures are metered and alertable
- [ ] Redis-less instances observe invalidations or have a documented bound
- [ ] Latency impact on the Redis instance measured before/after under a populated keyspace
@@END

@@TITLE: Eliminate cache stampede with single-flight and stale-while-revalidate
@@LABELS: api, javascript, performance, enhancement
@@BODY
## Problem

Every read endpoint in `api/src/price-serving/v1.ts` follows the same pattern with no concurrency control:

```ts
const cached = await pricesCache.get(cacheKey);
if (cached) { cacheHitTotal.inc(); return res.json(okCached(cached)); }
cacheMissTotal.inc();
const prices = await readAssetPrices();   // every concurrent miss does this
await pricesCache.set(cacheKey, data, 'prices');
```

When a popular key expires, every request that arrives before the first one repopulates it performs the identical work. Prices expire on a 15s TTL and history on 60s, so this happens continuously rather than rarely. The consequences are worse than redundant CPU: the price cache is populated from `readAssetPrices()`, which reads the same JSON files the aggregator writes to via a blocking synchronous writer (`services/aggregator/src/persistence/history.ts`), and the Redis layer adds a `GET` plus a `SETEX` per duplicate miss. A burst of traffic coinciding with a TTL expiry turns into a thrash of file reads and Redis writes, and under a cold cache — a deploy, a restart, or the `invalidate()` call above — the entire fleet stampedes at once.

## Why this is hard

Single-flight and SWR are both easy to describe and genuinely awkward to get right in a multi-instance deployment, which is the deployment that exists (`k8s/overlays/prod-*`, HPA scaling the API). In-process single-flight only deduplicates within one replica, so with N replicas and a 15s TTL the stampede is reduced but not removed — a shared lock in Redis is the real fix, and it introduces a new failure mode where the lock holder dies and every other request waits on a lock that will never be released. That needs a lock TTL, a waiter timeout, and a defined fallback. Then SWR forces a correctness decision: serving a stale value while revalidating means clients can receive data older than the TTL they were promised, which for a price oracle is a semantic change that must be surfaced (the response already distinguishes cache hits via `okCached`, so there is a mechanism to extend). Deciding which endpoints may serve stale — `/prices` plausibly, `/health` and `/health/ready` definitely not, since a readiness check answered from a stale cache is actively harmful — is a per-endpoint policy, not a global switch. Jitter on TTLs is also needed to stop synchronized expiry, and it interacts with the exact-cache-key design that currently includes page/limit/cursor.

## Requirements

- Implement request coalescing so concurrent misses for the same key perform the underlying work once, **across replicas**, not just within one process.
- Add stale-while-revalidate with a per-endpoint policy. Explicitly exclude the health and readiness endpoints and document why.
- Add TTL jitter to prevent synchronized expiry across keys and instances.
- Define the failure behaviour when the coalescing mechanism is unavailable or the lock holder disappears: a bounded wait, then proceed, rather than unbounded blocking.
- Surface the response's staleness honestly to the client, extending the existing cached-response marker; add metrics for coalesced requests, SWR serves, and lock timeouts.
- Preserve the existing cache-key scheme's correctness, including that the invalidation protocol still works with coalescing in place.

## Acceptance Criteria

- [ ] Concurrent misses for one key perform the underlying work once, verified with a multi-replica test
- [ ] SWR implemented per endpoint; health/readiness excluded and the reason documented
- [ ] TTL jitter implemented and configurable
- [ ] Lock/lease failure path bounded; a dead holder does not stall requests indefinitely
- [ ] Clients can distinguish a revalidated stale response; metrics added
- [ ] Metrics for coalescing, SWR serves, lock timeouts; alerting wired
- [ ] Behaviour measured under a cold-cache burst, before and after
@@END

@@TITLE: Selective L1 invalidation — stop flushing the entire local cache on any single key change
@@LABELS: api, javascript, performance, enhancement
@@BODY
## Problem

The cross-instance invalidation subscriber in `api/src/price-serving/cache.ts` discards its entire L1 on any message, regardless of which keys the message concerns:

```ts
this.subscriber.on('message', (_channel, pattern) => {
  this.l1.clear();
  this.logger.debug(`Cache invalidated via pub/sub for pattern "${pattern}"`);
});
```

The `pattern` is received and logged but never used. A single `invalidate('price:XLM')` therefore wipes every cached entry on every instance — all assets, all pages, all cursors, all health and sources entries. With each price round invalidating keys on a 30s cadence across multiple assets, the L1 is effectively cleared continuously, which defeats the purpose of having it: the "avoid a Redis round-trip on every request" benefit described in the file's own comment is lost, and load shifts onto Redis and the file-backed price store at exactly the invalidation rate.

The same `clear()` is called unconditionally in `invalidate()` itself before the Redis work, so the invoking instance also drops everything.

## Why this is hard

Pattern-aware invalidation requires knowing what is in the L1, which the current `LRUCache` does not expose — it has no key enumeration and no way to match a pattern without walking the `Map`, and the cache key scheme is composite (`prices:${asset}:p${page}:l${limit}`, `history:${asset}:c${cursor}:l${limit}:t${to}`), so matching is not a simple prefix test. Adding enumeration is easy; making it correct and bounded is not, because a naive walk of up to 1000 entries per invalidation message across every message is its own performance problem at the invalidation rate. That pushes toward an index structure — a tag → keys mapping — which must itself be kept consistent as entries expire (the TTL expiry path in `get` deletes entries, so any index must be updated there too, or it leaks). Then there is the semantics question that makes this more than an optimisation: partial invalidation means an instance can hold a mix of pre- and post-invalidation entries, so correlated keys (a price and the paginated list that includes it) can be served inconsistently. The invalidation must be correct at least at the level of the atomic unit a client could observe, which is a design decision about what belongs in an invalidation group.

## Requirements

- Implement pattern-aware or tag-based selective invalidation, so a change to one key invalidates only the entries actually affected.
- Keep any index structure bounded and consistent with TTL expiry and LRU eviction; entries removed by either path must not leave dangling index references.
- Define invalidation groups: which cached keys must be invalidated together for a client never to observe an inconsistent combination (e.g. a single price and the paginated list containing it).
- Bound the per-invalidation work so a wide pattern cannot itself become the bottleneck; document the worst case.
- Preserve correctness for the Redis-less fallback path, where no pub/sub is available and L1 is the only cache.
- Add metrics for invalidated-entry counts and L1 hit rate so the change's benefit is measurable.

## Acceptance Criteria

- [ ] Invalidation affects only the relevant keys, verified by a test asserting unrelated entries survive
- [ ] Index structure bounded; no dangling refs after TTL expiry or LRU eviction, with tests
- [ ] Invalidation groups defined so correlated keys are never observed inconsistently
- [ ] Per-invalidation work bounded and worst case documented
- [ ] Redis-less fallback path remains correct
- [ ] L1 hit rate and invalidated-entry counts metered, with before/after measurements
@@END

@@TITLE: Single source of truth for the staleness threshold across API, aggregator, and docs
@@LABELS: api, javascript, bug, enhancement
@@BODY
## Problem

The staleness threshold is hardcoded as a literal `120` in several places in `api/src/price-serving/v1.ts`:

```ts
const hasStale = prices.some((p) => Date.now() / 1000 - p.timestamp > 120);
const status = prices.length === 0 ? 'unhealthy' : hasStale ? 'degraded' : 'healthy';
// ...
degradedAssets: prices.filter((p) => Date.now() / 1000 - p.timestamp > 120).map((p) => p.asset),
// ...
stale: Date.now() / 1000 - p.timestamp > 120,
```

Three separate literals in one handler, and the number is unrelated to the configured `STALENESS_THRESHOLD_MS` (documented in `README.md` and `.env.example` as `120000`) that the aggregator actually uses when deciding which prices are stale (`config.stalenessThresholdMs` in `services/aggregator/src/price-aggregation/aggregator.ts`). So the API's notion of stale and the aggregator's notion of stale are two independent constants that happen to agree today. Changing the aggregator's threshold — which is an env var and therefore a configuration change, not a code change — silently leaves the API reporting a different health verdict than the aggregator's own degradation level for the same data. The same value appears again in the WebSocket and in `docs/`, so the drift surface is wider than this file.

## Why this is hard

This looks like a constant-extraction task and turns out to be a distributed-configuration problem. The API reads price files, not aggregator memory, so it cannot ask the aggregator what threshold it used — the threshold must either be carried with the data (which means the aggregator writing its staleness configuration or a staleness verdict into what the API reads, a schema change across services) or be configured identically in both services with a mechanism that keeps them in sync (which is a deployment/configuration problem, not a code problem, and fails silently if one service is redeployed with a different value). The versioning aspect matters too: prices written today and yesterday were marked against whatever threshold was live then, so retroactively applying a new threshold to stored data changes historical health verdicts. Deciding whether staleness is a property of the observation (computed at write time, stored) or of the read (computed now, from the current config) is the real design question, and it determines whether this is a small refactor or a data-model change. The API also presents staleness in three different shapes — an aggregate `status`, a `degradedAssets` list, and a per-price `stale` boolean — and those must remain mutually consistent under whatever is chosen.

## Requirements

- Eliminate the duplicated literals; establish one authoritative definition of staleness and derive all three uses from it.
- Decide and document whether staleness is determined at write time (stored with the price) or read time (computed from current configuration), including the consequence for historical data.
- If the threshold must be shared across services, implement a synchronisation mechanism that fails loudly on divergence rather than silently drifting — do not rely on two env vars matching by convention.
- Ensure the API's health verdict, the `degradedAssets` list, and the per-price `stale` flag are mutually consistent by construction, not by three parallel computations.
- Reconcile with the aggregator's `DegradationLevel` so the API and aggregator cannot report contradictory health for the same underlying data.
- Update `.env.example`, `README.md`, `api/docs/API.md`, and `api/openapi.json` to reflect the single definition.

## Acceptance Criteria

- [ ] Single authoritative staleness definition; no duplicated literals
- [ ] Write-time vs read-time semantics decided and documented, including historical-data consequences
- [ ] Cross-service divergence fails loudly rather than drifting silently
- [ ] `status`, `degradedAssets`, and per-price `stale` consistent by construction, with a test
- [ ] API health and aggregator `DegradationLevel` cannot contradict each other; test asserts agreement
- [ ] All documentation and the OpenAPI spec updated
@@END

@@TITLE: Correct readiness semantics — readiness must reflect dependencies and per-asset availability
@@LABELS: api, javascript, devops, enhancement
@@BODY
## Problem

`/health/ready` in `api/src/price-serving/v1.ts` answers readiness from a single weak condition:

```ts
const prices = await readAssetPrices();
const ready = prices.length > 0;
res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', assetsTracked: prices.length });
```

Readiness therefore means only "at least one price file parsed". It does not check the cache backend, the database (`api/src/infrastructure/database.ts` and its pool, retry, and circuit-breaker machinery), the WebSocket server, or whether coverage is adequate. An instance with one stale price for one of five configured assets is reported ready and will keep receiving traffic; an instance whose Redis and database are both down but which has a price file on disk reports ready. Meanwhile `/health/live` always returns 200 unconditionally with only uptime, and the main `/health` handler computes its own separate verdict from the same data.

This matters operationally because Kubernetes reads these probes (`k8s/base/api/deployment-stable.yaml`, `deployment-canary.yaml`, and the HPA configs): readiness gates traffic, liveness gates restarts. Semantics that are too permissive keep broken instances in rotation; ones that are too strict cause restart storms. The current arrangement is too permissive on readiness, and because `readAssetPrices()` is called on every probe — bypassing the cache entirely for `/health/ready` — a frequent probe adds file IO per check.

## Why this is hard

Getting probes right requires deciding what each one is *for*, then making it cheap and correct. Readiness must answer "should this instance receive traffic", which depends on dependencies and data coverage, not merely on data presence — and checking dependencies on every probe is itself risky, because a slow dependency check makes the probe time out and Kubernetes removes a healthy pod. That forces cached, bounded, cheap dependency checks with their own staleness trade-off. Liveness is the opposite and must be deliberately shallow: it should only detect a wedged process, because any dependency failure reflected in liveness converts a downstream outage into a fleet-wide restart storm. Splitting a currently-ambiguous `/health` into these distinct meanings — while keeping it compatible for external consumers who have built on it — is the bulk of the work, along with deciding what "adequate coverage" means (a configured minimum asset count? a per-asset freshness requirement? a fraction of expected assets?) and making that configurable rather than assumed.

## Requirements

- Define readiness as: dependencies reachable **and** data coverage adequate. Specify what counts as adequate and make it configurable.
- Keep liveness deliberately shallow — process health only, never dependencies — and document the reasoning so it is not "improved" later into a restart-storm trigger.
- Make dependency checks bounded and cheap with an explicit timeout, and ensure a slow dependency cannot cause the probe itself to time out. Cache the dependency verdict for a short, documented interval rather than probing the filesystem or database on every request.
- Eliminate the uncached `readAssetPrices()` call from the readiness path.
- Resolve the relationship between `/health` and `/health/live`/`/health/ready` so the three cannot contradict each other; preserve compatibility for existing consumers.
- Update the Kubernetes probe configuration to make use of the corrected semantics, including appropriate thresholds to avoid flapping.

## Acceptance Criteria

- [ ] Readiness reflects dependencies and configurable coverage, not merely price presence
- [ ] Liveness is dependency-free and documented as deliberately shallow
- [ ] Dependency checks bounded, cached, and unable to cause probe timeouts
- [ ] No uncached data read on the readiness path
- [ ] Consistent relationship between `/health`, `/health/live`, `/health/ready`; no contradictions, with tests
- [ ] `k8s` probe configuration updated with flap-resistant thresholds
- [ ] Tests: dependency down but data present, data stale, partial coverage, and a slow dependency
@@END

@@TITLE: Cursor-paginate the prices collection — offset pagination over a mutating set duplicates and skips
@@LABELS: api, javascript, bug, enhancement
@@BODY
## Problem

`GET /prices` paginates with `applyOffsetPagination(filtered, page, limit)` (`api/src/price-serving/v1.ts`, `pagination.ts`). The underlying collection is the set of current prices, which the aggregator rewrites on a 30-second cycle, and entries move: an asset's price object is replaced, and the set's ordering is not guaranteed stable across reads.

Offset pagination assumes a stable, totally-ordered collection. Against this one it produces the classic symptoms: a client walking pages while a round lands receives the same asset twice (it shifted into a later page) or misses one entirely (it shifted out of the page being fetched). There is no cursor for this endpoint; `/history/:asset` has one (`buildCursorMeta`, `readPriceHistoryCursor`) and the root endpoint's own description states prices are "offset-based" while history is "cursor-based", so the inconsistency is deliberate in the API surface but the correctness problem is not addressed anywhere. The `pagination` metadata returned in the response likewise carries no stability guarantee.

## Why this is hard

The collection has no natural stable sort key. Prices are keyed by asset and carry a `timestamp`, but that timestamp is the observation time, which changes on every round — so a timestamp cursor is not stable either, since the value a client is ordering by mutates underneath them. A correct cursor has to order by something immutable (the asset identifier) and encode the last-seen position, which then forces a decision about assets appearing and disappearing from the tracked set mid-walk: a newly tracked asset should not appear in a walk already in progress if that would reorder the result, and a removed asset must not truncate it. That is a semantics question with no single right answer, and it needs to be decided and documented rather than left implicit. The change is also an API break for any client using `page`, and the endpoint is in the frozen v1 surface (`docs/` describe v1 as frozen, with `api/src/price-serving/v2.ts` and `versioning.ts` for newer behaviour), so the compatibility path has to be reconciled with the existing versioning and deprecation policy rather than shipped as a breaking change to v1.

## Requirements

- Introduce a stable cursor for `/prices` ordered on an immutable key, encoding the position and any necessary snapshot information.
- Define and document the semantics for assets added to or removed from the tracked set during a walk: whether an in-progress walk sees them, and why.
- Guarantee no duplicates and no silent skips across a full walk while rounds land concurrently; prove it with a test that mutates the underlying data between page fetches.
- Extend the response `pagination` metadata to describe the stability guarantees clients can rely on.
- Reconcile with the v1 freeze and the existing versioning/deprecation machinery (`versioning.ts`, `deprecation.ts`, `api/docs/DEPRECATION_POLICY.md`) — decide whether this lands in v1 as a compatible addition, in v2, or behind the deprecation process, and document the decision.
- Keep offset pagination functional for existing clients through whatever compatibility path is chosen.

## Acceptance Criteria

- [ ] Stable cursor ordering on an immutable key, implemented
- [ ] Add/remove-during-walk semantics documented and enforced
- [ ] Test mutates underlying data between page fetches and asserts no duplicates and no skips
- [ ] Pagination metadata documents the stability guarantees
- [ ] Versioning/deprecation decision documented and consistent with `api/docs/DEPRECATION_POLICY.md`
- [ ] Existing offset clients keep working via the chosen compatibility path
- [ ] OpenAPI spec and `api/docs/API.md` updated
@@END

@@TITLE: Enforce endpoint deprecation — the legacy history route has no sunset, telemetry, or removal path
@@LABELS: api, javascript, architecture, enhancement
@@BODY
## Problem

`GET /history/:asset/legacy` exists in `api/src/price-serving/v1.ts` as the "original non-paginated endpoint kept for backward compatibility". It has no `Deprecation` or `Sunset` header, no usage telemetry distinguishing it from the paginated replacement, no entry in the deprecation machinery, and no removal criterion.

The machinery to do this properly already exists and is unused by this route: `api/src/price-serving/deprecation.ts`, `api/src/infrastructure/deprecation-notifier.ts`, `api/docs/DEPRECATION_POLICY.md`, and the versioning support in `versioning.ts`. So the project has a documented deprecation policy that this route does not follow, and an indefinite-compatibility endpoint that is also the *unbounded* variant — it calls `readPriceHistory(upperAsset, from, to, limit)`, reading and filtering the full history file, which the paginated replacement avoids. Every legacy call is therefore both a policy gap and the more expensive code path, with no way to know whether anyone still uses it or when it can be deleted.

## Why this is hard

Turning a policy into an enforced lifecycle requires deciding what "deprecated" means concretely at each stage and implementing the transitions: announce (headers set, discovery updated), measure (per-client usage attribution, so the answer to "who still uses this" is answerable), warn (response-level notices without breaking parsers), and finally remove (a defined date, a defined replacement, a defined response for stragglers). The measurement piece is the part usually skipped and the one that makes removal possible — attributing legacy usage per API key requires the route to participate in the usage-tracking and auth machinery (`api/src/middleware/usage-tracking.ts`, `governance/usage-tracking.ts`) rather than being an anonymous path. The client-notification design also has a real constraint: the endpoint is in the frozen v1 surface, so its responses must stay parseable by existing clients, which rules out naive rejection and constrains how notices are delivered. And removal has a dependency the project must handle explicitly: the aggregator's own internal consumers and any scripts in `scripts/` may call this path, so removal requires an audit rather than a grep.

## Requirements

- Make the legacy route participate in the existing deprecation machinery: emit `Deprecation`/`Sunset` headers with a real date, and register it with `deprecation-notifier` and the OpenAPI spec so it is discoverable.
- Instrument per-consumer usage attribution, keyed to API keys where present, so actual users can be identified rather than assumed.
- Define explicit lifecycle stages and the criteria for advancing between them, including what metric threshold permits removal.
- Design a client notification mechanism compatible with the frozen v1 contract — no breaking change to clients that do not opt in.
- Audit internal consumers (aggregator, scripts, tests, docs, `load-tests/`) so removal does not break the project's own callers.
- Provide a defined post-sunset response (a documented status code and body) rather than an implicit 404.

## Acceptance Criteria

- [ ] Legacy route emits deprecation and sunset headers with a real date; registered in the OpenAPI spec
- [ ] Per-consumer usage telemetry implemented, with tests
- [ ] Lifecycle stages and advance/removal criteria documented
- [ ] Client notification works without breaking v1 parsers
- [ ] Internal consumer audit completed with results recorded
- [ ] Post-sunset response defined, implemented, and documented
- [ ] `api/docs/DEPRECATION_POLICY.md` updated to describe this worked example
@@END

@@TITLE: Bound WebSocket subscriptions and handle slow consumers with a defined backpressure policy
@@LABELS: api, javascript, enhancement
@@BODY
## Problem

The WebSocket server (`api/src/websocket/server.ts` for the API, `services/aggregator/src/infrastructure/ws-server.ts` for internal broadcast) supports per-asset subscriptions and a `subscribe`/`unsubscribe`/`ping` protocol, but the subscription set per connection is unbounded and there is no backpressure handling or slow-consumer policy.

Nothing caps how many assets a single client may subscribe to, so one connection can subscribe to the entire asset set; nothing caps the number of assets across connections in aggregate; and nothing detects a client that is not reading its socket fast enough. `ws.send` on a slow consumer queues in the socket buffer, so a stalled client causes the server to accumulate outbound data per connection — with a broadcast on every 30-second round multiplied by assets and subscribers, a handful of stalled clients is a real memory-growth path in the API process. There is also no metric for dropped or delayed messages, so this failure is invisible until the process is oom-killed. `ws-guard.ts` in the aggregator exists for related connection concerns but the API-side server does not share that policy.

## Why this is hard

Backpressure in a broadcast system is a policy problem, and every simple answer is wrong in some way. Dropping messages silently makes the client's view of prices subtly wrong with no signal; disconnecting slow consumers is decisive and observable but can turn a transient client-side stall into a reconnect storm; and buffering favours the client while putting server stability at risk. A correct design needs a per-connection policy that is explicit about which of those happens, at what threshold, and how the client learns about it — the WebSocket protocol has no built-in notion of "you missed an update", so once a message is dropped the client must either be told (requiring a protocol addition to `ws-messages.ts`) or must resynchronise on its own. Then the interaction with the auth and CSRF layer matters: `v1.ts` issues WS CSRF tokens with a configurable TTL (`config.ws.csrfTtlMs`), and a reconnect triggered by backpressure must re-authenticate cleanly. Subscription limits also have a fairness dimension across consumers, which ties into the rate-limit and quota work — a per-connection cap without a per-key cap simply moves the abuse to more connections.

## Requirements

- Enforce a per-connection subscription cap and an aggregate/global cap, both configurable, with a defined error response when exceeded.
- Implement slow-consumer detection based on socket buffer state, with an explicit policy: buffer up to a bound, then drop or disconnect per a documented rule.
- Define how a client learns it missed data. If updates can be dropped, add a protocol-level indication in `ws-messages.ts` and document the resulting client contract; if not, state the guarantee the protocol does provide.
- Emit metrics for subscription counts, dropped/disconnected slow consumers, and per-connection buffer usage; wire alerting so the condition is visible before it threatens the process.
- Reconcile the WS CSRF token lifecycle with reconnects caused by backpressure so a policy-triggered disconnect does not cause a failed or looping reconnect.
- Share the connection policy with `services/aggregator/src/infrastructure/ws-guard.ts` where the concerns overlap, rather than maintaining two divergent policies.

## Acceptance Criteria

- [ ] Per-connection and global subscription caps enforced and configurable, with a defined error
- [ ] Slow-consumer policy implemented and documented (buffer bound, then drop or disconnect)
- [ ] Client-visible signal for dropped updates, or a documented guarantee that none are dropped
- [ ] Metrics for subscriptions, drops, disconnects, buffer usage; alert rule added
- [ ] Reconnect after a policy disconnect handles CSRF reissue correctly, with a test
- [ ] Policy reconciles with `ws-guard.ts`; no divergent duplicate policy
- [ ] Test with a deliberately stalled client asserts bounded memory rather than unbounded growth
@@END

@@TITLE: Unify the two error models and contract-test responses against the OpenAPI spec
@@LABELS: api, javascript, architecture, tests, enhancement
@@BODY
## Problem

The API has two coexisting error representations. `api/src/infrastructure/app-error.ts` defines an `AppError` class, while `api/src/infrastructure/error.ts` contains the error and 404 handler middleware. Route handlers in `api/src/price-serving/v1.ts` use a third convention inline, shaping responses by hand through the `fail()` helper:

```ts
return res.status(404).json(fail({ code: 'PRICE_NOT_FOUND', message: '...' }));
```

Validation failures take a fourth path via `formatValidationResponse(validation.error)`. Whether a given endpoint returns `{ error: { code, message } }`, a Zod-derived shape, or something else depends on which line of which handler ran. The OpenAPI spec (`api/src/infrastructure/openapi.ts`, emitted to `api/openapi.json` and served at `/api/v1/docs`) describes error responses separately, and nothing verifies the spec matches reality — so the published contract is a claim rather than a guarantee. `api/docs/API.md` documents error codes too, making three descriptions of error behaviour that are maintained independently.

## Why this is hard

Unifying the models means committing to a wire shape and then reconciling every producer and every consumer, including the ones that are easy to miss: the WebSocket error frames in `ws-messages.ts`, the sandbox and events routes, the GraphQL layer in `api/src/graphql/`, the governance and webhook routes, and the metrics/logging middleware that currently records errors in whatever shape it is handed. The genuinely difficult part is that this is a *breaking* contract change for clients that parse error bodies, on a surface partly described as frozen, so the migration needs the versioning and deprecation machinery rather than a flag day. Then establishing the spec as the source of truth requires response contract testing — asserting that real handler responses validate against the schema the spec publishes, across success and every error path. That is more invasive than it sounds: it requires exercising error paths deterministically (dependency failures, timeouts, validation errors, not-found, rate-limit, CSRF, auth) which means the test harness needs fault injection that does not currently exist. And the two internal error modules have subtly different responsibilities, so merging them without losing the 404 and unexpected-error handling behaviour needs care.

## Requirements

- Choose one error response shape and migrate every producer to it: REST handlers, validation failures, middleware, WebSocket error frames, GraphQL, and the governance/webhook routes.
- Consolidate `app-error.ts` and `error.ts` into a single error model without regressing 404 handling, unexpected-error handling, or the existing logging/metrics behaviour.
- Reconcile the three independent descriptions — the code, `api/openapi.json`, and `api/docs/API.md` — so one is authoritative and the others are derived or verified.
- Add response contract tests asserting real responses validate against the published OpenAPI schemas for success paths and every documented error path, including dependency-failure and timeout cases.
- Introduce the fault injection needed to exercise error paths deterministically in tests.
- Roll out the client-visible change through the versioning/deprecation process rather than as a breaking change in place, documenting the migration for consumers.
- Ensure error responses do not leak internals (stack traces, database or RPC detail) while retaining enough for support, consistent with `api/docs/SECURITY.md`.

## Acceptance Criteria

- [ ] Single error shape across REST, validation, middleware, WebSocket, and GraphQL
- [ ] `app-error.ts` and `error.ts` consolidated with no regression in 404 or unexpected-error handling
- [ ] One authoritative error description; OpenAPI and `api/docs/API.md` verified against it
- [ ] Response contract tests cover success and all documented error paths, including dependency failure and timeout
- [ ] Fault injection available for deterministic error-path testing
- [ ] Client migration path documented and versioned per the deprecation policy
- [ ] No internal detail leaked in error bodies; reviewed against `api/docs/SECURITY.md`
@@END
