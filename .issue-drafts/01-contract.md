@@TITLE: Enforce the emergency pause consistently across every price-write path
@@LABELS: contract, rust, security, enhancement
@@BODY
## Problem

The emergency pause introduced in #379 is checked in `submit_price` and `submit_batch`, but **not** in `apply_batch_entry` (`contracts/price-oracle/src/contract/submission.rs`).

`apply_batch_entry` is permissionless by design — the Merkle proof is the authorization — and it writes both `set_latest_price` and `append_history`. That means a global emergency pause does **not** stop price state from mutating: anyone holding an unexpired inclusion proof for a root committed before the pause can keep applying entries for as long as the root is retained (`RETAINED_BATCH_ROOTS = 16`). The pause is therefore advisory on the batch path, while operators reasonably believe it is a hard freeze.

The same audit needs to run over every other mutating entrypoint, because the pause check is currently duplicated inline rather than enforced structurally.

## Why this is hard

The pause is not a single boolean gate. Reads must keep working (the comment in `submission.rs` is explicit that `get_price`/`get_price_history` stay live so regions keep serving cached data), admin and governance paths must stay reachable or an operator cannot unpause, and one of those paths is the very mechanism that clears the pause. Getting this wrong in either direction is a production incident: too strict and you cannot recover, too loose and the freeze is cosmetic. The fix also has to survive the `ProxyContract` in `proxy.rs`, which routes to the same helpers.

## Requirements

- Add the pause check to `apply_batch_entry` so all three price-write paths (`submit_price`, `submit_batch`, `apply_batch_entry`) share identical gating.
- Determine from first principles — and document in `docs/THREAT_MODEL.md` — which entrypoints are deliberately exempt: the read queries, `extend_storage_ttl` / `extend_price_history_ttl` / `extend_instance_ttl`, and the multisig path that clears the pause.
- Replace the duplicated inline checks with a single guard helper (e.g. `utils::require_not_paused`) so a future entrypoint cannot silently omit it.
- Re-verify the exemption list against `ProxyContract` — the same rules must hold through the proxy, or `get_api_version` / pause semantics diverge.
- Add a regression test that enumerates the contract's exported entrypoints and asserts each mutating one rejects with `ContractPaused` while the exempt set does not. This test must fail when a new mutating entrypoint is added without a pause check, so it keeps working as a guard rail.

## Acceptance Criteria

- [ ] `apply_batch_entry` returns `ContractPaused` when paused, with no storage mutation
- [ ] A single shared pause guard is used by every mutating price path
- [ ] Exempt entrypoints are explicitly listed and justified in `docs/THREAT_MODEL.md`
- [ ] Proxy path enforces identical pause semantics
- [ ] Test asserts pause behavior for every exported entrypoint and fails on a newly added unguarded one
- [ ] `cargo test` passes; entrypoint gas benchmarks in `gas_benchmarks.rs` show no regression beyond noise
@@END

@@TITLE: Make slashing actually move funds — stake escrow, custody, and claim accounting
@@LABELS: contract, rust, security, enhancement
@@BODY
## Problem

`slash()` in `contracts/price-oracle/src/contract/submission.rs` is economically inert. It decrements an `i128` counter (`storage::set_stake`) and increments a slash count, then returns. No `token::Client` is ever constructed, so **no tokens move**.

Meanwhile `stake()` does the opposite correctly: it calls `token_client.transfer(source, contract, amount)`, so staked tokens genuinely sit in the contract. The two halves do not compose. A slashed source keeps its tokens in the protocol's custody forever, there is no way to move a slashed balance to a treasury or back to other stakers, and `get_stake_balance` returns a number that no longer corresponds to any real token holding. The counters say "punished"; the ledger says nothing happened.

## Why this is hard

