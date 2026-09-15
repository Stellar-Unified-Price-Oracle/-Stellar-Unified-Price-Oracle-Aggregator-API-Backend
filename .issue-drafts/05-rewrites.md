@@TARGET: 61
@@TITLE: Proactive anomaly detection: z-score and MAD detectors with calibrated thresholds and a measured false-positive rate
@@LABELS: aggregator, data, enhancement
@@BODY
## Problem

Anomaly detection exists but is not a calibrated statistical system. `services/aggregator/src/price-aggregation/anomaly-detector.ts` produces a score that `PriceAggregator.getLatestForAsset` attaches to the aggregate, which reaches the API and WebSocket payloads.

What is missing is everything that makes detection trustworthy: the thresholds are not derived from data, the algorithms are not stated or tested against known-shape inputs, sensitivity is not configurable per asset even though assets differ enormously in volatility (XLM and USDC cannot share a threshold), and the false-positive rate is unmeasurable because verdicts are not persisted. Without a measured false-positive rate, changing a threshold cannot be judged, and the feature is decorative — an alert nobody trusts.

**Scope boundary:** this issue is deliberately *not* the prediction pipeline in #122. Nothing here requires ML, model training, or inference. It is deterministic statistical detection against a baseline, and it must remain understandable and debuggable by an on-call engineer at 3am.

## Requirements

- Implement two detectors with stated, documented mathematics: a rolling z-score against a moving mean/standard deviation, and a median-absolute-deviation (MAD) detector. MAD is required because a z-score's own baseline is corrupted by the outlier being tested — a point that should be stated in the docs, not just implemented.
- Make the window length, sensitivity, and threshold configurable **per asset**, with defaults derived from analysis of retained history rather than chosen arbitrarily.
- Define what "anomaly" means in the output: a boolean verdict plus the score, the detector that fired, the baseline it compared against, and the window used. A bare score is not actionable.
- Handle the baseline-cold-start case explicitly (fewer observations than the window requires) — the current behaviour should not be "no detection" by accident.
- Measure the false-positive rate on real retained history at the chosen defaults, and report it. This is the acceptance criterion that makes the feature real: state the rate and how it was measured.
- Persist verdicts sufficiently to evaluate them later; coordinate with the verdict-persistence work so this does not build a second mechanism.
- Distinguish an anomalous *aggregate* from anomalous *inputs*: a wild single source should be reported differently from a market move where all sources agree, because the responses differ.

## Acceptance Criteria

- [ ] Z-score and MAD detectors implemented with documented mathematics and cited rationale for both
- [ ] Window, sensitivity, and threshold configurable per asset; defaults justified from history
- [ ] Verdict includes score, firing detector, baseline, and window
- [ ] Cold-start behaviour defined and tested
- [ ] False-positive rate measured at defaults on real history and reported in the issue/PR and in `monitoring/`
- [ ] Verdicts persisted via the shared persistence path, not a parallel one
- [ ] Aggregate anomaly vs input disagreement distinguished in output
- [ ] Tests use synthetic series with known injected anomalies (spike, drift, level shift) and assert detection
@@END

@@TARGET: 113
@@TITLE: Durable domain events: transactional outbox, idempotent consumers, and a replayable event log
@@LABELS: architecture, aggregator, api, enhancement
@@BODY
## Problem

The project has an in-process event bus (`services/aggregator/src/domain-events/index.ts`, `api/src/domain-events/index.ts`) that both services publish to: `PriceRequestedEvent` from the API handlers, `sla_breach` from `BaseSource.fetchWithBackoff`, `PriceHistoryRequestedEvent` from the history route. It is fire-and-forget.

