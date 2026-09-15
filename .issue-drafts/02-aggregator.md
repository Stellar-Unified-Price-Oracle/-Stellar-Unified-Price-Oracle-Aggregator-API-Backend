@@TITLE: Normalize decimals before taking the median — the aggregate is currently computed across incomparable integers
@@LABELS: aggregator, javascript, bug, enhancement
@@BODY
## Problem

`PriceAggregator.medianPrice` (`services/aggregator/src/price-aggregation/aggregator.ts`) sorts and medians raw `BigNumber` values taken directly from `NormalizedPrice.price`:

```ts
const sorted = prices.map((p) => new BigNumber(p.price.toString())).sort(...)
```

`price` is an integer scaled by **that source's own `decimals`** — `BaseSource.normalize` computes `rawPrice * 10^decimals` (`services/aggregator/src/oracle-sources/base.ts`) and each source passes its own decimal count. Chainlink, Redstone, Band and Reflector do not agree on decimals, and the same source can differ per asset. Comparing `10^8`-scaled integers against `10^18`-scaled integers and taking the "median" produces a number that corresponds to no asset's price.

The second half of the bug is in `getLatestForAsset`, which label the whole aggregate with the fractional source's scale:

```ts
decimals: pricesToUse[0].decimals
```

So the output claims a consistent decimal count that the inputs did not have. Downstream, `medianFloat` divides by `10^decimals` and feeds the anomaly detector, meaning the anomaly detector has been operating on the same corrupted value.

## Why this is hard

Normalising on ingest looks trivial and is not. Choosing a single canonical scale means deciding what happens to assets whose sources have wildly different precision — normalising 8-decimal precision up to 18 decimals does not invent precision, and the aggregate's rounding behaviour has to be defined rather than inherited from `BigNumber` defaults. The alternative, normalising at aggregation time, must handle the mixed-scale set on every single call and keep the median itself exact, which means integer-only median arithmetic on a common scale (the current even-length branch does `(a + b) / 2`, which can produce a non-integer on a scale that cannot represent it). Both approaches change stored history values (`services/aggregator/src/persistence/history.ts`), so backward compatibility of already-written data has to be addressed. And this is a *silent* correctness bug — every existing test passes — so the fix needs a test that would have caught it.

## Requirements

- Choose a canonical scale (per asset, or global) and normalize every `NormalizedPrice` to it at the ingest boundary, before it reaches the aggregator.
- Make `NormalizedPrice.decimals` invariant: after normalization, all prices for an asset carry the same decimals, and `getLatestForAsset` may rely on that.
- Define median semantics exactly, including the even-length case, using integer arithmetic that cannot silently lose precision. State the rounding rule.
- Validate the assumption rather than trusting it: add a runtime guard that rejects or loudly flags any price reaching aggregation with an unexpected scale, so a future source cannot reintroduce this.
- Address existing history files — document whether previously written values are comparable under the new scheme, and provide a migration or a compatibility marker if not.
- Add tests using real per-source decimal configurations that fail against the current implementation.

## Acceptance Criteria

- [ ] Canonical scale chosen and documented, with the rounding rule for the even-length median case
- [ ] All prices normalized before aggregation; `decimals` invariant holds for every asset
- [ ] Median uses integer arithmetic with no precision loss on the canonical scale
- [ ] Guard rejects/flags unexpected scales at the aggregation boundary
- [ ] Tests with mixed per-source decimals (e.g. 8 vs 18) fail before the change and pass after
- [ ] History-value compatibility documented, with migration if required
@@END

@@TITLE: Concurrent source polling — replace the sequential fetch loop with a bounded scheduler
@@LABELS: aggregator, javascript, performance, enhancement
@@BODY
## Problem

`BaseSource.fetchAll` (`services/aggregator/src/oracle-sources/base.ts`) polls serially:

```ts
for (const asset of assets) {
  const price = await this.fetchWithBackoff(asset);
  if (price) results.push(price);
}
```