Real slashing needs decisions the current code has no place to express: where slashed funds go, whether slashing is instant or challengeable, and how it interacts with a source being re-registered. It also has to stay correct under the contract's own constraints — `stake()` never records *which* token address it used, so a source could stake in token A and later be slashed against a balance denominated in token B unless the token is tracked per source. And `storage::get_stake`/`set_stake` live in instance storage, so this touches the same monolithic-entry problem tracked separately.

## Requirements

- Record the staked token address per source at `stake()` time. Reject top-ups in a different token rather than silently mixing denominations.
- Make `slash()` actually transfer the slashed amount out of the contract, to an admin-or-governance-designated treasury recipient. Slashing must not be able to move more than the recorded stake.
- Define and implement the failure mode where the on-chain stake counter exceeds the contract's real token balance for that token (possible if tokens are ever swept by another path). Prefer failing the slash loudly over silently burning the accounting.
- Require slashing to be authorised through the multisig governance path rather than a bare `admin.require_auth()`, consistent with how `docs/MULTISIG_ADMINISTRATION.md` describes treasury operations.
- Emit the amount and destination on `SourceSlashed` so the slash is auditable from events alone; the current event omits the destination entirely.
- Add a `claim_slashed` or equivalent accessor so funds are not stranded if the treasury recipient address is rotated.

## Acceptance Criteria

- [ ] `stake()` records the token address; mismatched top-up is rejected with a specific error
- [ ] `slash()` transfers the slashed amount to the designated recipient and emits the destination
- [ ] Slash amount is capped at the recorded stake and cannot exceed the contract's real balance for that token
- [ ] Slashing requires multisig authorisation, not a bare admin auth
- [ ] Test covers: stake then slash (funds move, balances reconcile), slash exceeding stake (clamped), slash with no stake (no-op, no error path that strands state)
- [ ] Contract token balance + tracked stake always reconcile after any sequence of stake/slash/claim
@@END

@@TITLE: Reject backdated and replayed price submissions with timestamp monotonicity
@@LABELS: contract, rust, security, enhancement
@@BODY
## Problem

`submit_price` accepts the `timestamp` argument verbatim and passes it straight into `PriceDataPoint` (`contracts/price-oracle/src/contract/submission.rs`). Nothing compares it against the previously stored point before `set_latest_price` overwrites the slot.

An authorised source — or an attacker who has compromised one, or simply a buggy publisher replaying a queued message after a restart — can submit a **stale** timestamp and overwrite a newer price. There is no error for it, and `PriceSubmitted` will happily publish the backdated value. `get_price` then serves an old observation as if it were current, and because `append_history` appends in call order rather than timestamp order, the history vector's `get_price_history(asset, limit)` range query (`start = len - limit`) starts returning a non-chronological tail.

The retry queue in `services/aggregator/src/contract-publishing/retry-queue.ts` makes this reachable in practice: a delayed retry legitimately carries an old timestamp.

## Why this is hard

The naive fix — "reject if `timestamp <= latest.timestamp`" — is wrong in several real cases that have to be reasoned about rather than guessed: two sources submitting in the same ledger second, a legitimate out-of-order submission from a source with a slower clock, and a price correction where a source genuinely needs to replace its own last value. The contract also currently has no notion of *which* source owns the latest slot, so "is this newer?" and "is this newer than this source's own last value?" are different questions and only one of them is being asked. Getting the ordering rule wrong across the proxy and batch paths reintroduces the bug through `apply_batch_entry`, which does not check timestamps at all.

## Requirements

- Define an explicit ordering rule and document it in `docs/CONTRACT_VERSIONING.md` (or a new ADR): what makes a submission acceptable relative to the stored point. Cover the same-second case, the equal-timestamp-different-source case, and the deliberate-correction case.
- Enforce the rule in `submit_price` **and** in `apply_batch_entry`, so the batch path cannot be used to bypass it.
- Consider and document the staleness bound: a submission whose timestamp is too far in the future (garbage or malicious clock) is as harmful as one too far in the past. Both directions need a policy.
- Preserve the existing `MAX_HISTORY_LEN` trimming behaviour while ensuring the retained history stays chronologically ordered under the new rule, since `get_price_history(asset, limit)` assumes the tail is the most recent.
- Add a dedicated error variant rather than overloading `InvalidPrice`, so callers and the aggregator's retry logic can distinguish "rejected because old" from "rejected because malformed" and avoid retrying forever.