Anything published is lost on restart, not delivered if the process is not running, and not visible to the other service at all. That matters because the bus is already being used for things that are expected to have effects — SLA breach notifications, usage and request events that feed `governance/usage-tracking.ts` and `services/usage-analytics.ts` — so behaviour silently depends on a process staying up. There is also a second, separate replication path for cross-region prices (`services/aggregator/src/replication/kafka-bus-client.ts`, `kafka-replicator.ts`, plus the Terraform `message-bus` and `mirror-maker` modules), so the project has messaging infrastructure and two inconsistent notions of what an event is.

## Requirements

- Define the event contract: what an event is, its identity, ordering guarantees, retention, and which existing event types migrate. Reconcile with `docs/EVENT_SCHEMA.md` rather than creating a third description.
- Implement the transactional outbox pattern for events that have side effects, so publishing and the state change that produced the event cannot diverge. State explicitly which events require this and which are genuinely best-effort.
- Make consumers idempotent with a documented deduplication strategy and a durable processed-event record. Replay must be safe.
- Provide a replayable, ordered event log so a consumer can be rebuilt from the beginning, and document the retention of that log.
- Decide and document the relationship with the existing Kafka replication path — one event mechanism with a coherent story, or two with clearly separated responsibilities and documented reasoning. Do not leave two overlapping buses.
- Define behaviour when the message infrastructure is unavailable: events must not be silently dropped, and the buffering and its durability contract must be stated.
- Add observability for delivery, redelivery, deduplication hits, and consumer lag.

## Acceptance Criteria

- [ ] Event contract defined and reconciled with `docs/EVENT_SCHEMA.md`
- [ ] Transactional outbox implemented for side-effecting events; which events need it is documented
- [ ] Consumers idempotent, with durable deduplication and a test proving replay safety
- [ ] Replayable ordered log with documented retention; a consumer rebuilt from replay in a test
- [ ] Relationship to the existing Kafka replication path resolved and documented; no undocumented overlap
- [ ] Infrastructure-unavailable behaviour defined; no silent drops
- [ ] Metrics for delivery, redelivery, dedup hits, and consumer lag, with alerts
- [ ] Existing event types migrated or explicitly retained as best-effort with reasons
@@END

@@TARGET: 114
@@TITLE: Strict TypeScript migration in enforced stages: branded boundary types, unit-safe arithmetic, and an escape-hatch ratchet
@@LABELS: api, architecture, tests, enhancement
@@BODY
## Problem

External data enters the system typed as loose primitives. Oracle API responses, persisted history JSON, WebSocket frames, database rows, and environment variables are all typed structurally rather than by provenance, so a malformed response propagates as a valid-looking type and surfaces as a runtime error far from the cause. Two concrete instances: `readHistoryFile` in `services/aggregator/src/persistence/history.ts` casts `JSON.parse(contents) as HistoricalPriceEntry[]` with no validation at all, and `BaseSource.normalize` derives a price from a provider response whose shape is assumed.

There is also a units problem with real consequences. Prices are `bigint` scaled by a `decimals` field that travels alongside them, unsynchronised — which is exactly how the aggregator came to median raw integers across sources with different decimals. Nothing in the type system prevents adding a price to a timestamp or mixing two prices at different scales.

## Requirements

This must land incrementally with enforcement at each stage, not as a single sweeping change. Each stage must be independently reviewable and leave the codebase green.

- **Stage 1 — boundary validation with branded types.** Introduce branded types for each external boundary (provider response, persisted history entry, WebSocket frame, database row, environment variable) and require that branded values can only be produced by a validating parser. Start with the aggregator's persistence and oracle-source boundaries (`infrastructure/types.ts` is the natural home). `JSON.parse` results must not be assignable to domain types.
- **Stage 2 — units as phantom types.** Introduce phantom-typed or nominal wrappers making prices, timestamps, and decimal counts incompatible in arithmetic, so adding a price to a timestamp is a compile error. Include a scaled-decimal type that carries its scale, which is the mechanism that would have prevented the cross-decimal median bug.
- **Stage 3 — strict flags with a ratchet.** Enable `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`. Because enabling these at once across ~19k lines is not reviewable, introduce a checked-in allowlist of remaining violations with a CI job that fails when a new violation is added and reports the count trending down. The ratchet must only tighten; removing entries from the allowlist is the required direction of travel.
- **Stage 4 — no new escape hatches.** Add a CI check that blocks new `any`, `as`, `@ts-ignore`, and `@ts-expect-error` outside the allowlist. Fix existing violations in the boundaries touched by stages 1–2 rather than repo-wide, and record the remainder.
- Static type-level state machines for the WebSocket connection lifecycle are explicitly **out of scope** for this issue and belong in the WebSocket workstream.