Every asset waits for the previous one, including its full retry ladder. `fetchWithBackoff` retries up to 3 times with exponential backoff up to 10s (`Math.min(baseDelay * 2^(attempt-1) + jitter, 10000)`). So with one flaky source, a single asset can burn ~30s of the 30s poll interval before the next asset is even attempted — and there are four sources × five assets, each polled with this loop. The scheduler silently overruns its interval and the effective poll cadence degrades exactly when sources are unhealthy, which is when fresh prices matter most.

## Why this is hard

Unbounded `Promise.all` is the naive fix and it is actively harmful here: four concurrent requests per asset across many assets creates a burst against each provider, which is the fastest way to get rate-limited or banned, and it removes the backpressure that currently (accidentally) exists. A correct scheduler needs a concurrency budget, and it needs to be per-source rather than global, because providers have independent quotas — which is also where the cost model (`services/aggregator/src/infrastructure/cost-model.ts`) and the per-source circuit breaker come in. Then the interesting part: what does a round mean once polling is concurrent? The poll loop in `services/aggregator/src/index.ts` currently assumes a round is done when the loop returns. With concurrency it needs a defined completion condition, a per-round deadline, and a policy for sources that miss it — and unlike now, partial results must be usable rather than blocking the round. Thundering-herd avoidance at round start (jittered scheduling) matters too, which the current inter-asset serialization accidentally provided.

## Requirements

- Replace the sequential loop with a bounded-concurrency scheduler, with the concurrency limit **per source** and configurable.
- Add a per-round deadline. On expiry, the round proceeds with whatever results arrived and explicitly records which (source, asset) pairs were dropped, rather than blocking.
- Signal a round's completion deterministically from the scheduler (e.g. an explicit barrier), so the poll loop in `index.ts` no longer infers it from the loop returning.
- Add round-start jitter / stagger so all sources are not hit simultaneously.
- Integrate with the per-source circuit breaker and the cost model so a source that is open or over budget is not scheduled.
- Ensure retry backoff remains a property of the source, not of the scheduler, and that retries do not extend a round past its deadline.

## Acceptance Criteria

- [ ] Per-source concurrency limit, configurable, enforced and tested
- [ ] Round deadline enforced; partial results used, dropped pairs recorded as metrics and logs
- [ ] Round completion is explicit and deterministic
- [ ] Round-start jitter present and configurable
- [ ] Open-circuit and over-budget sources are skipped by the scheduler
- [ ] Test proves a single flaky asset no longer delays the rest of the round
- [ ] Poll cadence stays within interval under a simulated failing source; measured before/after
@@END

@@TITLE: Define an explicit degraded-mode policy — suspicious prices are currently used when every source is suspicious
@@LABELS: aggregator, javascript, security, enhancement
@@BODY
## Problem

`getLatestForAsset` (`services/aggregator/src/price-aggregation/aggregator.ts`) filters out sources the circuit breaker has flagged, then immediately falls back to the unfiltered set:

```ts
const trustedPrices = activePrices.filter((p) => { /* not suspicious */ });
const pricesToUse = trustedPrices.length > 0 ? trustedPrices : activePrices;
```

If **every** source is flagged suspicious, `trustedPrices` is empty and `pricesToUse` becomes `activePrices` — i.e. the entire set of sources the system just decided it does not trust. There is no log, no metric, no degradation flag, and no difference in the returned payload beyond the unchanged `confidence` ratio. The consumer cannot tell that the value they are being served came exclusively from suspect inputs.

This is compounded by the `stale` fallback directly above it, which does the same thing for staleness: `activePrices = stale ? prices : validPrices` means when *all* prices are stale, stale prices are used and returned with `stale: true`. That one is at least signalled; the suspicion fallback is not.

## Why this is hard

The right answer is a policy question with no default that is safe in all directions. Refusing to serve a price is itself a failure mode for a DeFi protocol — a hard `null` can revert a liquidation that should have proceeded, so "fail closed" is not automatically correct. But silently serving a fully-distrusted value is worse, because it is undetectable. Getting this right requires distinguishing several states that the current type collapses into one: all sources healthy; some suspicious with a trustworthy quorum remaining; all suspicious; all stale; no sources at all. Each needs a defined output, and the output has to carry enough information for a consumer to make its own decision. That means changing the aggregate's shape (adding provenance/exclusion reasons), which is a breaking change for every consumer — including the API in `api/src/`, the on-chain publisher, and the WebSocket broadcast — so it needs a versioned rollout. And the policy must be consistent with `computeDegradationLevel`, which already computes a notion of degradation that ignores suspicion entirely.

