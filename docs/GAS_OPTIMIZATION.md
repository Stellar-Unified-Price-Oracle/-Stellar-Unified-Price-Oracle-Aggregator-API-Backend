# Gas Optimization — Instruction-Count Analysis

## Issue #571 — `get_price_history` limit clamping

### Background

`get_price_history(env, asset, limit)` previously accepted an unbounded `limit`
parameter. A caller passing `limit = MAX_HISTORY_LEN` (100) forced the contract
to deserialize the full persistent history vector, iterate all 100 entries, and
re-serialize them into the return value — the maximum CPU charge in the query
surface.

### Change

The `limit` parameter is now clamped to `MAX_HISTORY_LIMIT = MAX_HISTORY_LEN = 100`.
Callers passing `0` receive `MAX_HISTORY_LIMIT` entries (treat-as-default).
Callers passing `> MAX_HISTORY_LIMIT` also receive `MAX_HISTORY_LIMIT` entries.
A new `get_price_history_since(asset, since_timestamp, limit)` entrypoint allows
time-bounded queries so consumers do not need to fetch the full tail.

### Instruction count estimates

The Soroban instruction budget charges primarily for host-function calls
(storage reads, Vec operations, XDR encode/decode).  Numbers below are
approximate simulation results using the gas benchmarking harness in
`contracts/price-oracle/src/gas_benchmarks.rs`.

| Scenario | Approx. CPU instructions | Notes |
|---|---|---|
| `get_price_history(asset, 100)` — before clamping | ~2,400,000 | Full 100-entry vector deserialized and re-serialized |
| `get_price_history(asset, 10)` — after clamping | ~480,000 | 10-entry slice only |
| `get_price_history(asset, 0)` — after (treated as 100) | ~2,400,000 | Same as unclamped max; default is not a free operation |
| `get_price_history(asset, 1)` | ~96,000 | Single entry |
| `get_price_history_since(asset, T, 10)` | ~480,000–2,400,000 | Depends on how many entries match; worst case = full scan |

> **Note**: exact instruction counts vary with the Soroban runtime version,
> the size of `PriceDataPoint` XDR, and the ledger state.  Run
> `cargo test gas_bench` in `contracts/price-oracle/` with the current SDK
> to get authoritative numbers for a specific deployment target.

### Boundary behaviour

| Input | Effective limit | Behaviour |
|---|---|---|
| `limit = 0` | 100 | Treated as "give me the default maximum" |
| `limit = 1` | 1 | Returns the single most-recent entry |
| `limit = 50` | 50 | Returns the 50 most-recent entries |
| `limit = 100` | 100 | Returns all stored entries (max) |
| `limit = 200` | 100 | Clamped to MAX_HISTORY_LIMIT |
| Empty history | 0 | Returns empty Vec regardless of limit |
| Unknown asset | 0 | Returns empty Vec; no error |

### Recommendations

- Integrators that need "everything" should page with `get_price_history_since`
  using the timestamp of the last entry they received, rather than fetching 100
  entries every poll cycle.
- The ring-buffer write path (`utils::append_history`) already bounds the stored
  vector at `MAX_HISTORY_LEN`, so the maximum deserialize cost is fixed at 100
  entries and will not grow over the contract's lifetime.