## Acceptance Criteria

- [ ] Ordering/staleness policy documented, including same-second and correction cases
- [ ] `submit_price` rejects a submission older than the policy allows, with a distinct error variant
- [ ] `apply_batch_entry` enforces the identical rule
- [ ] Future-dated submissions beyond the defined bound are rejected
- [ ] Retained history remains chronological, verified by a test
- [ ] Aggregator retry logic treats the new error as non-retryable (or explicitly reconciles), with a test proving it does not hot-loop
@@END

@@TITLE: Migrate growing contract state out of instance storage into persistent keys with per-key TTL
@@LABELS: contract, rust, architecture, performance, enhancement
@@BODY
## Problem

Almost all mutable contract state lives in Soroban **instance** storage. Surveying `contracts/price-oracle/src/storage.rs`, that includes every asset's latest price (`LatestPrice`), the full asset list (`AllAssets`), trusted-asset flags, authorized sources and their names (`Source`, `SourceName`, `SourceCount`), whitelist entries, per-source reputation (`SourceReputation`), multisig config and **every proposal** (`MultiSigProposal(id)`), batch bookkeeping (`BatchRoot(nonce)`, `BatchAppliedLeaves(nonce)`, `BatchPruneWatermark`), query fees and fee balance.

Instance storage is a single ledger entry. That has two consequences that get worse over time and are already visible in the code's workarounds:

1. **Cost scales with total state, not with the keys touched.** Every call that touches *any* instance key pays to load and write the whole entry. A `get_price` for one asset is billed against the reputation of every source, every outstanding proposal, and every whitelist entry. The number of keys only grows.
2. **One TTL for everything.** `extend_instance_ttl` extends all of it together, which is why the comment in `storage.rs` says the off-chain job exists so `Admin`, `GovConfig`, proposals "and the rest" never hit the TTL floor. A single miss archives the admin key, the pause flag, and the proposals together.

The price *history* was already correctly moved to persistent storage for exactly this reason — the rest of the state was not, and `add_oracle_source` even documents a micro-optimisation to avoid "two storage writes on the re-add path" as if writes were the dominant cost.

## Why this is hard

This is a storage-layout migration on a contract that must keep serving reads and cannot lose admin or governance access. The pieces interact: `RETAINED_BATCH_ROOTS` pruning assumes instance `remove()` semantics; `extend_instance_ttl` becomes a different job once state is split; and `docs/SCHEMA_MIGRATIONS.md` plus `storage_layout_version` exist precisely because a migration like this needs a versioned, resumable cutover rather than a one-shot rewrite. Doing it in one transaction will exceed budget. Deciding *which* keys move, which stay (admin, pause, versions are arguably correct in instance), and how the TTL job tracks the new keys is the actual design work.

## Requirements

- Classify every `DataKey` variant as instance or persistent, with the rationale recorded. Admin/pause/version keys plausibly stay in instance; per-asset, per-source, per-proposal, and batch keys should not.
- Design a chunked, idempotent migration keyed off `storage_layout_version`, able to run across multiple transactions and resume safely after a partial run. Follow the pattern in `upgrade_migration_test.rs`.
- Update `admin::extend_instance_ttl` and the TTL job (`scripts/extend-ttl-job.ts`, `scripts/extend-contract-ttl.mjs`) to cover persistent keys individually, with a strategy that does not require enumerating an unbounded key set in one call.
- Preserve `RETAINED_BATCH_ROOTS` pruning semantics under the new layout, and confirm `mark_batch_leaf_applied`'s read-modify-write still behaves correctly against a persistent entry.
- Add a migration test that runs a representative pre-migration state through the cutover and asserts read equivalence for every accessor, plus a documented rollback path consistent with `docs/CONTRACT_UPGRADE_GOVERNANCE.md`.