## Requirements

- Enumerate the aggregate's states explicitly (healthy, partially distrusted, fully distrusted, stale, empty) and define for each: what price is served, what flags are set, and what is logged/metriced.
- Always signal which sources were excluded and why, in the returned aggregate. A consumer must be able to see that a value came only from distrusted or stale inputs.
- Reconcile with `computeDegradationLevel` so degradation reflects distrust as well as staleness and count — today it detects none of this.
- Add metrics for the "served while fully distrusted" and "served while fully stale" cases so the condition is alertable; wire to the alerting config in `monitoring/`.
- Decide and document whether the on-chain publisher and WebSocket broadcast should suppress fully-distrusted values, and implement that consistently.
- Roll the payload change out in a way that does not break existing consumers in one step.

## Acceptance Criteria

- [ ] All aggregate states enumerated with a documented policy per state
- [ ] Excluded sources and exclusion reasons always present in the returned payload
- [ ] `computeDegradationLevel` accounts for distrust
- [ ] Metrics count fully-distrusted and fully-stale serving events; alert rule added
- [ ] Publisher and WS broadcast follow a documented, consistent rule for distrusted values
- [ ] Tests cover each state, including the fully-distrusted case that currently serves suspect data silently
- [ ] Consumer-facing payload change is versioned with a compatibility path
@@END

@@TITLE: Sliding-window uptime — replace the lifetime-average that never recovers
@@LABELS: aggregator, javascript, bug, enhancement
@@BODY
## Problem

`BaseSource.calcUptime` (`services/aggregator/src/oracle-sources/base.ts`) computes uptime from lifetime counters:

```ts
const failureRatio = this.health.totalFailures / Math.max(this.health.totalRequests, 1);
return Math.round((1 - failureRatio) * 100);
```

Because `totalFailures` and `totalRequests` only ever grow, a source that had a bad first hour a month ago is permanently marked down regardless of current health. `uptimePercent` is reported in health output and underpins source-health dashboards, so the number operators see is a historical average mislabeled as current health. It also *inverts* at the other end: a source that has been failing hard for the last ten minutes but had a long healthy history shows a high uptime, which is the precise opposite of what on-call needs.

Separately, `Math.round` on a 0–100 percentage means any failure ratio above 99.5% rounds to a healthy-looking `100`, so chronic low-level failure is invisible.

## Why this is hard

A real uptime measure needs a window, and picking one forces engagement with the SLOs the rest of the system already declares (`monitoring/slo.yml`, `docs/GOLDEN_SIGNALS.md`): uptime over what period, measured how? Sources are polled irregularly once the scheduler is concurrent and rounds can be cut short by a deadline, so a naive "count successes per wall-clock minute" denominator breaks down — a source that was never attempted during an outage of the aggregator itself must not be scored as down. That distinction (not attempted vs attempted-and-failed) is not represented in the current `SourceHealthStatus` type at all, and adding it is a type change that ripples into the API's `/sources` output and the synthetic probes. Choosing between a tumbling window, a ring of per-minute buckets, and a proper rolling percentile also has a memory/accuracy trade-off per source that should be decided deliberately.

## Requirements

- Introduce a windowed uptime measure aligned with the SLO definitions, replacing the lifetime average.
- Distinguish "not attempted" from "attempted and failed" in the health model, so aggregator-side outages do not count against sources.
- Preserve enough resolution to represent partial failure honestly — remove the rounding that collapses sub-1% failure rates to a clean 100.
- Bound the memory cost per source explicitly and document it.
- Keep the exposed `SourceHealthStatus` shape compatible for existing consumers, or version it; it feeds the API and the health server.
- Surface the difference between lifetime and windowed figures during a transition period so operators can interpret the change rather than be surprised by it.

## Acceptance Criteria

