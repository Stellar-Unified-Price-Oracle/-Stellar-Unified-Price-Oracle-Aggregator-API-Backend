# Fuzz Testing — Price Oracle Contract

This document covers both the **deterministic boundary tests** (`src/fuzz.rs`) and
the **cargo-fuzz harnesses** (`fuzz/`) that feed random inputs into the contract
through libFuzzer.

---

## Overview

| Layer | Location | Tool | Runs in CI |
|-------|----------|------|-----------|
| Boundary/edge-case unit tests | `src/fuzz.rs` | `cargo test` | ✅ every push |
| Coverage-guided random fuzzing | `fuzz/fuzz_targets/` | `cargo fuzz` | ✅ 30 s per target |

---

## Quick Start

### Run the deterministic boundary tests

```bash
cd contracts/price-oracle
cargo test fuzz_ --lib
```

These tests cover i128 min/max boundaries, zero prices, negative prices,
u32::MAX decimals, timestamp edge cases, large asset names, history window
limits, and concurrent multi-source submissions.

### Run cargo-fuzz locally

Requires Rust **nightly** and `cargo-fuzz`:

```bash
rustup install nightly
cargo install cargo-fuzz --locked
```

Run `fuzz_submit_price` for 60 seconds:

```bash
cd contracts/price-oracle
cargo fuzz run fuzz_submit_price fuzz/corpus/fuzz_submit_price -- -max_total_time=60
```

Run `fuzz_get_price` for 60 seconds:

```bash
cargo fuzz run fuzz_get_price fuzz/corpus/fuzz_get_price -- -max_total_time=60
```

Stop at any time with `Ctrl-C`. Interesting inputs that increase coverage are
automatically saved to the corpus directory.

### Reproduce a crash

If cargo-fuzz finds a crash it saves the input under `fuzz/artifacts/<target>/`:

```bash
cargo fuzz run fuzz_submit_price fuzz/artifacts/fuzz_submit_price/crash-<hash>
```

---

## Fuzz Targets

### `fuzz_submit_price` (`fuzz/fuzz_targets/fuzz_submit_price.rs`)

Feeds randomised `SubmitPriceInput` structs into `submit_price`:

| Field | Type | What libFuzzer explores |
|-------|------|------------------------|
| `asset_bytes` | `Vec<u8>` | asset symbol encoding |
| `price` | `i128` | full signed 128-bit range |
| `decimals` | `u32` | full 32-bit range |
| `timestamp` | `u64` | full 64-bit range |
| `use_authorized_source` | `bool` | authorized vs unauthorised callers |

**Invariant checked**: when `use_authorized_source=true` and the call succeeds,
`get_price` must return the exact `price` and `decimals` values that were submitted.

### `fuzz_get_price` (`fuzz/fuzz_targets/fuzz_get_price.rs`)

Feeds a variable-length sequence of `Submission` structs followed by a query:

| Field | Type | What libFuzzer explores |
|-------|------|------------------------|
| `submissions` | `Vec<Submission>` | 0–64 randomised price submissions |
| `query_asset_bytes` | `Vec<u8>` | asset that may or may not exist |
| `history_limit` | `u32` | history window including 0 and u32::MAX |

**Invariant checked**: `history.len()` ≤ min(submitted_count, history_limit).
Both `get_price` and `get_price_history` must never panic.

---

## Seed Corpora

Version-controlled seed files give libFuzzer a head-start on interesting inputs.
Seeds are binary files in the `arbitrary::Unstructured` wire format.

