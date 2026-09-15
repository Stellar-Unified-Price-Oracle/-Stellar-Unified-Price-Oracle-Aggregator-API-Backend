@@TITLE: Make TimescaleDB the system of record for history and complete the cutover from JSON files
@@LABELS: data, devops, architecture, enhancement
@@BODY
## Problem

Historical prices live in per-asset JSON files. `services/aggregator/src/persistence/history.ts` defines the read/write path (`HISTORY_FILE(asset)`, `appendHistoricalPrice`, `getHistoricalPrices`), and the API reads the same files through `api/src/price-serving/price-store.ts`. The database layer exists (`api/src/infrastructure/database.ts` with pool, retry, and circuit-breaker machinery, TimescaleDB manifests under `k8s/base/timescaledb/`, and `scripts/migrate-history-to-timescale.ts`) but the JSON files remain the actual source of truth for price history.

That means the system's most important dataset has no query capability beyond "read the whole file and filter in memory": no indexed time-range queries, no aggregates, no joins to usage or audit data, no concurrent-safe writes, and retention expressed as a slice on an in-memory array (`pruneHistory`) rather than a database policy. The API's `/history/:asset` cursor pagination is implemented over a fully-read array, so its cost scales with retained history. Two writers (aggregator append, API read) share a file with no locking, and the write path is a blocking full-file rewrite.

## Why this is hard

The migration is easy to do once and hard to do safely, and the difference is entirely in the transition. Both services must be able to read and write during the cutover — the aggregator writing, the API reading — so a dual-write with reconciliation, or a write-then-read flip with a backfill verification, has to be designed and reversible at any point. The aggregator's write path is a blocking synchronous file append with no transaction semantics, so moving to async database writes changes its failure model: a database outage must not silently drop observations, which means buffering with a defined durability contract, which ties directly into the async-writer work. Timestamp semantics need reconciling too — JSON entries carry Unix seconds and the API's cursor pagination depends on ordering, while TimescaleDB hypertables have their own time partitioning and chunk interval decisions that determine query performance and compression behaviour. And there is a real data-integrity question: history files were written by several code paths over the project's life (including encrypted variants and a documented `maxEntries` pruning that drops the oldest entries), so the backfill must define how gaps and origin are recorded rather than presenting a partial dataset as complete. The existing gap-detection workflow (`history-gap-detection.yml`) will immediately notice any transition artifact, so the cutover must account for it or it will manufacture a wall of alerts.

## Requirements

- Design the hypertable schema: columns, primary/unique key, chunk interval, compression and retention policies, and how the cursor pagination's ordering requirement is served by an index.
- Implement dual-read or dual-write transition with reconciliation, such that either service can be rolled forward or back independently and safely.
- Cut the aggregator's write path over to the database while preserving its no-loss durability contract (coordinate with the async-writer work) and defining behaviour during a database outage.
- Backfill existing JSON history with explicit provenance and gap recording; verify the backfilled dataset matches the source before the flip, with a documented method.
- Define the relationship with the gap-detection workflow during and after the transition so real gaps are still detected and transition artifacts are not reported as data loss.
- Reconcile retention between the database policy, the aggregator's `pruneHistory` (`maxEntries`, `retentionSeconds`), and what the API promises.
- Provide a documented rollback path and prove it works.

## Acceptance Criteria

- [ ] TimescaleDB schema with chunk interval, indexes, compression and retention policies documented and justified
- [ ] Cursor pagination served from the database with an appropriate index; query plan reviewed
- [ ] Dual-write/dual-read transition implemented and reversible at each step
- [ ] Backfill verified against source JSON with a documented verification method and recorded provenance
- [ ] Gap-detection workflow reconciled for the transition; no false gap alerts from cutover artifacts
- [ ] Retention reconciled across database, aggregator config, and API contract
- [ ] Aggregator database outage cannot silently lose observations
- [ ] Rollback executed and documented
@@END

@@TITLE: Automated gap detection with provenance-aware backfill instead of alert-only file issues
@@LABELS: data, devops, enhancement
@@BODY
## Problem