## Acceptance Criteria

- [ ] Stage 1: branded types for all listed boundaries; only validators can construct them; `JSON.parse` output is not assignable to a domain type (proved by a compile-fail test or a type-level assertion)
- [ ] Stage 2: units are incompatible in arithmetic; mixing scales or adding price to timestamp fails type-check, demonstrated by a negative test
- [ ] Stage 3: all five strict flags enabled with a checked-in allowlist and a CI ratchet that fails on new violations and reports the count
- [ ] Stage 4: new escape hatches blocked in CI outside the allowlist
- [ ] Every stage merged independently with the repo green at each point; per-stage diff reviewed
- [ ] Documented in `docs/DEVELOPMENT.md` with the current allowlist position and the plan to zero it
- [ ] No regression in existing build or test commands (`build:backend`, `typecheck:all`, `test:backend`)
@@END

@@TARGET: 115
@@TITLE: Generated API contracts: OpenAPI from code, TS clients from OpenAPI, with drift detection in CI
@@LABELS: api, architecture, tests, enhancement
@@BODY
## Problem

The OpenAPI specification is maintained by hand in `api/src/infrastructure/openapi.ts` and emitted to `api/openapi.json`, served at `/api/v1/docs`. It is not derived from the implementation, and nothing verifies it describes reality, so it drifts silently — the spec is a claim about the API rather than a contract the API satisfies. The error-model work is a live example: route handlers shape responses inline via `fail()`, validation errors go through `formatValidationResponse`, and the spec documents error responses separately.

No client is generated from the spec either, so the TypeScript SDK mentioned in `docs/DEVELOPER_PORTAL.md` and the `sdk-publish.yml` workflow has no guaranteed correspondence with the server. Consumers therefore discover contract breaks at runtime, and the project's own publish pipeline (`docs/CONTRACT_VERSIONING.md`, `api/docs/DEPRECATION_POLICY.md`) has nothing to gate on. Bidirectional generation is the goal, but the direction that matters first is making the spec *true*.

## Requirements

- **Spec from code (priority).** Derive the OpenAPI document from the implementation. Where derivation cannot capture something (examples, descriptions, error semantics), keep authored fragments merged into the generated output rather than hand-maintaining the whole file. The generated artifact must be reproducible and committed with a CI check that fails when it is stale.
- **Response contract verification.** Assert that real responses validate against the generated schemas, covering success and every documented error path. This requires deterministic fault injection for dependency failures, timeouts, validation errors, 404, rate-limit, CSRF, and auth — build that rather than skipping the error paths.
- **Clients from spec.** Generate a typed TypeScript client from the spec for `packages/` consumption, replacing hand-written request types where they exist. Add a CI check that regeneration is clean.
- **Compatibility gate.** Add a check that fails on backwards-incompatible changes to the published spec, with an explicit, justified override for deliberate breaks that are being taken through the deprecation process. Gate `sdk-publish.yml` on it.
- **Versioning reconciliation.** Make the generated spec carry the versioning state the project already has (`versioning.ts`, v1 freeze, v2) so a frozen path cannot be altered by generation.

## Acceptance Criteria