- [ ] Windowed uptime implemented with the window length aligned to a documented SLO
- [ ] "Not attempted" tracked separately and excluded from the denominator, with a test simulating an aggregator-side outage
- [ ] Partial failures are visible; no value collapses to exactly 100 while failures are occurring
- [ ] Per-source memory cost bounded and documented
- [ ] Consumer-visible shape compatible or versioned; API and health server updated
- [ ] Tests cover: recovery to healthy after a bad window, degradation within a window, and unattempted periods
@@END

@@TITLE: Replace synchronous full-file history writes with an async batched, crash-safe writer
@@LABELS: aggregator, javascript, data, performance, enhancement
@@BODY
## Problem

`services/aggregator/src/persistence/history.ts` performs blocking filesystem IO on the hot path of every price round:

```ts
export function appendHistoricalPrice(asset, price, decimals, source, timestamp): void {
  history = readHistoryFile(filePath);   // fs.readFileSync of the whole file
  history.push({ ... });
  writeHistoryFile(filePath, pruneHistory(history)); // full JSON.stringify + fs.writeFileSync
}
```

Every single price append reads the entire history file, parses it, re-serializes the whole array, and writes it synchronously. With `config.history.maxEntries` entries retained, each append is O(n) parse and O(n) serialize on the Node event loop — and `writeFileSync` blocks it outright. When history encryption is enabled (`historyEncryptionEnabled()`), `encrypt`/`decrypt` run over the entire payload on that same path, multiplying the cost. All of this happens while the same process is polling sources and serving the WebSocket.

There is also a durability problem in the same code: `writeFileSync` writes in place, so a crash mid-write leaves a truncated JSON file. `readHistoryFile` has no recovery — `JSON.parse` throws, and callers swallow it (`catch { /* ignore corrupt data */ }` in `appendHistoricalPrice`), which silently discards the retained history.

## Why this is hard

Buffering writes conflicts directly with durability, and both properties are load-bearing for an oracle: you cannot lose a price observation, and you cannot block the poll loop. Resolving that needs an explicit contract — a bounded in-memory buffer, a flush interval, and a documented maximum data-at-risk window, plus an fsync policy that trades throughput for it. Crash safety needs atomic replace (write to temp + `fsync` + `rename`) rather than in-place writes, and the corrupt-file recovery path needs to be an actual recovery (truncate to the last valid record) rather than a swallowed exception that resets history to empty. Layering encryption on top means the append path operates on plaintext while the file is ciphertext, so buffering has to happen before encryption and the key-rotation story has to be consistent with whatever format is chosen. And this is the same data the API reads — `api/src/price-serving/price-store.ts` reads the same files — so a format or timing change has visible API consequences, including preserving the ordering guarantees cursor pagination relies on.

## Requirements

- Move appends to a buffered writer with a bounded buffer size and a configurable flush interval, with the maximum at-risk window documented.
- Implement atomic durable writes: temp file, `fsync`, `rename`. Never mutate the history file in place.
- Implement real corruption recovery: detect a truncated or invalid tail, recover to the last valid record, and record the loss as a metric rather than silently emptying history.
- Keep encryption-at-rest compatible with buffering; define the on-disk format precisely, including how a partially written encrypted payload is detected.
- Preserve the ordering and retention guarantees that the API's cursor pagination and the gap-detection workflow depend on.
- Guarantee no observation is lost across a clean shutdown, and document the precise semantics on an unclean shutdown.

## Acceptance Criteria

- [ ] Appends are buffered; event loop is not blocked; measured before/after under load
- [ ] Writes are atomic (temp + fsync + rename); no in-place mutation of history files
- [ ] Corrupted/truncated file recovers to the last valid record and increments a loss metric
- [ ] Encryption-at-rest works with buffering; format documented
- [ ] API read path remains compatible; cursor ordering preserved and tested
- [ ] Clean shutdown flushes without loss; unclean-shutdown loss window documented and bounded
- [ ] Tests: crash mid-write, torn encrypted payload, buffer overflow, flush-on-shutdown
@@END

@@TITLE: Replace the count-ratio confidence with a defensible confidence score
@@LABELS: aggregator, javascript, enhancement
@@BODY
## Problem

`confidence` in `getLatestForAsset` (`services/aggregator/src/price-aggregation/aggregator.ts`) is:

```ts
const confidence = pricesToUse.length / Math.max(totalSources, 1);
```

