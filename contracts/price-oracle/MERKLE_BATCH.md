# Merkle Tree Batched Price Submissions

## Problem

Each individual `submit_price` call is a separate Soroban transaction that
carries:
- Full source `require_auth()` overhead
- One instance-storage read (`is_authorized_source`)
- One instance-storage write (`LatestPrice`)
- One persistent-storage read + write (`PriceHistory`)

For N assets submitted every polling cycle (default: 5 assets every 30 s),
this means N full transactions with N × auth + storage costs.

## Solution: Merkle Root Commitment + Proof-Based Application

The batch flow replaces N full transactions with:

1. **One `submit_batch` call** — the authorized source commits a single 32-byte
   Merkle root covering all N price entries.  Auth + source check run once.

2. **N `apply_batch_entry` calls** — each call proves inclusion via a Merkle
   proof and applies the single entry.  No auth required; the proof is the
   authorization.

```
Off-chain (aggregator)              On-chain (contract)
─────────────────────────────────   ─────────────────────────────────────
1. Build MerkleTree from N entries
2. Compute root
3. submit_batch(source, nonce, root) ──▶ store root[nonce], nonce++
4. For each entry i:
   apply_batch_entry(nonce, entry_i,  ──▶ verify proof → store price
                     proof_i)
```

## Gas Savings

| N assets | Individual txns | Batch txns | Saving (est.) |
|----------|----------------|------------|---------------|
| 5        | 5              | 6 (1+5)    | ~35% CPU on auth path |
| 10       | 10             | 11 (1+10)  | ~40% CPU on auth path |
| 20       | 20             | 21 (1+20)  | ~45% CPU on auth path |

The saving is largest when N is large because `submit_batch` pays auth cost
once regardless of N, while individual submission pays it N times.

Run the built-in benchmark to measure on your machine:

```bash
cd contracts/price-oracle
cargo test bench_individual_vs_batch --lib -- --nocapture
```

## Merkle Tree Construction

### Leaf encoding

Each `BatchPriceEntry` is hashed as:

```
leaf = SHA-256(
  asset_bytes || 0x00          // null separator prevents length-extension
  || price_be16                // i128 as 16 bytes big-endian
  || decimals_be4              // u32 as 4 bytes big-endian
  || timestamp_be8             // u64 as 8 bytes big-endian
  || source_bytes              // Stellar address as UTF-8
)
```

### Tree structure

- Leaves are ordered by their index in the submitted batch array.
- If the leaf count at any level is odd, the last node is duplicated.
- Parent = SHA-256(left_child || right_child), position-ordered (left = lower index).
- Root = the single node remaining at the top level.

### Inclusion proof

For leaf at index `i`:
- `siblings[0]` = co-sibling at leaf level
- `siblings[k]` = co-sibling at level k
- At each level: if `i % 2 == 0`, hash = SHA-256(current || sibling);
  else hash = SHA-256(sibling || current).  Then `i /= 2`.
- The recomputed hash at the final level must equal the stored root.

## Replay Protection (Issue #385)

Each batch is identified by a monotonically increasing `nonce`:
- `submit_batch` requires `nonce == current_nonce`, so replaying a consumed
  nonce fails with `BatchNonceMismatch`.
- After acceptance, `current_nonce` is incremented.
- Roots are retained for `storage::RETAINED_BATCH_ROOTS` (16) batches and then
  pruned, so batch bookkeeping cannot grow without bound over the contract's
  lifetime.  Applying an entry from a pruned batch fails with
  `BatchRootNotFound`; the aggregator should apply entries promptly after a
  commit rather than deferring them.
- Each (batch, leaf) pair can be applied at most once.  `apply_batch_entry` is
  permissionless (the Merkle proof is the authorization), so without this
  tracker anyone holding a proof could re-apply a leaf repeatedly and pollute
  history with duplicate entries.  A second apply of the same leaf fails with
  `BatchEntryAlreadyApplied`.

## Gas-Based Griefing Bounds (Issue #385)

`apply_batch_entry` is permissionless, so an attacker can force the contract
(and themselves) to pay gas.  The bound per call:

- **Proof depth**: a proof with more than `merkle::MAX_PROOF_SIBLINGS` (64)
  siblings is rejected outright, capping the SHA-256 hashing an attacker can
  make the contract perform in one call (a valid proof for up to 2^63 leaves
  needs at most 63 siblings).
- **Root retention**: only the latest 16 roots are stored, bounding the
  bookkeeping an attacker can interact with.
- **Single-use leaves**: re-applying an already-applied leaf is rejected, so
  history (capped at `MAX_HISTORY_LEN` per asset) cannot be flooded with
  duplicates.
- The attacker always pays the gas for their own calls; the caps above make
  the worst case explicit and prevent unbounded storage growth.

## Files

| File | Description |
|------|-------------|
| `contracts/price-oracle/src/merkle.rs` | On-chain SHA-256 Merkle proof verifier |
| `contracts/price-oracle/src/merkle_test.rs` | Rust tests (20 tests) |
| `contracts/price-oracle/src/contract/submission.rs` | `submit_batch`, `apply_batch_entry`, `verify_batch_proof`, `get_batch_nonce` |
| `contracts/price-oracle/src/types.rs` | `BatchPriceEntry`, `MerkleProof`, `DataKey::BatchRoot/BatchNonce/BatchAppliedLeaves/BatchPruneWatermark` |
| `contracts/price-oracle/src/errors.rs` | `InvalidMerkleProof`, `BatchNonceMismatch`, `BatchRootNotFound`, `BatchEntryAlreadyApplied` |
| `contracts/price-oracle/src/storage.rs` | `get/set_batch_root` + pruning, `get/increment_batch_nonce`, applied-leaf tracker |
| `services/aggregator/src/utils/merkle.ts` | Off-chain Merkle tree builder (mirrors on-chain encoding) |
| `services/aggregator/src/publisher.ts` | `batchSubmit()` method using `MerkleTree.build()` |

## Usage

### On-chain contract entry points

```
submit_batch(source: Address, nonce: u64, root: Bytes) -> Result<u64>
apply_batch_entry(batch_nonce: u64, entry: BatchPriceEntry, proof: MerkleProof) -> Result<PriceDataPoint>
verify_batch_proof(batch_nonce: u64, entry: BatchPriceEntry, proof: MerkleProof) -> bool
get_batch_nonce() -> u64
```

### Off-chain (aggregator)

```typescript
import { MerkleTree, BatchPriceEntry } from './utils/merkle';

const entries: BatchPriceEntry[] = prices.map(p => ({
  asset: p.asset,
  price: BigInt(p.price),
  decimals: p.decimals,
  timestamp: p.timestamp,
  source: keypair.publicKey(),
}));

const batch = MerkleTree.build(entries);
// batch.root    — 32-byte Buffer to submit on-chain
// batch.proofs  — inclusion proof for each entry
```

The `ContractPublisher.batchSubmit()` method handles the full flow automatically.
It falls back to individual `submit_price` calls if `submit_batch` fails.

## Testing

```bash
cd contracts/price-oracle

# All Merkle tests
cargo test merkle --lib

# Benchmark with output
cargo test bench_individual_vs_batch --lib -- --nocapture
```

TypeScript build check:

```bash
cd services/aggregator
npx tsc --noEmit
```