- [ ] OpenAPI derived from code with authored fragments merged; generated artifact reproducible and committed
- [ ] CI fails when the committed spec is stale relative to the implementation
- [ ] Response contract tests validate real responses against the spec for success and all documented error paths
- [ ] Deterministic fault injection available for error-path tests
- [ ] Typed TS client generated from the spec; CI fails on dirty regeneration
- [ ] Backwards-compatibility gate implemented, with a justified override path, gating SDK publish
- [ ] Frozen v1 paths protected from modification by generation
- [ ] `api/docs/API.md` and `/api/v1/docs` served from the single generated source
@@END

@@TARGET: 116
@@TITLE: Hexagonal boundaries for oracle sources and price storage, with enforced dependency direction
@@LABELS: architecture, aggregator, api, enhancement
@@BODY
## Problem

Domain logic and infrastructure are entangled, and the coupling is concrete rather than abstract. `PriceAggregator` (`services/aggregator/src/price-aggregation/aggregator.ts`) imports `config` directly and imports the module-level `anomalyDetector` singleton rather than receiving it. `BaseSource.fetchWithBackoff` reads and writes a module-level `sourceCircuitBreaker` singleton, publishes to the module-level `eventBus`, and calls `recordCall`/`estimateCostUsd` from `infrastructure/cost-model.ts` — both reading a global budget and mutating global state. Persistence is called through concrete functions (`appendHistoricalPrice`) rather than an interface. The API has the same shape: handlers in `price-serving/v1.ts` call concrete `readAssetPrices` and the module-level `pricesCache`, which is initialised by a separate `initializeCache` call.

The cost is not aesthetic. None of these units can be tested without their real collaborators, which is why the median-decimals bug in `medianPrice` — pure arithmetic, trivially testable in isolation — had no such test and shipped. Substituting a source or a store requires editing modules.

**Scope boundary:** this issue converts two specific boundaries — oracle sources and price storage — and enforces dependency direction for them. It is **not** a repo-wide re-architecture, not a DDD taxonomy exercise, and not a multi-tenant build-out. Multi-tenancy is a separate concern and should be raised separately if it is wanted; smuggling it in here would make this unlandable.

## Requirements

- Define ports for the two boundaries: a source-fetching port and a price-store port, with the domain depending only on those interfaces and never importing `infrastructure/*`, a concrete store, or a singleton.
- Move `PriceAggregator`'s dependencies to constructor injection: configuration, the anomaly detector, the circuit-breaker policy, and the event publisher. After this, the aggregator must be constructible with in-memory fakes and no global state.
- Move `BaseSource`'s collaborator usage behind injected interfaces so a source can be exercised without the global circuit breaker, the global event bus, or the global cost model. Define behaviour when the cost model is absent rather than assuming a global.
- Extract the persistence boundary so `appendHistoricalPrice`/`getHistoricalPrices` are reached through an interface. The JSON-file implementation becomes one adapter, which is the prerequisite for the TimescaleDB migration.
- Enforce the dependency direction with a CI check (an import-boundary lint) so the rule cannot erode: domain modules must not import infrastructure modules. This check is the deliverable that keeps the refactor from reverting.
- Preserve observable behaviour: existing endpoint responses, WS broadcasts, and metric emissions must be unchanged, verified by the existing test suites.

## Acceptance Criteria

- [ ] Source and store ports defined; domain modules import no infrastructure or singletons, enforced by a CI import-boundary check
- [ ] `PriceAggregator` fully constructor-injected; unit-testable with fakes and no global state
- [ ] `BaseSource` collaborators injected; missing cost model has defined behaviour
- [ ] Persistence accessed through an interface; the JSON file path is one adapter behind it
- [ ] Import-boundary check fails on a violation (proved with a deliberate violation)
- [ ] Behaviour unchanged: existing aggregator and API tests pass, metrics and payloads identical
- [ ] `medianPrice` (and the decimal-normalisation logic) covered by pure unit tests with no infrastructure, demonstrating the boundary actually enables what it claims
- [ ] Documented in `docs/DEVELOPMENT.md` as the pattern for future boundaries
@@END