This is a count ratio, and it is not a statement about how much the price should be trusted. Two examples of what it gets wrong: four sources reporting wildly divergent prices (say $40k, $60k, $200k, $1) yield `confidence: 1.0`, the maximum; meanwhile three tightly-agreeing sources out of four yield `0.75` and are scored lower. The field's name promises a trust measure and it delivers a participation measure. Downstream consumers — the API payload (`api/src/price-serving/`), the WebSocket broadcast, and `docs/EVENT_SCHEMA.md` consumers — treat it as the former, and it is documented as such.

Nothing else in the aggregate compensates: `anomaly-detector.ts` scores the aggregate value against historical baselines but does not measure inter-source agreement, and the reputation stored on-chain (`utils::update_reputation`) is not consulted at all when producing the aggregate.

## Why this is hard

A confidence score is a modelling decision that has to be justified, not a formula to be invented. It has to combine at least inter-source dispersion, freshness relative to each source's own cadence, and per-source standing — and those have different units and different failure modes, so the combination itself (weighted geometric mean? minimum-based? quorum-weighted?) is the real design question. It also has to behave sensibly at the boundaries: one source, zero variance, enormous variance, and a single wild outlier among agreeing sources. Crucially it must be *calibrated* to be useful: a 0.8 must mean something predictive about the price being right, which requires holding out historical data and checking. And it must degrade gracefully into the degraded-mode policy being defined alongside this, because "low confidence" and "distrusted sources" are related but not identical, and conflating them recreates the ambiguity this issue is trying to remove.

## Requirements

- Define confidence as a documented function of at least: inter-source dispersion, per-source freshness, and per-source standing/reputation. Justify each component and the combination.
- Calibrate against held-out historical data; document the observed relationship between score bands and subsequent price accuracy.
- Ensure the score distinguishes a tight consensus from a wide one and handles single-source and high-variance cases explicitly.
- Wire per-source reputation into the aggregate; today on-chain reputation exists and is entirely unused by aggregation.
- Reconcile the definition with the degraded-mode policy so the two concepts are coherent and separately actionable.
- Version the change for consumers — this field is in the API and WebSocket payloads and its meaning changes.

## Acceptance Criteria

- [ ] Confidence definition documented, with each component and the combination justified
- [ ] Calibration performed against historical data; the relationship between bands and accuracy reported
- [ ] Divergent-source case no longer scores higher than an agreeing majority, with tests
- [ ] Reputation contributes to the score; the on-chain reputation value is actually consumed
- [ ] Degraded-mode policy and confidence are coherent; documented together
- [ ] Payload change versioned; API, WebSocket, and `docs/EVENT_SCHEMA.md` updated
@@END

@@TITLE: Aggregate-level outlier rejection — quorum and dispersion rules at the round level
@@LABELS: aggregator, javascript, security, enhancement
@@BODY
## Problem

The aggregator has a per-source deviation check (`circuit-breaker.ts`, comparing a new price against the existing set) and a post-hoc `anomaly-detector.ts` that scores the resulting median against historical baselines. Neither performs outlier rejection *on the set being aggregated*.

`medianPrice` sorts the raw values and takes the middle. With four sources, the median is the average of the two middle values, so a single wildly-wrong source that happens to land in the middle, or two coordinated wrong sources, directly shift the reported price. There is no MAD/percentile-based rejection, no minimum-agreement requirement, and no rule for what to do when the set has no majority cluster — for instance one source at $50k and three at $200k. The system currently has no way to say "these sources do not agree" and therefore cannot refuse to publish; it always publishes the median of whatever it was given.

## Why this is hard

Outlier rejection is easy to get wrong in the direction of censorship. If the true price genuinely moves and only the fastest source reflects it, a dispersion filter that rejects the minority will reject the *correct* value and keep the stale consensus — the failure mode where an oracle lags a real market move and causes liquidations at a price that no longer exists. So the rules must distinguish "sources disagree because one is wrong" from "sources disagree because the price is moving", and that distinction requires information the current pipeline does not carry: each source's own update cadence, its recent accuracy, and whether the disagreement is directional (all moving the same way) or noisy. It also has to be reconcilable with the on-chain deviation guard in `submit_price`, or the aggregator will compute an aggregate the contract then rejects — and with `MAX_HISTORY_LEN`-based history, since rejecting an outlier means deliberately not writing a price. Deciding what gets published when the quorum rule fails is a policy decision with real downstream consequences, not an implementation detail.