```
fuzz/corpus/
├── fuzz_submit_price/
│   ├── seed_xlm_price_zero       # price=0, decimals=7, authorized
│   ├── seed_btc_price_max        # price=i128::MAX, decimals=8
│   ├── seed_eth_price_min        # price=i128::MIN+1, decimals=18
│   ├── seed_unauthorized         # price=1_000_000, unauthorized caller
│   ├── seed_large_decimals       # decimals=u32::MAX
│   └── seed_long_asset           # 36-char asset name
└── fuzz_get_price/
    ├── seed_single_xlm           # 1 XLM submission, query XLM, limit=10
    ├── seed_single_btc_limit1    # 1 BTC submission, query BTC, limit=1
    ├── seed_empty_submissions    # 0 submissions, query nonexistent asset
    ├── seed_max_limit            # limit=u32::MAX
    └── seed_zero_limit           # limit=0
```

New corpus entries discovered during fuzzing can be committed to keep coverage
improvements across runs.

---

## Deterministic Boundary Tests (`src/fuzz.rs`)

These run with stable Rust and require no nightly toolchain.

| Test | What it covers |
|------|---------------|
| `fuzz_submit_price_boundary_i128_max` | `price = i128::MAX` accepted |
| `fuzz_submit_price_boundary_i128_min` | `price = i128::MIN + 1` accepted |
| `fuzz_submit_price_zero` | zero price stored and retrieved |
| `fuzz_submit_price_negative` | negative price stored and retrieved |
| `fuzz_submit_price_large_decimals` | `decimals = u32::MAX` accepted |
| `fuzz_add_oracle_source_duplicate_address` | duplicate source add is idempotent |
| `fuzz_add_oracle_source_same_address_twice` | same address added twice, both succeed |
| `fuzz_get_price_history_zero_limit` | limit=0 returns empty vec |
| `fuzz_get_price_history_max_limit` | limit=u32::MAX capped at stored entries |
| `fuzz_get_price_history_limit_exceeds_entries` | request > stored returns what exists |
| `fuzz_get_price_history_limit_one` | returns only the most recent entry |
| `fuzz_sequential_price_submissions_consistency` | history ordering after 6 submissions |
| `fuzz_multiple_sources_concurrent_submissions` | 3 sources, 3 submissions, history=3 |
| `fuzz_price_submission_timestamp_boundaries` | timestamps 0, 1, u64::MAX/2, u64::MAX-1 |
| `fuzz_large_asset_name` | 42-char asset name accepted |

---

## CI Job

The `contract-fuzz` job in `.github/workflows/ci.yml`:

1. Installs Rust nightly via `dtolnay/rust-toolchain@nightly`
2. Caches `~/.cargo/registry` and the contract build directory
3. Installs `cargo-fuzz` (pinned with `--locked`)
4. Runs the deterministic boundary tests: `cargo test fuzz_ --lib`
5. Runs `fuzz_submit_price` for 30 s with seed corpus
6. Runs `fuzz_get_price` for 30 s with seed corpus
7. Uploads `fuzz/artifacts/` as a CI artifact if any step fails

A failure means libFuzzer found a crash or a broken invariant. Download the
artifact, extract the input file, and reproduce locally (see above).

---

## Adding New Fuzz Tests

**Boundary test** (no nightly required): add a `#[test]` function prefixed with
`fuzz_` to `src/fuzz.rs`. Use the `setup_fuzz()` helper and assert a specific
invariant.

**cargo-fuzz target**: add a new `[[bin]]` entry to `fuzz/Cargo.toml`, create
`fuzz/fuzz_targets/<name>.rs`, derive `Arbitrary` for your input struct, and add
a corpus directory under `fuzz/corpus/<name>/`. Update the CI job to include the
new target.

---

## Security Properties Under Test

| Property | Tested by |
|----------|-----------|
| No panic on any input combination | both layers |
| Unauthorized sources always rejected | `seed_unauthorized`, `use_authorized_source=false` |
| History ordering preserved | `fuzz_sequential_price_submissions_consistency` |
| History length bounded by limit | `fuzz_get_price` invariant check |
| i128 boundary values stored without overflow | boundary unit tests + random harness |
| u32::MAX decimals handled | `seed_large_decimals` + random harness |
| Query on non-existent asset returns None | `seed_empty_submissions` + random harness |