@@TARGET: 119
@@TITLE: Consumer-driven contract tests for the aggregator/API boundary, WS message schema, and a compatibility gate
@@LABELS: tests, api, aggregator, architecture, enhancement
@@BODY
## Problem

The two services are coupled through contracts that nothing verifies. The API reads price data written by the aggregator (`api/src/price-serving/price-store.ts` reading the JSON written by `services/aggregator/src/persistence/history.ts`); the internal WebSocket broadcast carries a message shape defined in `services/aggregator/src/infrastructure/ws-server.ts` and consumed by the API; and `docs/EVENT_SCHEMA.md` documents event payloads that neither side validates against.

Consequently a change to a writer's output — a renamed field, a changed timestamp unit, a new required property — breaks the reader silently and is caught, if at all, in integration tests or production. The per-source decimal and timestamp-unit problems are exactly this class of defect. There are no consumer-driven contracts: the producer is not tested against consumer expectations, so the only feedback loop is "something broke".

## Requirements

Deliver this incrementally, boundary by boundary, so each step is independently valuable. The order below is deliberate: the highest-frequency, highest-damage boundary first.

- **Boundary 1 — aggregator to API price data.** Define the contract for the persisted price/history representation as the consumer (API) requires it, and test the aggregator's writer against it. Use the `packages/types` package as the shared type home so both sides derive from one definition.
- **Boundary 2 — WebSocket messages.** Define the message schema (subscribe/unsubscribe/ping, price updates, error frames) as a verifiable contract and test both the producer and consumer against it. Include the negative cases: unknown message types, malformed payloads, and missing fields must be rejected identically on both sides. Reconcile with `api/src/infrastructure/ws-messages.ts` and `docs/EVENT_SCHEMA.md`.
- **Boundary 3 — canary verification.** Extend the canary path (`services/aggregator/src/contract-publishing/canary.ts`, `k8s/base/api/deployment-canary.yaml`, `scripts/deploy-canary.js`) so a contract violation is detected during canary and prevents promotion, not after full rollout.
- **Compatibility gate.** Add a CI check that fails on a backwards-incompatible contract change, with an explicit, justified override for deliberate breaks taken through the deprecation process. Version the contracts so a breaking change is expressible rather than merely blocked.
- Choose the tooling deliberately and state the choice. If introducing an external framework, justify it against the project's convention of small dependency surfaces; a hand-rolled schema-validation approach using the existing Zod dependency is an acceptable and arguably preferable answer — say which and why.

## Acceptance Criteria

- [ ] Boundary 1: price/history contract defined in `packages/types`, consumer-driven, with the aggregator writer tested against it
- [ ] Boundary 2: WS message schema contract with both producer and consumer tested, including rejection cases
- [ ] Boundary 3: canary detects a contract violation and blocks promotion; demonstrated with a deliberately broken contract
- [ ] Compatibility gate in CI with a justified override path; contracts versioned
- [ ] Tooling choice justified against existing dependencies and project conventions
- [ ] Contracts reconciled with `docs/EVENT_SCHEMA.md` and `api/src/infrastructure/ws-messages.ts`
- [ ] A deliberately introduced breaking change fails CI (negative test)
- [ ] Documented in `INTEGRATION_TESTS.md` with how to run each boundary's tests locally
@@END

@@TARGET: 122
@@TITLE: Price forecasting: offline evaluation harness and a baseline model with measured accuracy before any serving work
@@LABELS: aggregator, data, enhancement
@@BODY
## Problem

The system reports what prices are, not what they will be, and there is no way to know whether predicting them is even feasible with the data on hand. The accumulated history in `services/aggregator/src/persistence/history.ts` (and, once migrated, TimescaleDB) is used only for current-value and history queries.