## Acceptance Criteria

- [ ] Every `DataKey` classified and documented; no unbounded or per-entity key left in instance storage
- [ ] Migration is chunked, idempotent, versioned, and resumable across transactions
- [ ] A `get_price`-equivalent read no longer scales with total contract state; before/after CPU and memory instruction counts recorded in `GAS_OPTIMIZATION.md`
- [ ] TTL extension covers all persistent keys without a single unbounded enumeration call
- [ ] Migration + rollback tests pass, including a resumed-after-partial-run case
- [ ] Read equivalence asserted for all accessors against pre-migration state
@@END

@@TITLE: Replace full-history-vector rewrites with a bounded ring buffer in persistent storage
@@LABELS: contract, rust, performance, enhancement
@@BODY
## Problem

`utils::append_history` (`contracts/price-oracle/src/utils.rs`) reads the entire history vector, and on every single submission either pushes and rewrites it, or rebuilds a new 100-element vector by shifting indices 1..len and rewrites that:

```rust
let mut history = storage::get_price_history(env, asset);
if history.len() >= storage::MAX_HISTORY_LEN { /* rebuild from index 1 */ }
```

`storage::set_price_history` then serializes the whole vector into one persistent ledger entry. So the steady-state cost of publishing one price is **deserialize 100 `PriceDataPoint`s + rebuild + serialize 100 `PriceDataPoint`s**, plus the persistent-storage write-value cost on the full entry. With `MAX_HISTORY_LEN = 100` and a 30-second poll interval across five assets, that is a large, constant per-submission cost paid forever, and it grows as more assets are tracked. The `for i in 1..history.len()` rebuild is explicitly noted as a workaround for `Vec` having no `remove()`, which is a symptom rather than the cause.

## Why this is hard

The fix is constrained from both sides. On-chain storage is billed per ledger-entry write size, so "one entry per data point" multiplies the number of entries and pushes the cost elsewhere. Soroban has no `Vec::remove`, so a genuine ring buffer needs a head index and modulo arithmetic — and then `get_price_history(asset, limit)` must still return the newest `limit` points in chronological order, since the API's cursor pagination and the aggregator's gap detection both depend on that ordering. The batch path writes history too, so whatever structure you choose has to hold for `apply_batch_entry` as well. And a layout change here interacts with the storage migration above, so the two need a coherent order of operations.

## Requirements

- Introduce a fixed-size ring buffer: a pre-allocated storage entry of constant size, a monotonic head/count, and wraparound writes — so a write cost is independent of how much history is retained.
- Keep `get_price_history(asset, limit)` returning the newest `limit` points in chronological order; this is a hard compatibility requirement for the API and the gap-detection workflow.
- Keep the retention cap configurable rather than a hard-coded `MAX_HISTORY_LEN` constant, and document the interaction between the cap and the ring entry size (the cap drives the per-write size).
- Apply to both `submit_price` and `apply_batch_entry`.
- Measure and record the actual instruction-count improvement with the existing harness in `gas_benchmarks.rs`, not an estimate.

## Acceptance Criteria

- [ ] Per-submission write cost is independent of retained history length
- [ ] `get_price_history` returns newest-limit in chronological order; existing query tests pass unchanged
- [ ] Wraparound, partial-fill, and exactly-at-capacity cases covered by tests
- [ ] Retention cap configurable and documented
- [ ] Before/after CPU and memory instruction counts recorded in `GAS_OPTIMIZATION.md`
- [ ] Batch path uses the same structure and is covered by tests
@@END