## Requirements

- Implement dispersion-based outlier detection at the aggregate level (e.g. MAD or a percentile band) and define exactly how rejected values are excluded.
- Define a minimum-agreement / quorum rule and what happens when it fails — refuse to publish is a legitimate option but must be an explicit, configured decision with observability.
- Distinguish genuine price movement from source error, using per-source cadence and recent accuracy, and document the heuristic and its known limits.
- Keep the rule consistent with the on-chain deviation guard so the aggregator does not produce aggregates the contract will reject.
- Record every rejection: which source, which value, which rule. Rejections must be auditable after the fact, and must feed the source's reputation rather than being discarded.
- Cover the adversarial cases in tests: one far outlier, two coordinated outliers, a genuine fast market move with a lagging majority, and a three-way split.

## Acceptance Criteria

- [ ] Dispersion-based rejection implemented with a documented rule and threshold
- [ ] Quorum/minimum-agreement rule defined; failure path configured, observable, and documented
- [ ] Price-movement vs source-error heuristic documented with stated limitations
- [ ] Consistent with the on-chain deviation guard; no aggregate produced that `submit_price` would reject
- [ ] Rejections logged, metered, and fed back into reputation
- [ ] Tests cover all four adversarial cases, including the market-move case where the minority is correct
@@END

@@TITLE: Make circuit-breaker state shared across replicas instead of per-process
@@LABELS: aggregator, javascript, architecture, enhancement
@@BODY
## Problem

Source health is tracked in process-local memory. `services/aggregator/src/price-aggregation/source-circuit-breaker.ts` exports a `sourceCircuitBreaker` singleton, and `price-aggregation/circuit-breaker.ts` holds its state in a `Map` on a `PriceAggregator` instance. `BaseSource.fetchWithBackoff` consults the singleton to decide whether to skip a fetch.

This means every replica independently discovers that a source is down, and independent replicas disagree. With N replicas, N replicas each have to fail the same source before each one opens its breaker, and each then runs its own recovery probe schedule. The practical consequences: the system as a whole pays N× the failing calls against a provider that is already degraded (which is precisely when rate limiting and bans happen); some replicas skip a source while others keep hammering it, so requests are not evenly spread; source health reported by any single instance is only true of that instance; and replicas can flap independently, so the fleet oscillates between open and closed with no coherent state.

## Why this is hard

Sharing breaker state is easy to do badly. Redis is already a dependency (`api/src/price-serving/cache.ts` uses it, and `docker-compose.redis-ha.yml` / `k8s/base/redis/` exist), so a naive counter in Redis is the obvious move — and it creates a new hard dependency on the source-polling hot path, where Redis latency now sits between the poller and its decision to fetch. If Redis is unavailable, the breaker must fail open or closed by a documented, defensible rule, and either choice has consequences. The state also needs to be *eventually* consistent without being a coordination bottleneck: replicas must not all open at once on a transient blip, but neither should a single replica's flapping pin the fleet. That means the shared state needs hysteresis propertied across replicas, which is genuinely more subtle than a shared counter. And the transition must not change the behavior the WebSocket and health endpoints report, since `SourceHealthStatus` is surfaced to consumers.

## Requirements

- Move breaker state to shared storage with a fully specified schema, including the semantics of each counter and what "half-open" means when multiple replicas may probe simultaneously.
- Define and document behaviour when shared storage is unavailable: fail open or fail closed, with the reasoning and the blast radius of the choice.
- Prevent N replicas from performing N concurrent recovery probes; designate or coordinate probing so recovery is a single, bounded effort.
- Add hysteresis so transient blips do not open the breaker fleet-wide, and so a single flapping replica cannot pin shared state.
- Preserve the observable `SourceHealthStatus` contract consumed by the API and health server; if the value's meaning changes from local to fleet-wide, that must be visible in the payload and documented.
- Bound the additional latency added to the fetch decision path and measure it.

## Acceptance Criteria