Any serious forecasting effort has to begin by answering a prior question: **how accurate can a prediction be at this cadence, and is that accuracy useful?** Jumping straight to a served inference pipeline with model versioning, drift-triggered retraining, and A/B promotion would build substantial machinery around a capability whose value is unmeasured — and a price oracle whose predictions are wrong is worse than one that makes no prediction, because consumers will act on them.

**This issue is deliberately scoped to the prerequisite.** Online inference, model registry, automated retraining, A/B promotion, and prediction endpoints are explicitly **out of scope** and are follow-on work, gated on the accuracy this issue measures. The staged structure is the point: the earlier attempt at this scope was unlandable because it bundled nine independent systems.

## Requirements

- **Stage 1 — data readiness.** Assemble a training/evaluation dataset from retained history with a documented definition of the target (what is being predicted, at what horizon, per asset) and an honest statement of data quality: gaps, provenance, and whether reconstructed or backfilled observations are usable as targets. This depends on the provenance work; if provenance does not exist yet, state how targets are selected and the resulting limitation.
- **Stage 2 — evaluation harness.** Build a reproducible offline harness with a strict temporal split (no leakage across the split, which is the single most common way a forecasting evaluation becomes meaningless) and a holdout that respects the time series's non-stationarity. Report MAPE, RMSE, and directional accuracy, **and against a naive baseline** — predicting "no change" and "same as last observed". A model that does not beat those baselines has no reason to exist, and that comparison is the deliverable.
- **Stage 3 — one model, evaluated.** Implement a single, well-understood model family (ARIMA or a gradient-boosted regressor on simple features). Explainable and debuggable beats sophisticated. Feature engineering limited to inputs derivable from what the system actually retains, documented so a reader can recompute any feature.
- **Stage 4 — a written go/no-go.** Report the accuracy achieved, per asset and per horizon, against the baselines, with uncertainty. State plainly whether accuracy is sufficient to justify serving predictions to consumers, and at what horizon if any. A negative result is a valid and valuable outcome that closes or reframes the follow-on work.
- Persist the harness and its outputs so results are reproducible, and record the accuracy figures in the repository for later comparison.

## Acceptance Criteria

- [ ] Target definition, horizon, and per-asset scope documented; data-quality limitations stated honestly
- [ ] Evaluation harness reproducible, with a temporal split that provably avoids leakage (test asserts no future data reaches training)
- [ ] Naive baselines (no-change, last-observed) implemented and reported alongside the model
- [ ] One model family implemented with documented, reproducible features
- [ ] MAPE, RMSE, and directional accuracy reported per asset and per horizon, with uncertainty
- [ ] Written go/no-go recommendation stating whether serving is justified, at what horizon, per asset
- [ ] Results persisted and recorded for future comparison
- [ ] No serving, registry, retraining, or A/B machinery in this issue — follow-on work explicitly gated on the go/no-go outcome
- [ ] Clear statement of what this evaluation does **not** establish
@@END

@@TARGET: 458
@@TITLE: Fee metering and billing: idempotent metering, deterministic invoice generation, and reconciliation
@@LABELS: api, data, enhancement
@@BODY
## Problem

Metering and billing are partial. `api/src/governance/usage-tracking.ts`, `services/usage-analytics.ts`, and `api/src/middleware/usage-tracking.ts` record usage, `api/src/governance/usage.ts` and `self-service.ts` expose it, and `config/cost-invoices.json` with `scripts/reconcile-cost-invoices.mjs` imply an invoice concept. What does not exist is a trustworthy metering-to-invoice chain.

The gap that matters is correctness, not coverage: usage records are written by middleware on the request path, where a retried request, a timeout after the billing write, a WebSocket message counted per connection rather than per delivery, or a late-arriving record can each produce double-counting or under-counting. Nothing makes metering idempotent. And nothing reconciles the metered totals against what was actually billed, so a metering defect surfaces as a customer dispute or a revenue discrepancy rather than as an alert.