@@TITLE: Make reputation decay canonical instead of being discarded on the next write
@@LABELS: contract, rust, enhancement
@@BODY
## Problem

Reputation has two implementations that fight each other (`contracts/price-oracle/src/utils.rs`).

`update_reputation` recomputes the score from scratch on every submission:

```rust
rep.score = (rep.accurate_submissions * 10_000) / rep.total_submissions;
```

`apply_reputation_decay` separately multiplies the score by 95/100 per elapsed 7-day period — but it is only ever called from the **read** path (`queries::get_source_reputation`). It never writes back, and it is never invoked from `update_reputation`.

Two consequences: (1) decay is a cosmetic read-time illusion that any single submission erases, so an inactive source that once misbehaved recovers full score the moment it submits once; (2) because `update_reputation` recomputes from raw counters, the score depends only on the lifetime accurate/total ratio and ignores decay entirely. A source with a long history of accuracy is effectively un-decayable, and a source that submitted once accurately holds a perfect score forever. Also note `rep.total_submissions == 0` is unreachable after the increment on the line above, so that branch is dead code.

## Why this is hard

Decay-correct reputation requires choosing a model and then committing to it: recompute-from-counters (current) and multiplicative-decay-with-writeback are two different ledgers, and mixing them, as now, gives a value that means nothing. A correct version must persist whatever state the decay needs — a last-decay ledger timestamp distinct from `last_updated`, or an epoch-based accumulator — which is a type change and therefore interacts with `docs/SCHEMA_MIGRATIONS.md`. It must be idempotent: applying decay twice for the same elapsed period must not compound. And it must stay bounded and deterministic, because the current `.min(40)` period clamp is a hint that someone already worried about unbounded loops. Whatever is chosen also has to be meaningful to the consumer: reputation is intended to feed source weighting in the aggregator and slashing thresholds here.

## Requirements

- Pick one reputation model and make both the write and read paths agree on it. Remove the dead branch.
- If decay is retained, persist the decay anchor so `update_reputation` and `get_source_reputation` both apply it exactly once per elapsed period, with no compounding on repeated reads.
- Define and document the recovery semantics explicitly: how does a source that was slashed or that missed its accuracy threshold earn back standing, and over what period? This is a policy decision that must be written down, not implied.
- Guarantee the score stays within [0, 10_000] with saturating arithmetic under adversarial counter values.
- Consume the result somewhere real — at minimum, expose it such that the aggregator's weighting (see the aggregator-side issue) and any slashing threshold can read a single authoritative value.

## Acceptance Criteria

- [ ] Write and read paths agree; decay is applied exactly once per period and is idempotent on repeated reads
- [ ] Model and recovery semantics documented
- [ ] Dead code removed
- [ ] Score bounded [0, 10_000] and saturation-tested at extremes
- [ ] Tests cover: inactive source decaying over multiple periods, immediate recovery attempt after decay, decay not compounding on repeated reads
- [ ] Migration for any new/changed reputation fields, consistent with `docs/SCHEMA_MIGRATIONS.md`
@@END

@@TITLE: Correct USD conversion — stop hardcoding the USDC peg and stop failing silently
@@LABELS: contract, rust, security, enhancement
@@BODY
## Problem

`utils::calculate_usd_price` (`contracts/price-oracle/src/utils.rs`) has three distinct correctness problems:

1. **USDC is hardcoded at 1:1.** The function returns `10i128.checked_pow(decimals)` for USDC without consulting any stored price. A depeg — exactly the scenario this oracle exists to make visible — is invisible: the contract will confidently report USDC at $1.00 while the real market moves. This is the single most consequential thing a price oracle can get wrong.
2. **XLM is treated as its own USD rate.** For XLM the function returns `price` unchanged, on the stated convention that "XLM prices are already denominated in USD terms". That makes the correctness of every other asset's USD value depend on one implicit assumption about what sources submit for XLM, which is nowhere enforced.
3. **Failure is silent.** If the asset is not XLM/USDC and no XLM price is stored, or the checked arithmetic overflows, the function returns `None` — and `queries::get_price` propagates that as `price_usd: None` inside an otherwise successful `AssetPrice`. A consumer reading `price_usd` cannot distinguish "not yet priced" from "conversion overflowed" from "misconfigured asset".