- [ ] Breaker state shared and schema documented
- [ ] Behaviour under shared-storage outage decided, implemented, and documented
- [ ] Recovery probing coordinated so replicas do not multiply probes
- [ ] Hysteresis prevents fleet-wide flapping; tested with a flapping replica
- [ ] `SourceHealthStatus` remains compatible, with any meaning change documented
- [ ] Decision-path latency measured and bounded
- [ ] Test: with multiple replicas, a failing source is skipped fleet-wide without N× duplicate calls
@@END

@@TITLE: Add on-chain reconciliation to the publisher — compare intent against contract state after every round
@@LABELS: aggregator, javascript, contract, enhancement
@@BODY
## Problem

The publishing path (`services/aggregator/src/contract-publishing/publisher.ts`, `retry-queue.ts`, `canary.ts`) treats submission as fire-and-forget with retries. Nothing ever reads back on-chain state to confirm that what the aggregator intended to publish is what the contract actually holds.

That gap is reachable through several ordinary paths. `retry-queue.ts` replays queued submissions after a restart, so the contract can receive a *later* round's price before an earlier one — and `submit_price` has no ordering guard (tracked separately), so the older value may win. The Merkle batch path in `apply_batch_entry` is permissionless and per-leaf, so a batch can be partially applied indefinitely, leaving the on-chain price at a mix of rounds with no local record of which leaves landed. And `submit_price`'s optional deviation guard can reject a submission the aggregator considered successful — the rejection is an error the retry path may treat as transient. In all of these cases the aggregator's internal state and the contract's state diverge silently, and the aggregator is the thing whose health dashboard everyone trusts.

## Why this is hard

Reconciliation requires a notion of what "correct on-chain" means, which the system does not currently have. Comparing the latest on-chain price against the local aggregate is not sufficient — they legitimately differ, because sources move and rounds advance, so a mismatch is the normal case rather than a signal. A useful check needs a durable record of intent keyed to a round, some way to identify which on-chain write corresponds to which intent (a round identifier or nonce committed on-chain, which is a contract change), and a tolerance for legitimate divergence. Then the correction policy is the hard part: re-publishing an old value to "fix" a mismatch is usually wrong and actively harmful, so reconciliation must distinguish "our intended write never landed" from "our write landed and the world has since moved", and it must not fight a concurrent round. It also has to be safe under multiple aggregator replicas, where several instances may reconcile against the same contract simultaneously.

## Requirements

- Define what constitutes divergence and what constitutes legitimate difference, with explicit tolerances.
- Establish durable intent: persist what each round intended to publish, keyed to something recoverable after a restart. Add an on-chain round/sequence identifier if one is needed to correlate intent with state (coordinate with the contract-side ordering work).
- Implement a reconciliation loop that reads contract state and compares it to intent, on a defined schedule and after restarts, with alerting on sustained divergence.
- Define the corrective action precisely: when re-publishing is correct, when it is harmful, and when the right response is to alert a human rather than self-heal.
- Handle partial batch application: detect, resume, or explicitly abandon an incomplete batch, with the choice documented.
- Make reconciliation safe with multiple replicas — use leadership election, leasing, or a lock so replicas do not concurrently correct.
- Distinguish rejection reasons (deviation guard vs transient vs permanent) so retry logic does not hot-loop on a non-retryable failure.

## Acceptance Criteria

- [ ] Divergence and tolerance defined and documented
- [ ] Durable per-round intent persisted and recoverable after restart, with tests
- [ ] Reconciliation loop implemented with scheduled and post-restart runs; sustained divergence alerts
- [ ] Corrective policy documented with explicit no-op and escalate-to-human cases
- [ ] Partial batch application detected and handled; behaviour documented
- [ ] Multi-replica safety via lease/lock, with a test running two reconcilers
- [ ] Non-retryable rejections are not retried infinitely; test proves the retry queue converges
@@END

@@TITLE: Separate observation time from ingestion time — sources currently disagree on what timestamp means
@@LABELS: aggregator, javascript, bug, enhancement
@@BODY
## Problem

Every `NormalizedPrice` carries a `timestamp`, and different sources populate it with **different meanings**. Confirmed in the implementations:

- `ChainlinkSource.fetchPrice` (`services/aggregator/src/oracle-sources/chainlink.ts`) passes `Math.floor(Date.now() / 1000)` — **local ingestion time**. It ignores whatever the provider says about the age of the value.
- `BandSource.fetchPrice` (`services/aggregator/src/oracle-sources/band.ts`) passes `response.data.data.updated_at || Math.floor(Date.now() / 1000)` — the **provider's update time**, falling back to local time when absent.

So the same field means "when we fetched it" for one source and "when the provider says it changed" for another, and a third meaning again when the fallback fires. `getLatestForAsset` then uses it for freshness:

```ts
const validPrices = prices.filter((p) => Date.now() - p.timestamp * 1000 < config.stalenessThresholdMs);
```

For Chainlink that check is vacuous — the timestamp was just set to now, so a price derived from a provider value that is hours old is permanently "fresh". For Band it does what was intended. The aggregate then stamps `timestamp: Math.floor(Date.now() / 1000)` regardless, discarding whatever age information the sources supplied, and `submit_price` stores that.

Downstream, this timestamp is the basis for staleness verdicts in the API, retention cutoffs in `pruneHistory`, cursor ordering in `/history/:asset`, and the gap-detection workflow — so one ambiguous field is load-bearing for four separate behaviours.

## Why this is hard

Splitting the field requires deciding what each one means and where it comes from, for each source independently, since providers expose different things and some expose nothing. The distinction that matters is threefold, not twofold: **observation time** (when the price was actually true), **ingestion time** (when this service learned it), and **publish time** (when a decision was made). Freshness, retention, and audit each need a different one — stale detection is meaningless on ingestion time, and audit is meaningless without it. Each source needs its actual capability determined rather than assumed: a provider with no timestamp cannot supply observation time, and the honest handling is to record that absence explicitly rather than substituting `Date.now()` and silently asserting a freshness guarantee the data does not support. Clock skew is the second problem — provider timestamps come from their clocks, and a source with a clock ahead of ours produces future-dated observations that break ordering and staleness checks, so a skew policy with a bound is needed. And because the aggregate currently carries one timestamp, adding fields is a payload change across the API, the WebSocket messages, the persisted history format (which `appendHistoricalPrice` writes and the API reads), and the on-chain `PriceDataPoint` — so the migration has to be considered across all of them, not just the aggregator.

## Requirements

- Define the time fields explicitly — observation, ingestion, and publish time — with documented semantics and the guarantee each one supports.
- Determine each source's actual capability and populate the fields honestly. Where a provider supplies no observation time, record its absence explicitly rather than substituting local time; document the consequence for staleness detection on that source.
- Add a clock-skew policy with a bound: define handling for provider timestamps in the future relative to local time (clamp, reject, or accept with a flag) and for implausibly old ones.
- Ensure staleness detection operates on the correct field, so a source without observation time is either excluded from freshness-based trust decisions or is flagged as unable to certify freshness. Do not leave the current vacuous check in place for any source.
- Propagate the new fields through the persisted history format, the API payload, the WebSocket messages, and the on-chain point, with a migration for existing data and an explicit statement of what existing records' timestamps meant.
- Preserve correct behaviour for retention cutoffs and cursor ordering, which currently depend on the single ambiguous field.
- Cover with tests the specific case that is broken today: a source whose underlying value is older than the staleness threshold, delivered with a local-time timestamp, must not be treated as fresh.

## Acceptance Criteria

- [ ] Observation/ingestion/publish semantics defined and documented; each guarantee attributed to a specific field
- [ ] Every source populates the fields according to its real capability; missing observation time recorded explicitly, not substituted
- [ ] Clock-skew policy defined and enforced with a documented bound; future-dated handling tested
- [ ] Staleness detection uses the correct field; no source retains a vacuous freshness check
- [ ] Propagation through history format, API payload, WS messages, and on-chain point, with migration
- [ ] Meaning of historical timestamps documented
- [ ] Retention cutoffs and cursor ordering verified correct after the change
- [ ] Test proves a stale underlying value with a local-time timestamp is no longer treated as fresh
- [ ] `docs/EVENT_SCHEMA.md` and `api/docs/API.md` updated
@@END