## Requirements

- **Idempotent metering.** Define a stable idempotency key per billable event and enforce uniqueness so retries and duplicate deliveries cannot double-count. State what constitutes one billable unit per endpoint class, WebSocket delivery, and any batch or bulk operation, and document it against `docs/fee-schedule.md`.
- **Metering off the critical path.** Recording usage must not make a request fail or slow down when the metering store is degraded. Define the buffering, the durability contract, and the explicit maximum at-risk window, consistent with how the history writer is being hardened.
- **Deterministic invoice generation.** Generate invoices from metered usage with a defined, versioned rule set (tiers, quotas, rounding, currency, proration) so the same inputs always produce the same invoice. Rounding rules must be stated — silent rounding is where billing disputes come from.
- **Reconciliation.** Reconcile invoice totals against metered usage and against API request logs, and report variance. Define the acceptable tolerance and alert above it. Reconcile business-wise with the cost model so margin is visible rather than assumed.
- **Late and out-of-order usage.** Define how usage arriving after a billing period closes is handled (amend, credit on the next invoice, or reject) and implement it deterministically.
- **Auditability.** Every invoice line must be traceable to the metered events that produced it, so a customer query can be answered with evidence.

## Acceptance Criteria

- [ ] Idempotency key defined and enforced; duplicate delivery cannot double-count, verified by test
- [ ] Billable unit defined per endpoint class and WS delivery; documented against `docs/fee-schedule.md`
- [ ] Metering degrades without failing requests; buffering, durability, and at-risk window documented
- [ ] Invoice generation deterministic and versioned; tier, rounding, and proration rules stated
- [ ] Reconciliation against metered usage and request logs, with tolerance and alerting
- [ ] Late/out-of-order usage policy defined and implemented deterministically, with tests
- [ ] Every invoice line traceable to source metered events
- [ ] Reconciliation performed against `config/cost-invoices.json` and the cost model
@@END

@@TARGET: 459
@@TITLE: Cost attribution and chargeback: per-consumer and per-component allocation with reconciled variance
@@LABELS: devops, data, performance, enhancement
@@BODY
## Problem

Infrastructure cost is tracked in aggregate. `scripts/analyze-infrastructure-costs.mjs` and `scripts/capacity-model.mjs` use `config/cost-model.json`, `config/cost-invoices.json` holds expected invoices, and `k8s/cost-optimization/budget.yaml` with its Prometheus rules provide budget alerts. All of it operates on totals or coarse buckets.

Nothing attributes cost to who caused it or which component produced it. That is the difference between reporting a number and acting on one: without attribution there is no basis for pricing a tier, no way to tell whether one consumer's usage pattern is unprofitable, and no way to decide whether the aggregator's per-source API budget (`cost-model.ts`, `oracleApiBudgetUtilization`) is being spent on demand anyone values. Chargeback requires attribution that is defensible enough to be charged against a specific consumer, which is a much higher standard than an informative dashboard.

## Requirements

- **Allocation model.** Define how each cost category is attributed: directly attributable (provider API calls per source, egress per consumer, database storage per partition) versus shared and needing an allocation method (control-plane, observability, load balancers, shared Redis). State the allocation key for each shared category and justify it — arbitrary allocation is worse than no allocation because it manufactures false precision.
- **Per-component attribution.** Attribute cost to system components (aggregator, API, database, message bus, multi-region replication) using the metrics and tags the infrastructure already emits, and reconcile against actual cloud billing.
- **Per-consumer attribution.** Attribute cost to API consumers using the metering work, with a documented method for each cost category and an explicit list of costs that cannot be attributed to a consumer at all.
- **Reconciliation and variance.** Reconcile allocated totals against real billing and report the unattributed remainder explicitly. Define acceptable variance and alert above it; a large unexplained remainder invalidates the allocation model.
- **Dashboards.** Extend the Grafana/Prometheus dashboards under `monitoring/` with cost attribution per component and per consumer, aligned with the existing budget alerting.
- **Decision-usefulness.** For each attribution output, state the decision it informs. Attribution nobody acts on is cost without benefit; be willing to recommend not building the parts that do not change a decision.