## Why this is hard

Fixing this means choosing a real denomination model rather than patching three branches. Options range from enforcing a strict quote convention on submission (every asset quoted against a designated numeraire, validated on write) to a multi-hop conversion graph — and each has different failure and upgrade characteristics, as well as different implications for what existing stored data means. Whichever is chosen must be applied consistently across `PriceOracleContract` and `ProxyContract`, since `utils` exists specifically because these two drifted into two different USD formulas once already (the file's own comment says so). Decimals handling is the trap: the current `scale = decimals + xlm_price.decimals` and `10f64::checked_pow(scale)` will return `None` for large decimal counts, which is silently indistinguishable from an unpriced asset. And any convention change invalidates previously stored values, so this needs an explicit migration or a documented "values before ledger X are not comparable" statement.

## Requirements

- Remove the hardcoded USDC peg for `price_usd`; derive it from a stored price like any other asset, or explicitly reclassify the field so it is not presented as a market USD value.
- Make the denomination convention explicit and **validated at submission time**, so a source cannot store a value that violates whatever convention `calculate_usd_price` assumes.
- Make conversion failure distinguishable and observable: separate error/`None` reasons for "no reference price", "unsupported asset", and "overflow", surfaced through `get_price` rather than collapsing into one `None`.
- Document the decimal bounds within which conversion is representable, and reject submissions outside them at write time instead of failing at read time.
- Apply identically in `PriceOracleContract` and `ProxyContract`; add a test asserting the two produce identical results for the same inputs, so this cannot drift a third time.
- Address historical data: document whether stored values remain valid under the new convention.

## Acceptance Criteria

- [ ] No hardcoded peg value remains in the USD conversion path
- [ ] Denomination convention enforced on submission, with a distinct error for violations
- [ ] Conversion failure reasons are distinguishable via the read API
- [ ] Decimal bounds validated on write; unrepresentable values rejected up front
- [ ] Test proves contract and proxy conversions are identical across a table of inputs
- [ ] Historical-data validity documented
@@END

@@TITLE: Move price aggregation on-chain — per-source slots, quorum, and a verifiable median
@@LABELS: contract, rust, architecture, enhancement
@@BODY
## Problem

The contract does not aggregate. `submit_price` writes whatever the last authorized source sent into a single `LatestPrice` slot, overwriting the previous value (`storage.rs`, `set_latest_price`). The only cross-source check is the optional `deviation_exceeds` guard against the immediately preceding value.

So the "unified oracle" is unified only off-chain, in the aggregator's median. On-chain consumers get the last writer's opinion. Two further symptoms of the same gap:

- `queries::get_price` returns `num_sources: storage::get_source_count(env)` — that is the number of *authorized* sources, not the number that contributed to this price. A consumer reading `num_sources: 4` has no way to know whether four sources agreed or one submitted into an empty slot.
- Nothing records per-source contributions, so reputation (`update_reputation`) is measuring a source against the previous *anyone's* price, not against a consensus, which makes accuracy scoring incoherent.

## Why this is hard

On-chain median over four sources with the current state layout is the constraint that makes this interesting: summing and sorting requires all contributions resident, which is exactly what the monolithic instance-storage problem makes expensive, and Soroban has no sort on `Vec`. A per-source slot design changes the write pattern from one write per round to one write per source per round, which is a real cost increase that must be justified against the benefit. Then the hard policy questions: what is a quorum — majority of *authorized* or majority of *responding*? What happens to a slot whose source is silent — does it hold the last value, become stale, or count as a non-response? Does the median update on every submission or only at a round boundary, and if the latter, who closes the round and what stops a malicious source from withholding to manipulate the boundary? Every one of those has to be decided and defended, and the decisions interact with the deviation guard, the reputation model, and the Merkle batch path (which writes prices outside `submit_price` entirely).

## Requirements

- Design and implement per-source price slots keyed by (asset, source), replacing or supplementing the single `LatestPrice` slot.
- Implement a deterministic on-chain aggregate at read time — median or a documented alternative — with explicit staleness handling for slots that stop being updated.
- Define and enforce a quorum policy, and expose it: `get_price` must report how many sources actually contributed and whether quorum was met, not how many are authorized.
- Reconcile with the batch path: `apply_batch_entry` must produce values that are consistent with the aggregate, or be explicitly excluded and documented.
- Re-derive reputation against the aggregate rather than the previous single-source value, so accuracy scores mean something.
- Produce a written design decision (ADR under `docs/adr/`) covering round boundaries, quorum definition, silence handling, and the cost trade-off, with measured instruction counts.

## Acceptance Criteria

- [ ] Per-source slots implemented; a single source can no longer unilaterally determine the served price
- [ ] Deterministic on-chain aggregate with documented staleness handling for silent sources
- [ ] `get_price` reports contributing-source count and quorum status separately from authorized-source count
- [ ] Batch path reconciled or explicitly excluded, with the reason documented
- [ ] Reputation computed against the aggregate
- [ ] ADR written; CPU/memory instruction cost measured and compared to the current single-write path
- [ ] Tests cover: single source only, exactly-quorum, below-quorum, a source going silent, and conflicting outliers
@@END

@@TITLE: Replace the O(n²) batch applied-leaf tracker with a bitmap and bound batch size
@@LABELS: contract, rust, performance, enhancement
@@BODY
## Problem

`storage::mark_batch_leaf_applied` (`contracts/price-oracle/src/storage.rs`) guards against re-applying a leaf by scanning and rewriting a `Vec<u32>` on every call:

```rust
let mut applied = get_batch_applied_leaves(env, nonce);
for i in 0..applied.len() { /* linear scan for duplicate */ }
applied.push_back(leaf_index);
env.storage().instance().set(&DataKey::BatchAppliedLeaves(nonce), &applied);
```

For a batch of `n` leaves that is `n` linear scans of an `n`-element vector plus `n` full-vector rewrites into **instance** storage — quadratic work and quadratic write size for what is a set-membership test. The Merkle batch path exists specifically to make per-entry application cheap relative to a full `submit_price`, so this undermines the feature's own justification: at `RETAINED_BATCH_ROOTS = 16` batches retained, that is 16 such vectors resident in the single instance ledger entry.

There is also no upper bound on the number of leaves a batch may contain, so a source with a valid root can commit a batch whose size is limited only by what the Merkle construction allows.

## Why this is hard

A bitmap is the obvious structure, but the details are where this gets real. The leaf index is a `u32`, so a dense bitmap is only viable if indices are bounded — which means introducing an explicit maximum batch size and making `submit_batch` enforce it, which in turn means the off-chain producer (`services/aggregator/src/infrastructure/merkle.ts`) must respect the same bound or batches start failing at commit time. Sparse indices need a set structure rather than a bitmap, and the choice interacts with the storage migration tracked separately since this is currently instance storage. Whatever the structure, it must remain correct across the pruning that `prune_batch_roots` performs, must be idempotent under concurrent apply attempts, and must not change the observable `BatchEntryAlreadyApplied` behaviour that existing tests depend on.

## Requirements

- Replace the scan-and-rewrite set with a constant-write-cost structure (bitmap for dense bounded indices, or a documented sparse alternative).
- Introduce and enforce a maximum leaves-per-batch bound in `submit_batch`; derive the bitmap size from it so the tracker entry has a fixed, known size.
- Align the off-chain Merkle producer in the aggregator with the same bound, and make the failure mode explicit if it is exceeded.
- Move the tracker off instance storage as part of (or consistently with) the storage-layout migration.
- Preserve exact existing semantics: duplicate apply returns `BatchEntryAlreadyApplied`; pruning still releases tracker state for aged-out batches.
- Measure before/after instruction counts for `apply_batch_entry` at representative batch sizes using `gas_benchmarks.rs`.

## Acceptance Criteria

- [ ] Apply cost is independent of the number of leaves already applied in the batch
- [ ] Maximum batch size enforced on-chain and respected off-chain
- [ ] Tracker entry is fixed-size and out of instance storage
- [ ] Duplicate-apply and pruning semantics unchanged, with tests
- [ ] Re-applying after a leaf's root ages out is tested and its behaviour is documented
- [ ] Before/after instruction counts recorded
@@END

@@TITLE: Wire gas benchmarks into CI as regression gates with per-entrypoint budgets
@@LABELS: contract, rust, tests, performance, enhancement
@@BODY
## Problem

`contracts/price-oracle/src/gas_benchmarks.rs` (exposed via `contracts/price-oracle/tests/gas_benchmarks_module.rs`) measures CPU and memory instruction counts, and `docs/GAS_COST_MODEL.md` and `GAS_OPTIMIZATION.md` describe the cost model. But nothing in `.github/workflows/` fails a build when those numbers get worse. `docs/GAS_COST_MODEL.md` and its siblings therefore go stale silently, and every optimisation in this area — the history ring buffer, the applied-leaf bitmap, the storage migration — has no mechanism to prove it did not regress something else.

This matters more than a normal perf gate because on Soroban, CPU instructions, memory, ledger-entry reads and writes, and *entry size* are all billed, and several current designs trade one for another. A change that reduces CPU while increasing entry size can be a net loss, and only a gate that tracks multiple dimensions will catch it.

## Why this is hard

Comparable-in-CI benchmarking is the hard part, not the assertion. Instruction counts must be deterministic across machines and Rust/Soroban SDK versions, or the gate flaps and gets disabled. That means pinning the toolchain, fixing the ledger sequence/timestamp/max-TTL inputs so measurements are comparable, and deciding what a regression *is* — an absolute budget per entrypoint, a percentage against a committed baseline, or both. Published budgets also have to be defensible: they should reflect real ledger limits rather than whatever the code currently happens to cost, or the gate just enshrines today's inefficiency. And the baseline has to be updated deliberately by a human with justification, not silently by CI, or the gate ratchets to meaninglessness.

## Requirements

- Emit machine-readable per-entrypoint measurements (CPU instructions, memory, ledger read/write counts, and entry sizes) from the existing benchmark harness.
- Commit a baseline artifact and add a CI job that measures and compares against it, failing on regression beyond a documented tolerance.
- Define and publish a per-entrypoint budget grounded in actual Soroban ledger limits, not in current measurements; document where the limits come from.
- Pin the toolchain and all ledger-environment inputs so measurements are reproducible; document the procedure for a human to intentionally update the baseline with justification.
- Ensure the gate covers the entrypoints these other workstreams touch: `submit_price`, `apply_batch_entry`, `get_price`, `get_price_history`, `stake`, `slash`.
- Report the delta directly in the CI log so a failing gate explains which entrypoint moved and by how much.

## Acceptance Criteria

- [ ] Benchmark job produces per-entrypoint CPU/memory/ledger metrics in a machine-readable format
- [ ] CI fails on regression beyond a documented tolerance against a committed baseline
- [ ] Per-entrypoint budgets published and justified against real ledger limits
- [ ] Toolchain and ledger environment pinned; measurements reproducible across runs
- [ ] Documented human process for intentionally updating the baseline
- [ ] Gate covers all six listed entrypoints
- [ ] Failure output names the regressed entrypoint and the magnitude
@@END