Gaps in price history are detected but not repaired. `.github/workflows/history-gap-detection.yml` runs on a schedule and opens an issue per detected gap — the three currently open issues (#507, #508, #509) are exactly that output. Detection exists; a backfill path does not. Each gap therefore requires a human to notice the issue, find a source for the missing window, and reconstruct it by hand, and the alert carries no information about whether the gap is recoverable at all.

The knowledge needed to backfill does exist in the system. The aggregator appends per-source observations as it polls (`oracle-sources/*`), the API's history files retain windows, `services/aggregator/src/persistence/uptime-history.ts` and the source health history are retained separately, and the upstream providers themselves can be queried historically. None of it is used to repair a gap, and there is no record distinguishing a gap that was backfilled from one that was always missing.

## Why this is hard

Backfilling an oracle's history is a correctness-critical operation, not a data-repair script. Reconstructed observations are not the same as observed ones: a price computed after the fact from a provider's historical API may disagree with what the aggregator would have published live, because the source set, weights, and outlier rules differ at different times. So the honest fix records provenance — observed-live versus reconstructed-and-from-where — rather than writing backfilled values that are indistinguishable from live ones. That has schema implications and affects every consumer that reasons about history, including the API, the anomaly detector's baselines, and any future ML work. Then there is the recovery question: some gaps are unrecoverable because the providers do not serve history that far back, or the upstream data was itself missing, so the system needs to record a permanent gap as a known state rather than re-alerting on it forever. Idempotency and concurrency also matter — multiple instances of the backfill job must not duplicate or conflict — and the detector must be updated in the same change, or the backfill will be followed by a re-detection alert for the very gap it just filled.

## Requirements

- Extend the history model to record provenance per entry (observed live, reconstructed, and the reconstruction source), in a way that does not break existing consumers.
- Implement an automated backfill job that detects gaps, determines recoverability, fetches from available sources, and writes with provenance, idempotently and safely under concurrency.
- For unrecoverable gaps, record an explicit permanent-gap marker so they stop re-alerting while remaining visible in audit.
- Update the gap-detection workflow to account for backfilled and permanently-gapped windows so it does not re-alert on resolved or unrecoverable gaps.
- Validate reconstructed data before writing: reject or flag windows where reconstruction disagrees with surviving adjacent observations beyond a threshold.
- Define and enforce the retention interaction — a backfill must not be silently pruned by `pruneHistory`'s `maxEntries`/`retentionSeconds` behaviour.
- Report backfill outcomes (filled, unrecoverable, rejected) as metrics so the gap situation is measurable over time.

## Acceptance Criteria

- [ ] Provenance recorded per history entry without breaking existing consumers
- [ ] Backfill job automated, idempotent, and concurrency-safe, with tests
- [ ] Unrecoverable gaps recorded permanently and no longer re-alert
- [ ] Gap detection accounts for resolved and permanent gaps; verified by running the workflow against a backfilled gap
- [ ] Reconstruction validated against adjacent observations; disagreement rejected or flagged
- [ ] Backfill not silently pruned; interaction with retention documented and tested
- [ ] Metrics for filled/unrecoverable/rejected outcomes
@@END

@@TITLE: Define read-your-writes and snapshot consistency between parallel price and history reads
@@LABELS: data, api, architecture, enhancement
@@BODY
## Problem

The API serves prices and history from a file-backed store while the aggregator writes to it, with no consistency model stated anywhere. `api/src/price-serving/price-store.ts` reads current prices and history for the v1 handler; the aggregator appends through `appendHistoricalPrice`. Nothing coordinates them, and `api/src/infrastructure/data-consistency.ts` exists, suggesting the concern has been recognised without resolving it.

The observable consequences are ordinary and hard to debug: a client can fetch `/prices` (latest value $X) and immediately fetch `/history/:asset`, and see the history whose most recent entry does not equal $X, because the two reads happened on either side of a write or observed different retention views. A client following cursor pagination can observe a value in a later page that precedes one from an earlier page. `GET /prices` and `GET /prices/:asset` are separate cache keys with independent TTLs, so they can return different values for the same asset within the same second. None of this is documented, so consumers cannot know what guarantee they have, and the pagination metadata does not describe it.

## Why this is hard

This is a distributed-consistency problem where the "distributed" parts are not two replicas of the same database but two services with different storage semantics — the aggregator writing files synchronously and the API reading them with its own multi-layer cache (`LRUCache` L1 plus Redis L2 with different TTLs per endpoint). So a consistency guarantee has to be composed across the cache layers as well as the storage layers: even with perfectly consistent storage, the per-endpoint TTLs mean a client can read a cached price and an uncached history in the same request flow. The design work is choosing which guarantee is actually achievable and worth its cost — monotonic reads, read-your-writes per client, or a documented bounded-staleness window — and each implies something different: a snapshot token, versioning the price records, aligning cache TTLs per asset, or accepting eventual consistency and exposing the lag explicitly. It also has to be expressible in the API contract, which means the response needs to carry whatever the client needs to reason about it, and that is a payload change for a surface that includes a frozen v1 version.

## Requirements

- Choose and document the consistency guarantee(s) the API provides, with the reasoning and the bounded staleness window if eventual consistency is chosen.
- Make whatever the client needs to reason about consistency available in responses — a snapshot/version token, an explicit data-as-of marker, or equivalent.
- Reconcile the cache layers with the chosen guarantee: per-endpoint TTLs currently allow a price and its history to disagree, so decide and implement how that is prevented or exposed.
- Ensure a client's sequential reads cannot observe time going backwards within a pagination walk; verify with a test that writes between page requests.
- State the guarantee for both REST and WebSocket consumers, since a WS subscriber and a REST reader can disagree.
- Document in `api/docs/API.md` and the OpenAPI spec, and reconcile with `api/src/infrastructure/data-consistency.ts` — either implement it as the enforcement point or remove it and say why.

## Acceptance Criteria

- [ ] Guarantee documented with reasoning and any bounded staleness window stated
- [ ] Responses carry sufficient information for a client to reason about consistency
- [ ] Cache layers reconciled; price and history cannot silently disagree, or the disagreement is explicit in the payload
- [ ] Pagination walk cannot observe out-of-order values, verified by a test writing between page requests
- [ ] REST and WebSocket guarantees stated and consistent
- [ ] `api/docs/API.md` and OpenAPI updated; `data-consistency.ts` reconciled or removed with justification
@@END

@@TITLE: Single enforceable retention policy across aggregator config, database, and API contract
@@LABELS: data, devops, enhancement
@@BODY
## Problem

Retention is defined independently in at least three places that are never reconciled. The aggregator prunes by `config.history.maxEntries` and `config.history.retentionSeconds` in `pruneHistory` (`services/aggregator/src/persistence/history.ts`), pruning is applied **only on append** — so an asset that stops being polled is never pruned at all, and its file retains whatever it had. The API promises history over a cursor window with no stated retention bound, so a client can legitimately request a range and receive whatever happens to survive. Documentation describes retention policy separately (`docs/audit-log-retention.md`, the data-retention closed issues). The database layer has no retention policy applied at all for price history.

So "how much history do we keep" has no single answer. It also has no test: nothing verifies that the configured retention is what is actually retained, that a documented window is honoured, or that pruning cannot silently drop data a consumer relies on. And because the aggregator prunes on append, retention behaviour is coupled to poll activity — an asset dropped from `WATCHED_ASSETS` retains history indefinitely while an actively polled asset is trimmed aggressively.

## Why this is hard

The difficulty is that retention is simultaneously a cost decision, a product promise, and a correctness input, and those pull in different directions. Cost pushes for aggressive pruning; the API's history contract and the gap-detection workflow push against it, because pruning creates gaps that look identical to outages; and downstream analysis — the anomaly detector's baselines, any ML work, and the audit requirements — needs long retention precisely where cost is highest. A defensible policy therefore has to be per-data-class rather than global (raw observations, aggregates, audit-relevant records and derived features have different lifetimes), and it must be enforced somewhere that cannot be bypassed. Enforcement also interacts with the storage migration: retention on a TimescaleDB hypertable should be a database policy with compression, which is a different mechanism from an in-memory array slice, and the two must not both run. Pruning-as-a-side-effect-of-append is the specific design flaw to eliminate, which requires a retention job that runs on a schedule and covers assets regardless of poll activity.

## Requirements

- Define retention per data class (raw observations, aggregates, audit-relevant records, derived features) with the reasoning for each period, and make it configurable in one place.
- Replace prune-on-append with schedule-driven retention enforcement that covers all assets, including ones no longer being polled.
- Ensure the API's history contract states the actual retention window, and that a request for data outside it is answered explicitly (documented response) rather than with a silently short result.
- Reconcile retention with the gap-detection workflow so pruning is distinguishable from data loss.
- Ensure retention and compression are enforced at the database layer where applicable, and that no second, conflicting retention mechanism remains.
- Add verification tests asserting that configured retention matches observed retention.
- Record the cost implication of the chosen periods against the existing cost model (`config/cost-model.json`).

## Acceptance Criteria

- [ ] Retention defined per data class with reasoning, configured in one place
- [ ] Schedule-driven enforcement replaces prune-on-append; unpolled assets pruned correctly, with a test
- [ ] API history contract states the retention window; out-of-window requests answered explicitly
- [ ] Gap detection distinguishes pruning from data loss
- [ ] Retention/compression enforced at the database layer; no conflicting second mechanism
- [ ] Verification tests assert configured versus observed retention
- [ ] Cost implication documented against the cost model
@@END

@@TITLE: History encryption at rest — key rotation, versioned ciphertext, and mixed-version reads
@@LABELS: data, security, devops, enhancement
@@BODY
## Problem

History can be encrypted at rest, and the implementation has no rotation story. `services/aggregator/src/infrastructure/crypto.ts` provides `encrypt`, `decrypt`, and `isEncrypted`, and `history.ts` conditionally applies them (`historyEncryptionEnabled()` requires both `config.security.encryption.encryptHistory` and `isEncryptionConfigured()`).

Three concrete gaps. First, `isEncrypted(raw)` is the only discriminator — a single marker with no key identifier or version, so ciphertext is only decryptable by whichever key is currently configured, and changing the key makes every existing file unreadable. Second, the setting is a boolean: encryption is either on for everything or off, and toggling it changes the on-disk format for files written before versus after, with `readHistoryFile` handling both by sniffing the marker rather than by knowing. Third, `appendHistoricalPrice` swallows read failures (`catch { /* ignore corrupt data */ }`), so a key mismatch or a corrupt payload presents as an empty history rather than as an error, which is the worst possible failure mode: encrypted history appears to simply not exist.

There is no key-rotation procedure, no re-encryption path, and no test covering a key change — which matters because `scripts/rotate-secrets.sh` and `.github/workflows/secret-rotation-drill.yml` establish that rotation is an expected operational activity in this project.

## Why this is hard

Key rotation with data at rest requires a ciphertext format that carries its own key identifier and algorithm version, which is a format change affecting every reader and every existing file. Then the operational sequencing has to be designed: write-new-read-both, re-encrypt in the background, then retire the old key — and each stage must be safe to interrupt and resume, because re-encrypting a large history is not atomic and the process will be deployed mid-flight. That interacts with the blocking full-file rewrite already in the write path: re-encrypting in place is unsafe (a crash mid-write destroys the file), so it needs the atomic-write treatment, and doing it while the aggregator appends needs coordination or the rewrite loses concurrent appends. Failure modes also have to be decided rather than defaulted: if a key is unavailable, reading must fail loudly with a distinguishable error rather than silently returning empty history as it does now, and writes must not proceed with an unencrypted fallback that defeats the purpose. Finally, the encrypted history is consumed by the API as a separate service, so the format and the key access path must be shared deliberately rather than implying two independent copies of the key configuration.

## Requirements

- Version the ciphertext format so each payload carries a key identifier and algorithm version, making mixed-version reads possible.
- Define and implement a rotation procedure: write under the new key while reading both, re-encrypt existing data incrementally and resumably, then retire the old key. Document the sequence and its interrupt-resume behaviour.
- Make decryption failure explicit and distinguishable — no silent empty history. Distinguish wrong-key, corrupt payload, and truncated write.
- Make re-encryption crash-safe using atomic writes, and coordinate with concurrent appends so no observation is lost during re-encryption.
- Define behaviour when the required key is unavailable for reads and for writes; no silent unencrypted fallback.
- Align the key access and format between the aggregator and the API so both services read the same ciphertext deliberately, and document the shared configuration contract.
- Add tests covering key change with mixed-version files, an interrupted re-encryption resumed, and an unavailable key.

## Acceptance Criteria

- [ ] Ciphertext carries key id and algorithm version; mixed-version reads work
- [ ] Rotation procedure implemented and documented, including interruption/resume
- [ ] Re-encryption crash-safe and coordinates with concurrent appends; no observation loss
- [ ] Decryption failures explicit and distinguishable; no silent empty history
- [ ] Unavailable-key behaviour defined for reads and writes; no unencrypted fallback
- [ ] Aggregator and API share one documented key/format contract
- [ ] Tests: key change, interrupted re-encryption resumed, missing key, corrupt payload
- [ ] `secret-rotation-drill.yml` exercises the data-encryption rotation path, not only credentials
@@END

@@TITLE: Persist anomaly detection verdicts and make them auditable after the fact
@@LABELS: data, aggregator, enhancement
@@BODY
## Problem

Anomaly detection produces a value and discards everything that would make it auditable. `services/aggregator/src/price-aggregation/anomaly-detector.ts` returns a score that `PriceAggregator.getLatestForAsset` attaches to the aggregate (`anomaly` field), which flows into the API response and the WebSocket broadcast. Nothing is persisted. The detection's inputs — the baseline it compared against, the thresholds in force, the window used — are gone the moment the value is returned.

That makes the feature unverifiable and unusable for its two obvious purposes. Operationally, "was there an anomaly at 03:14 and what did it look like" cannot be answered after the fact; an on-call engineer can only see live values. Analytically, the false-positive rate — a stated acceptance criterion of the original anomaly-detection work — cannot be measured, because a positive is not recorded anywhere and its subsequent correctness cannot be evaluated against what actually happened. Tuning thresholds is guesswork, and there is no evidence trail connecting a threshold change to an outcome.

## Why this is hard

Persisting verdicts sounds like adding a table and is really a question of what a verdict *is*. To be auditable later, a record must capture the detection's inputs and enough of the surrounding context to reproduce the decision: the aggregate value, the baseline and how it was derived, the thresholds and configuration version in force, which sources contributed, and the resultant verdict. That is a schema with a lot of surface, and it must be re-evaluable — a threshold change should allow historical decisions to be re-scored, which requires the inputs be stored rather than the conclusion alone. Volume is a practical constraint: detection runs on every round for every asset, so at a 30-second cadence the write rate is the same order as the price stream, and retaining full verdict detail forever is expensive, which forces a decision about which verdicts are stored in full versus summarised. Then the correctness feedback loop has to be defined, and that is the genuinely difficult part: "was this anomaly a true positive?" requires a notion of ground truth for a price movement, which the system does not have — it must be constructed (e.g. was the deviation sustained and confirmed by the aggregate afterwards?) and defended, because a bad ground-truth definition produces a confident false-positive-rate metric that means nothing.

## Requirements

- Define a verdict record capturing the detection inputs (aggregate value, baseline and derivation, thresholds, configuration version, contributing sources) plus the verdict and timestamp, so decisions are reproducible.
- Persist verdicts, at a rate and retention that are costed and documented, with a summarisation policy for high-volume cases.
- Define a ground-truth definition for "was this a true positive" and implement the feedback evaluation; document the definition and its limitations explicitly.
- Compute and expose the false-positive rate from persisted data, replacing the current unmeasurable state.
- Support re-evaluating historical verdicts under changed thresholds, using the stored inputs.
- Expose an audit query path (API or documented query) so an on-call engineer can retrieve the verdict history for an asset and time range.
- Add retention for verdict data consistent with the retention policy for the other data classes.

## Acceptance Criteria

- [ ] Verdict record captures all detection inputs and configuration version; decisions are reproducible from stored data
- [ ] Verdicts persisted with documented write rate and retention; summarisation policy for high volume
- [ ] Ground-truth definition for true/false positive documented with stated limitations
- [ ] False-positive rate computed and exposed
- [ ] Historical verdicts re-evaluable under changed thresholds, verified by a test
- [ ] Audit query path available and documented
- [ ] Verdict retention consistent with the project retention policy
@@END

@@TITLE: Automated multi-region failover verification with SLO-based pass/fail
@@LABELS: devops, enhancement
@@BODY
## Problem

Multi-region failover is configured but never automatically verified. The configuration exists — `k8s/base/multi-region/failover-policy.yaml`, `geo-config.yaml`, `global-load-balancer.yaml`, and per-region overlays `prod-us-east-1`, `prod-eu-west-1`, `prod-ap-southeast-1` — and drills exist as workflows (`dr-drill.yml`, `disaster-recovery-drill.yml`, `rollback-drill.yml`) plus scripts (`scripts/dr/run-drill.sh`, `scripts/dr-drill.sh`). What is missing is an automated assertion that failover actually works and meets a target: the drills run, but nothing fails the pipeline when recovery exceeds an SLO, when failover is partial, or when it did not happen at all.

The gap is not theoretical. Failover depends on several independently-configured pieces agreeing — the geo-config's region preference, the global load balancer's health checks, the per-region overlays' replica counts and resource requests, and the replication path (Kafka, `kafka-replicator.ts`, `region-price-replicator.ts`, `region-quarantine.ts`, `price-crdt.ts`, and the Terraform `mirror-maker` and `replication` modules). Nothing verifies that these compose into an actual working failover, so a misconfiguration that leaves traffic pinned to one region, or that fails over but serves stale or divergent prices, is discovered during an incident rather than in CI.

## Why this is hard

Verifying failover requires a test that actually causes regional failure and measures the outcome, which is materially different from running a drill and reading logs. The measurement must be independent of the system under test — if the verification asks the failing region whether it failed over, the answer is worthless — so it needs an external vantage point with its own probe path, which means the verification itself has infrastructure requirements and real cost. Then the assertions must be defined against the SLOs the project already declares (`monitoring/slo.yml`, `docs/service-sla.md`): what recovery time is acceptable, what price divergence between regions is tolerable, and what data-loss bound applies. Those are product decisions that must be written down before the test can have a threshold. The trickiest part is the regional divergence assertion, because the system replicates prices across regions with a CRDT and a quarantine mechanism, so "correct failover" includes a convergence requirement, not just availability — and a naive test will either accept divergence or flap on normal replication lag.

## Requirements

- Design a failover test that induces regional failure and measures availability, recovery time, and cross-region price divergence from a vantage point independent of the failed region.
- Define the pass/fail thresholds against `monitoring/slo.yml` and `docs/service-sla.md`; document each threshold and its source.
- Assert convergence: after failover, regions must agree on prices within a stated bound, using the replication path's actual semantics rather than assuming instant consistency.
- Verify data integrity across the failover, including that no observations are lost and that the quarantine mechanism behaves as documented.
- Wire the verification into CI/scheduled automation with a clear verdict, and ensure it cannot pass by accident (e.g. failing to induce the fault must be a failure, not a skip).
- Cover partial failover (one dependency fails over, another does not) as a distinct, asserted case.
- Document how the verification is run manually for post-incident validation.

## Acceptance Criteria

- [ ] Failover test induces real regional failure and measures from an independent vantage point
- [ ] Thresholds for recovery time, availability, and divergence documented with their SLO source
- [ ] Cross-region convergence asserted within a stated bound consistent with CRDT semantics
- [ ] Data-integrity assertions across failover, including quarantine behaviour
- [ ] Wired into automation with a hard verdict; failure to induce the fault fails the run
- [ ] Partial-failover case tested separately
- [ ] Manual procedure documented for post-incident use
@@END

@@TITLE: Terraform drift detection gated in CI with plan review and state-lock safety
@@LABELS: devops, enhancement
@@BODY
## Problem

Terraform is applied through `.github/workflows/terraform.yml`, and the infrastructure is substantial: modules for `api`, `aggregator`, `database`, `message-bus`, `mirror-maker`, `replication`, and `egress-allowlist`, with three region environments. Nothing detects drift. There is no scheduled `plan` compared against expectations, and no gate that fails when live infrastructure differs from the committed configuration.

The consequence is that the committed Terraform stops describing reality. Manual console changes, emergency fixes during an incident, and resources created out-of-band persist invisibly until the next `apply` proposes to destroy them — at which point the diff is large, arrives at the worst time, and cannot be reviewed meaningfully. Because three region environments deploy the same modules, drift in one region is also invisible as a cross-region inconsistency: two regions can silently differ in a way no single `plan` makes obvious.

## Why this is hard

Making drift detection useful rather than noisy is the whole problem. Every legitimate apply produces a plan, so the gate needs to distinguish meaningful drift from expected churn, and provider-level noise (timestamps, generated names, default fields the provider rewrites on read) creates a steady stream of false positives that gets a naive gate disabled within a week. Achieving a clean baseline therefore requires reconciling `lifecycle` behaviour and imports first, which is its own work. State locking is the second constraint: a scheduled `plan` running concurrently with a deploy holds or contends for the state lock, and a drift check that blocks production deploys is worse than no check. Third, a drift *detection* gate still leaves the response undefined — someone must triage, and the workflow needs to distinguish "drift to fix" from "drift to codify" (where the manual change was correct and the config should adopt it) which are opposite remedies for the same signal. Finally, cross-region equivalence is a separate assertion from per-environment drift, and needs its own comparison rather than three independent plans.

## Requirements

- Add a scheduled and pre-apply drift detection job that produces a plan and compares it against an expected baseline, failing on unexpected differences.
- Establish a clean baseline by reconciling provider noise and importing out-of-band resources so the gate starts meaningful rather than permanently red.
- Make the job state-lock safe: it must not contend with or block deploy workflows, including on failure and cancellation.
- Define the triage process and encode the distinction between drift-to-remediate and drift-to-codify in the workflow output.
- Add a cross-region equivalence check asserting the region environments do not silently diverge.
- Ensure drift results are visible to the right people with enough detail in the CI output to act without re-running locally.
- Document the procedure for acknowledging accepted drift so the gate does not require permanent suppression.

## Acceptance Criteria

- [ ] Scheduled and pre-apply drift detection with a failure on unexpected differences
- [ ] Baseline clean: provider noise reconciled, out-of-band resources imported, gate meaningful
- [ ] State-lock safe, verified by running concurrently with a deploy
- [ ] Triage process documented; workflow distinguishes remediate from codify
- [ ] Cross-region equivalence assertion implemented for the three region environments
- [ ] CI output actionable without local reproduction
- [ ] Documented mechanism for accepting intentional drift
@@END

@@TITLE: Prove rollback works across a schema migration boundary, not just across code versions
@@LABELS: devops, data, docker, enhancement
@@BODY
## Problem

Rollback is implemented and drilled (`scripts/rollback.sh`, `.github/workflows/rollback.yml`, `rollback-drill.yml`, `scripts/deploy-blue-green.sh`, `k8s/blue-green/`) but the drills roll back code, not data. The migrations machinery is separate and substantial: `services/aggregator/src/migrations/schema-migrations.ts`, `api/docs/MIGRATIONS.md`, `docs/SCHEMA_MIGRATIONS.md`, and `scripts/migrate-history-to-timescale.ts`. Nothing verifies that rolling back an application version works when the database schema has already moved forward.

That is the case where rollback actually fails. A deploy migrates the schema, the new version starts serving, a defect is found, and rollback returns to an application version that predates the migration — which may not understand the new schema, may write rows the new version's constraints reject, or may read columns whose meaning changed. The current drills cannot detect this because they do not cross a migration boundary, so the project's confidence in rollback rests on tests that do not exercise the failure mode that matters most.

## Why this is hard

Forward-only vs backward-compatible migration is an architectural stance that has to be adopted deliberately, and adopting it constrains how migrations may be written from then on — expand/contract (add nullable, backfill, dual-write, switch reads, drop) rather than in-place alteration. Retrofitting that stance means auditing existing migrations to find the ones that are not backward compatible, and deciding whether to bring them into compliance or declare a minimum rollback boundary. The verification itself requires a scripted sequence that deploys version N, migrates, deploys N+1, then rolls back to N while the migrated schema and data are present, and asserts that N reads and writes correctly — which needs a realistic dataset at the migration boundary (empty databases hide these failures) and a rollback assertion that covers not just "the process started" but "it can read and write the migrated schema" and "no data was lost or corrupted". Coordinating that with blue-green (`scripts/deploy-blue-green.sh`) adds the constraint that both versions run simultaneously during the transition, so backward compatibility is not merely needed for the rollback instant but for the whole rollout window — a stronger requirement, and one that should shape the assertion.

## Requirements

- Audit existing migrations and classify each as backward compatible or not; decide and document a policy (expand/contract going forward, with a stated treatment for existing non-compliant migrations).
- Extend the rollback drill to cross a migration boundary: deploy N, migrate, deploy N+1, exercise it, roll back to N, then assert N can read and write the migrated schema with no data loss.
- Run the drill against a realistic dataset at the migration boundary, not an empty database.
- Assert compatibility during the blue-green overlap window, where both versions run concurrently against the same schema, not only after rollback.
- Define a minimum rollback boundary for cases that cannot be made compatible, and enforce it, so rollback is never attempted across an unsupported boundary.
- Ensure the drill fails when compatibility is broken, verified by deliberately introducing an incompatible migration.
- Document the policy, boundary, and procedure in `docs/SCHEMA_MIGRATIONS.md` and `api/docs/MIGRATIONS.md`.

## Acceptance Criteria

- [ ] All existing migrations classified; policy documented with treatment for non-compliant ones
- [ ] Rollback drill crosses a migration boundary and asserts read **and** write correctness on the older version
- [ ] Drill uses a realistic dataset at the boundary, not an empty schema
- [ ] Blue-green overlap-window compatibility asserted, not just post-rollback
- [ ] Minimum rollback boundary defined and enforced
- [ ] Drill fails on a deliberately incompatible migration (negative test)
- [ ] Documentation updated in both migration docs
@@END

@@TITLE: Add steady-state hypotheses and automated verdicts to chaos experiments
@@LABELS: devops, tests, enhancement
@@BODY
## Problem

Chaos engineering is set up — `k8s/chaos/` with `experiments/`, `schedules/`, `reporting/`, an install path (`scripts/chaos/install-chaos-mesh.sh`), and a workflow (`chaos-engineering.yml`), plus `scripts/chaos/generate-report.sh`. What is missing is the defining element of a chaos experiment: a steady-state hypothesis with an automated verdict.

Without a hypothesis there is nothing to falsify, so the experiments degrade into "inject a fault and see what happens". The report generator summarises what occurred, but no run can pass or fail; nothing asserts that the system's defining properties held during the fault. An experiment that reveals a serious regression therefore produces a report indistinguishable from a healthy run, and the signals that would have caught a problem — error rate, price freshness, cross-region consistency, recovery time — are not evaluated as expectations anywhere. Scheduled runs also accumulate without a pass/fail history, so drift in resilience over time is invisible.

## Why this is hard

Writing steady-state hypotheses requires first stating the invariants the system guarantees, which are currently scattered across documentation rather than expressed as testable assertions: the availability and latency targets in `monitoring/slo.yml` and `docs/service-sla.md`, the freshness guarantees implied by the staleness configuration, the data-integrity expectations implied by `scripts/validate-price-correctness.mjs` and `verification/`, and the consistency expectations the CRDT design implies. Converting those into assertions that are meaningful *during* an induced fault is subtle, because normal operation already produces some failure and latency variation — a hypothesis with tight thresholds fails constantly, and a loose one proves nothing. Each experiment also needs a baseline captured before the fault and a recovery assertion after it, so the verdict has to distinguish "degraded as expected and recovered" from "degraded and did not recover" and "never degraded at all", the last of which usually means the fault was not actually injected and should be treated as a failed experiment rather than a pass. Finally, the assertions need to run against the system from outside the chaos mesh, or they inherit the failure they are trying to measure.

## Requirements

- State the system's steady-state invariants as explicit, testable assertions, sourced from `monitoring/slo.yml`, `docs/service-sla.md`, the freshness guarantees, and the price-correctness verification. Document each with its source.
- Add per-experiment steady-state hypotheses with pre-fault baseline capture, in-fault assertion, and post-fault recovery assertion.
- Make each run produce an automated verdict with a non-zero exit on violation, wired into `chaos-engineering.yml`.
- Treat "the fault was not actually injected" as a failed experiment, not a pass, so an experiment cannot succeed vacuously.
- Collect assertions from a vantage point outside the fault domain.
- Make the verdicts meaningful at realistic thresholds: calibrate so normal operational variation does not fail them, and document how thresholds were derived.
- Retain a pass/fail history per experiment so regressions in resilience over time are visible.
- Ensure every experiment in `k8s/chaos/experiments/` has a hypothesis, or is explicitly marked exploratory.

## Acceptance Criteria

- [ ] Steady-state invariants documented with their source in the SLOs and other guarantees
- [ ] Each experiment has a hypothesis with baseline, in-fault, and recovery assertions
- [ ] Automated verdict per run; CI fails on violation
- [ ] Non-injection (vacuous run) treated as failure
- [ ] Assertions collected from outside the fault domain
- [ ] Thresholds calibrated and their derivation documented
- [ ] Pass/fail history retained per experiment
- [ ] All existing experiments covered or explicitly marked exploratory
@@END

@@TITLE: Negative tests proving egress controls actually enforce, not just exist
@@LABELS: devops, security, tests, enhancement
@@BODY
## Problem

Egress is restricted by several independent mechanisms: `k8s/base/networkpolicy-fqdn.yaml` and `networkpolicy.yaml`, the Terraform `egress-allowlist` module, and `.github/workflows/egress-allowlist.yml`, alongside `scripts/resolve-oracle-ips.sh` which presumably resolves provider IPs for the allowlist. The allowlist is also reflected in the deployment's own SSRF defence (`services/aggregator/src/infrastructure/ssrf.ts`).

Nothing proves that a *disallowed* destination is actually blocked. The controls are validated as configuration — the workflow checks the allowlist is well-formed, manifests pass `scripts/validate-k8s.sh` and `scripts/validate-k8s-yaml.py` — but no test attempts a connection that should fail and asserts that it does. A default-allow rule, a NetworkPolicy that Kubernetes accepts but the CNI does not enforce, an allowlist entry that is broader than intended (a wildcard, or a CIDR covering far more than the provider), or a drift between the FQDN allowlist and the resolved IPs would all pass every existing check while leaving egress effectively open. For a system whose threat model includes a compromised oracle source or a supply-chain foothold, that is the control that matters most.

## Why this is hard

NetworkPolicies are only as real as the CNI that implements them, and enforcement is environment-specific: a policy set that is enforced under one CNI is silently ignored under another, and FQDN-based policies are not a Kubernetes-native concept at all but an implementation of a specific CNI (Cilium-style), so the manifest's meaning depends on the dataplane. A meaningful test therefore has to run against a real cluster with the real CNI, not validate YAML, which makes it an integration test with infrastructure requirements and cost. Then the assertions need to be positive *and* negative — proving a disallowed host is blocked is a test that must distinguish "blocked by policy" from "unreachable for an unrelated reason", which requires asserting the failure mode specifically (a policy denial, not a timeout or DNS failure) or the test is satisfied by any network problem including the cluster being misconfigured. Coverage is the other hard part: the control has several layers (NetworkPolicy, cloud security group, application SSRF guard, DNS resolution) and the test must exercise each independently, because a test that passes because the cloud layer blocks traffic while the NetworkPolicy is missing gives false confidence in a control that does not work. Finally, allowlist breadth needs an assertion of its own — the useful test is not only that allowed hosts work and disallowed hosts fail, but that the allowlist contains no entry broader than the documented provider set.

## Requirements

- Add negative integration tests that attempt egress to disallowed destinations and assert a policy-specific denial, distinguishing denial from generic network failure.
- Exercise each layer independently: Kubernetes NetworkPolicy/FQDN policy, cloud-level egress, the application SSRF guard, and DNS resolution, so one layer passing does not mask another being absent.
- Verify the CNI actually enforces the policies present, and fail explicitly if the dataplane ignores them.
- Assert allowlisted destinations remain reachable, so tightening cannot silently break oracle access (and cover this per provider, since `resolve-oracle-ips.sh` suggests IP-derived entries that can go stale).
- Assert allowlist breadth: no entry broader than the documented provider set, with the check failing on additions rather than requiring manual review.
- Detect drift between FQDN allowlist entries and resolved provider IPs, which the existing resolve script implies is a real concern.
- Run the tests in an environment representative of production, and document what the test does not cover.

## Acceptance Criteria

- [ ] Negative tests assert policy-specific denial, not generic unreachability
- [ ] Each enforcement layer tested independently
- [ ] Test fails if the CNI does not enforce a present policy
- [ ] Allowed destinations verified reachable per provider
- [ ] Allowlist breadth assertion fails on over-broad additions
- [ ] FQDN-to-IP drift detected
- [ ] Environment requirements and coverage gaps documented
@@END

@@TITLE: Secret rotation must verify zero-downtime dual-key operation and rollback
@@LABELS: devops, security, enhancement
@@BODY
## Problem

Secret rotation is scripted and drilled — `scripts/rotate-secrets.sh`, `.github/workflows/secret-rotation-drill.yml` — and the project documents key custody and multi-sig administration (`docs/KEY_MANAGEMENT.md`, `docs/MULTISIG_ADMINISTRATION.md`). The drill exercises the mechanics of rotation; it does not verify the properties that make rotation safe in production.

Specifically, it does not verify that rotation is zero-downtime, or that a rollback works if the newly rotated credential is wrong. Safe rotation requires a dual-key overlap: the new credential is accepted while the old is still valid, traffic moves over, and only then is the old revoked. Nothing asserts that overlap exists or is respected by every consumer. If it does not, rotation is a coordinated restart — and if the new credential is then found to be invalid, or a consumer caches the old one past its revocation, the result is an outage during a security-response procedure, which is precisely when it is least acceptable. There is also no assertion that revocation actually takes effect: after the old credential is retired, it must stop working, or the rotation has not achieved anything and the exposure the rotation was performed to close remains open.

## Why this is hard

Verifying zero-downtime rotation requires observing the transition while it happens and asserting on availability throughout, which is a different kind of test from "run the rotation script and check the exit code". Each credential type has its own overlap semantics — a symmetric key that must be present on both sides simultaneously, an asymmetric key where the public key must be published before the private one is used, an API key with a provider where only one may be active at a time (meaning true zero-downtime may be impossible and the honest answer is a documented, measured outage window rather than a claim) — so the verification has to be per-type and cannot be uniform. The distributed-consistency part is real: consumers hold credentials in different places (Kubernetes secrets mounted into pods, environment variables, cached clients that read the credential once at startup and never re-read), so overlap only helps for consumers that can re-read, and the rest must be restarted — which means the drill must enumerate consumers and their re-read behaviour, and the result may be that some need a rolling restart. Then revocation verification needs to be genuinely probed: presenting the retired credential and asserting rejection, against each service independently, because one service honouring revocation proves nothing about the others. And the whole sequence must be reversible: if the new key is invalid, the drill must prove the system returns to a working state on the old key.

## Requirements

- Classify each rotated credential type and document its overlap semantics, including any type for which zero-downtime is impossible and the resulting measured outage window.
- Extend the drill to assert availability throughout rotation, not just script success.
- Verify the dual-key overlap window: old and new accepted simultaneously in every consumer that supports it, for the duration claimed.
- Enumerate every consumer of each secret and its re-read behaviour; identify which require a rolling restart and build that into the documented procedure.
- Probe revocation: after the old credential is retired, assert rejection independently for each service.
- Verify rollback: invalidate the new credential and assert the system recovers on the old one.
- Produce a per-credential-type verdict in the drill, and fail on any unmet assertion.

## Acceptance Criteria

- [ ] Credential types classified with overlap semantics documented, including impossible-zero-downtime cases and measured windows
- [ ] Availability asserted throughout rotation; failure on any downtime during an overlap-supported type
- [ ] Dual-key overlap verified per consumer for the claimed duration
- [ ] Consumer inventory with re-read behaviour; rolling-restart procedure documented
- [ ] Revocation probed independently per service and asserted
- [ ] Rollback verified by invalidating the new credential and asserting recovery
- [ ] Drill emits a per-type verdict and fails on unmet assertions
@@END

@@TITLE: Gate releases on SLO error-budget burn rate
@@LABELS: devops, performance, enhancement
@@BODY
## Problem

SLOs and error budgets are defined — `monitoring/slo.yml`, `docs/GOLDEN_SIGNALS.md`, `docs/MONITORING_AND_ALERTING.md`, `scripts/generate-slo-report.ts`, `scripts/measure-alert-signal-noise.mjs`, and the on-call dashboards under `monitoring/`. They are not connected to releases. `deploy.yml`, `blue-green-deploy.yml`, `rollback.yml`, and `deploy-canary.js` gate on tests and canary health, but nothing consults the error budget.

So the budget is reporting rather than control. A service that has spent most of its budget on incidents this week can still receive a full-traffic release, and the fastest way to compound an outage is to change the system while it is already burning budget. Conversely, a release that is clearly safe cannot be expedited on the basis of available budget. The project has all the measurement apparatus and none of the enforcement, which is the part that changes behaviour.

## Why this is hard

Connecting budgets to releases requires deciding what "budget exhausted" means as a gate, and every option has a cost. A hard freeze on any budget depletion is correct in spirit and paralytic in practice, since normal variance depletes budgets routinely, so the gate needs burn-rate thresholds (fast-burn versus slow-burn over different windows) and an explicit override path — and an override path that is used routinely is not a gate. It also needs to distinguish budget consumed by this release's own canary from budget consumed by unrelated incidents, because otherwise the canary poisons its own gate. That requires reliable attribution of burn to causes, which the current metrics may not support. Then there is the question of what the gate *does*: block deployment entirely, allow it with reduced traffic and no automatic promotion, or require remediation first — each implying different automation in `deploy-canary.js` and the blue-green flow. Finally the gate must not become a single point of failure: if the metrics backend is unavailable, the release pipeline must have a defined behaviour that is neither "always block" (a metrics outage halts all delivery) nor "always allow" (the gate is bypassed exactly when observability is degraded).

## Requirements

- Define burn-rate thresholds and windows (fast-burn and slow-burn) as the gate condition, with the reasoning, rather than a raw budget-depletion check.
- Attribute budget consumption by cause so a release's own canary does not block the release that produced it. Document how attribution is determined and its limitations.
- Define the gate's action per severity: block, permit with reduced traffic and no auto-promotion, or require remediation. Implement it in the deployment automation.
- Add a documented override with the required justification and an audit record, and make overrides visible so routine use is detectable.
- Define behaviour when SLO metrics are unavailable, decided deliberately rather than falling through to allow or block by accident.
- Verify the gate itself with a test: a deliberately budget-exhausted state blocks a release, and a healthy state permits it.
- Report the budget state and the gate decision in the deployment workflow output so the reason is visible when a release is blocked.

## Acceptance Criteria

- [ ] Burn-rate thresholds and windows defined and documented
- [ ] Budget attributed by cause; canary's own consumption does not block its release
- [ ] Gate action defined per severity and implemented in the deploy automation
- [ ] Override path documented, justified, audited, and visible
- [ ] Metrics-unavailable behaviour defined
- [ ] Gate tested in both directions (exhausted blocks, healthy permits)
- [ ] Budget state and decision surfaced in workflow output
@@END

@@TITLE: Bound Prometheus cardinality for asset and source labels with an enforced budget
@@LABELS: devops, performance, enhancement
@@BODY
## Problem

Metrics are emitted with per-asset and per-source labels throughout the aggregator and API — `oracleSourceLatency` carries `{ source, asset }`, `oracleSourceRequestsTotal` carries `{ source, status }`, `oracleApiCallsTotal` and `oracleApiCostTotal` carry `source`, `oracleApiBudgetUtilization` carries `source`, `priceQueriesTotal` and `lastPriceTimestamp` carry `asset`, plus `oracleSourceSlaBreaches`.

The `WATCHED_ASSETS` list is configuration and the authorized source set is on-chain admin state, so the number of label values is operator-controlled and unbounded from the code's perspective. Cardinality multiplies: `{ source, asset }` on a latency histogram is sources × assets × buckets, and histograms multiply again. `k8s/base/prometheus-cardinality-rules.yaml` exists, so the risk is known, but nothing in the emission path enforces a bound and no test asserts one. The failure mode is severe and self-inflicted: high cardinality degrades Prometheus itself, which is the system used to detect that things are broken — so the monitoring outage coincides with the incident.

## Why this is hard

Every available mitigation trades observability for cardinality, and the trade-offs differ per metric. Dropping labels loses exactly the per-asset and per-source attribution that makes these metrics useful during an incident, which is why they were added. Relabelling at the Prometheus layer is centralised and cheap for the emitter but pushes the decision to configuration that must stay in sync with the application. Aggregating into bounded buckets loses precision where precision matters (a single misbehaving asset is invisible in a bucket total). A cardinality budget is therefore needed, and it has to be per-metric with a stated headroom — which requires knowing the current cardinality, its growth drivers, and which labels are genuinely load-bearing versus merely convenient. That means auditing each metric against how it is actually used in the dashboards and alerts under `monitoring/`, since a label that appears in no query is pure cost. Then enforcement has to be chosen: a hard cap that drops series (losing data silently), an admission check at startup (failing fast on a misconfiguration), a periodic cardinality report with alerting, or relabeling. Each has different failure characteristics, and the honest answer is probably a combination that must be designed rather than picked.

## Requirements

- Audit every metric's labels against actual use in `monitoring/` dashboards and alert rules; identify labels that appear in no query and document them as removable or retain with justification.
- Establish a cardinality budget per metric with documented headroom, derived from expected sources × assets × buckets, and reconcile with `k8s/base/prometheus-cardinality-rules.yaml`.
- Choose and implement an enforcement mechanism (startup admission check, cap with alerting, relabelling, or bucket aggregation) per metric, with the reasoning and the failure mode of each documented.
- Handle the configuration-driven growth case: adding assets or sources must not silently blow the budget, so provide a check that fails or warns on the configuration change rather than at scrape time.
- Ensure enforcement cannot silently discard data needed by an existing alert; verify each alert's labels remain available after the change.
- Add a test asserting cardinality stays within budget under a worst-case configuration.

## Acceptance Criteria

- [ ] Label audit completed; unused labels removed or justified
- [ ] Per-metric cardinality budget documented with headroom and derivation, reconciled with the existing Prometheus rules
- [ ] Enforcement mechanism implemented per metric with documented failure mode
- [ ] Configuration-change check prevents unbounded growth from adding assets/sources
- [ ] All existing alerts verified to retain their required labels
- [ ] Test asserts budget compliance under worst-case configuration
- [ ] Cardinality reported and alertable before it becomes a problem
@@END

@@TITLE: End-to-end latency budget with per-hop attribution enforced in CI
@@LABELS: performance, devops, enhancement
@@BODY
## Problem

Performance is measured but not budgeted per hop. Load testing exists (`load-tests/k6/` with `api-benchmark.js`, `endpoint-scenarios.js`, `production-peak.js`, `regional-traffic-loss.js`, `websocket-benchmark.js`), tuning guidance exists (`docs/PERFORMANCE_TUNING.md`, `docs/HIGH_THROUGHPUT_PIPELINE.md`), and `docs/EVENT_SCHEMA.md` documents the event pipeline. Tracing exists (`api/src/observability/tracing.ts`, `trace-propagation.ts`, and the aggregator's `replication/trace-context.ts`).

What does not exist is a stated end-to-end latency budget broken down by hop, and enforcement of it. Load tests report aggregate percentiles and compare against a baseline, but nothing decomposes a slow request into its contributing components — cache lookup, file or database read, validation, serialization, network — so when a percentile regresses, the output says "p99 got worse" and not why. Nothing asserts that an individual hop stays within its share of the budget, so a single hop can consume most of the allowance and still pass an end-to-end threshold while removing all the headroom the rest of the request depends on. And because the budget is undeclared, there is no definition of "too slow" that a change can be measured against; the existing baseline comparison ratifies whatever the current numbers are.

## Why this is hard

Per-hop attribution is only meaningful if spans actually cover the hops, and the pipeline crosses service boundaries — HTTP request in the API, cache lookup across L1 and Redis, price read from the store, WebSocket broadcast from the aggregator — and the replication path carries its own trace context. So the work includes making the trace coverage complete and correctly propagated, including across the aggregator-to-API boundary and into the internal WS broadcast, where a span that is not propagated makes the missing hop invisible rather than obviously broken. Then the budget itself must be derived from something defensible rather than from current measurements: the API's latency promises in `docs/service-sla.md` and the SLOs in `monitoring/slo.yml` are the candidates, and dividing an end-to-end target into per-hop shares is a judgement call that should be documented and revisited. Measurement noise is the enforcement problem — p99 latency in CI varies with runner load, so a per-hop CI gate flaps unless it uses a stable measurement (span-derived decomposition under a controlled load test rather than wall-clock in a shared runner) and a tolerance that is justified. Finally, the gate must be able to fail for the right reason: attributable to a hop, with the change's contribution identified, or it will be treated as noise and disabled.

## Requirements

- Declare an end-to-end latency budget with a documented per-hop breakdown, sourced from `docs/service-sla.md` and `monitoring/slo.yml`, and state the derivation.
- Ensure tracing covers every hop including cross-service propagation into the aggregator and the internal WS broadcast; close gaps so a missing span is detected rather than silently absent.
- Implement decomposition of latency by hop under a controlled load test, so attribution does not depend on shared-runner wall-clock timing.
- Enforce per-hop budgets in CI with justified tolerances, failing with the specific hop and magnitude identified.
- Reconcile with the existing k6 baselines so the project has one performance story rather than a baseline check that ratifies current numbers and a separate budget.
- Document how the budget is revised, so it is a maintained commitment rather than a number that decays.
- Report the per-hop breakdown in the CI output and make it available to the dashboards in `monitoring/`.

## Acceptance Criteria

- [ ] End-to-end budget with per-hop breakdown documented and derived from stated SLO/SLA sources
- [ ] Trace coverage complete across services and the WS broadcast; missing spans detected
- [ ] Latency decomposition implemented under controlled load, not shared-runner timing
- [ ] Per-hop CI enforcement with documented tolerances; failures name the hop and magnitude
- [ ] Reconciled with existing k6 baselines into a single performance story
- [ ] Budget revision process documented
- [ ] Breakdown available in CI output and dashboards
@@END

@@TITLE: Reconcile the cost model against real cloud billing with variance thresholds
@@LABELS: devops, performance, enhancement
@@BODY
## Problem

Cost is modelled and reported. `config/cost-model.json` and `config/cost-invoices.json` hold the model and expected invoices; `services/aggregator/src/infrastructure/cost-model.ts` estimates per-API-call costs and budget utilization for oracle sources; `scripts/analyze-infrastructure-costs.mjs`, `scripts/reconcile-cost-invoices.mjs`, and `scripts/capacity-model.mjs` exist alongside `docs/COST_OPTIMIZATION.md` and `docs/GAS_COST_MODEL.md`, with budget alerts in `k8s/cost-optimization/budget.yaml` and `prometheus-rule.yaml`.

The reconciliation script compares modelled against expected values, but nothing compares either against what the cloud actually charged, and there are no variance thresholds that fail anything. A modelled cost that has drifted from reality produces confidently wrong budget alerts and wrong capacity decisions: if the model underestimates, budgets are breached before alerts fire and the source cost controls never trigger; if it overestimates, traffic is throttled on sources that were never a problem. Because `cost-model.ts` also drives `oracleApiBudgetUtilization` — which feeds the per-source budget controls used by the aggregator's scheduling — a stale model changes runtime behaviour, not just reporting.

## Why this is hard

Reconciling a per-call cost model against a cloud bill is genuinely difficult because the units do not align: bills are monthly and aggregate many services, regions, and cost categories, while the model is per-call, per-source, and per-second. Attribution requires a mapping from provider charges to the system's own activities, and for some cost categories that mapping is not determinable from the bill alone — data transfer, request charges, and shared infrastructure are blended. So the honest design reconciles at multiple levels: a coarse total against the bill (which should reconcile tightly), and a set of per-activity unit costs that are inferred indirectly and carry an estimated error band, which must be stated rather than presented as precise. Then variance thresholds have to be defined with the recognition that cloud billing has legitimate variance (regional price changes, support tiers, one-off migrations), so the gate must distinguish drift from expected change, which means the model needs a change log explaining historical steps rather than a single scalar to compare. Finally, making this actionable requires tying discrepancies back to the decisions they affect — budget alerts and the source budget controls — so the reconciliation can flag that a runtime control is operating on a stale input, which is the practically important failure and is invisible from the bill alone.

## Requirements

- Reconcile the modelled cost against actual cloud billing at a stated granularity, documenting which cost categories can be attributed to system activity and which cannot.
- Define per-activity unit costs with explicitly stated error bands where they are inferred rather than directly attributable, instead of presenting them as precise.
- Establish variance thresholds per category and level, with the reasoning, and fail or alert when exceeded. Distinguish drift from legitimate change.
- Maintain a change log for the cost model explaining historical steps, so variance can be attributed rather than merely detected.
- Verify and report that the runtime budget controls — `oracleApiBudgetUtilization` and the per-source budget behaviour — are driven by a model that is within tolerance of reality, and alert when they are not.
- Make the reconciliation reproducible and auditable: state the data sources, the ingestion path for actual billing, and retain the comparison results.
- Document the process for updating the model and the supporting evidence required for a change.

## Acceptance Criteria

- [ ] Modelled versus actual billing reconciled at a stated granularity; attributable and non-attributable categories documented
- [ ] Inferred unit costs carry stated error bands
- [ ] Variance thresholds defined per category and enforced, distinguishing drift from legitimate change
- [ ] Cost-model change log maintained with reasons for historical steps
- [ ] Runtime budget controls verified against a within-tolerance model; alert when stale
- [ ] Reconciliation reproducible, with documented data sources and retained results
- [ ] Model update process documented with required evidence
@@END