## Acceptance Criteria

- [ ] Allocation model documented per cost category, with direct versus shared and the allocation key for shared costs justified
- [ ] Per-component attribution implemented and reconciled against actual billing
- [ ] Per-consumer attribution implemented from metered usage, with non-attributable costs listed explicitly
- [ ] Unattributed remainder reported; variance threshold defined and alerting wired
- [ ] Dashboards extended for per-component and per-consumer cost, consistent with existing budget alerts
- [ ] Each output's decision-usefulness stated; recommendations made on what not to build
- [ ] Alignment with the cost-model reconciliation work so attribution and the model do not diverge
- [ ] Method documented so a figure can be reproduced and defended to a consumer
@@END

@@TARGET: 460
@@TITLE: Budget forecasting with backtested accuracy and a standing optimization cadence
@@LABELS: devops, performance, enhancement
@@BODY
## Problem

Cost is forecast without a method that has ever been checked. `scripts/capacity-model.mjs` projects capacity, `config/cost-model.json` drives `analyze-infrastructure-costs.mjs`, and `k8s/cost-optimization/budget.yaml` carries budget alerts — but no forecast is compared against what was actually spent, so nobody knows whether the numbers are any good. A budget built on an unvalidated projection is a number that produces either false alarms or false comfort, and it cannot support the decisions it exists to support: when to add capacity, what a new feature costs, and whether a consumer tier is viable.

There is also no cadence. Optimization happens as a reaction to an alert or a cost review, not on a schedule, and `docs/COST_OPTIMIZATION.md` records recommendations without owners or deadlines, so they age rather than get actioned.

## Requirements

- **Forecasting method.** Select and document a forecasting approach suited to the actual series (infrastructure cost has trend, seasonality, and step changes from deployments and regional expansion). State the method, the inputs, and the assumptions.
- **Backtesting.** Backtest the forecast against historical actuals and report accuracy per horizon (next month, next quarter) with the metric stated — mean absolute percentage error or comparable — and the error band. A forecast without a measured error band cannot inform a budget. Backtest against the period containing known step changes, since that is where naive methods fail and it is the case that matters.
- **Forecast versus budget.** Define the relationship between the forecast and the budget: is the budget a forecast, or a cap with an explicit margin? Both are legitimate, but conflating them is why budget alerts produce false alarms. Document the choice and reconcile the existing alerts with it.
- **Cadence with owners.** Establish a recurring optimization review with a defined period, required inputs (forecast, actuals, attribution variance, open recommendations), named owners, and a recorded outcome. Recommendations must carry an owner and a due date or be explicitly declined — a list of unowned recommendations is not a process.
- **Change attribution.** Attribute forecast variance to specific causes (new region, traffic growth, a specific consumer, a provider price change) so the forecast improves with each cycle rather than being adjusted by feel.
- **Feed the model's error back into the cost model.** When a forecast misses, the cause should be an update to `config/cost-model.json` and its change log, closing the loop with the reconciliation work.

## Acceptance Criteria

- [ ] Forecasting method documented with inputs and assumptions
- [ ] Backtesting performed against historical actuals, including a period with a known step change
- [ ] Accuracy reported per horizon with a stated metric and error band
- [ ] Relationship between forecast and budget defined; existing budget alerts reconciled with it
- [ ] Recurring review established with period, required inputs, owners, and recorded outcomes
- [ ] Variance attributed to specific named causes each cycle
- [ ] Forecast misses feed back into the cost model and its change log
- [ ] `docs/COST_OPTIMIZATION.md` recommendations carry owners and dates, or are explicitly declined
@@END
