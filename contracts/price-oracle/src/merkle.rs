// On-chain Merkle proof verifier using Soroban's native SHA-256.
//
// Tree construction (mirrors the off-chain TypeScript builder):
//   1. For each BatchPriceEntry, compute leaf = SHA-256(canonical_bytes(entry)).
//   2. If the leaf count is odd, duplicate the last leaf.
//   3. Build parent nodes: parent = SHA-256(left || right), sorted by
//      position (left child always has lower index).
//   4. Repeat until one root remains.
//
// Proof verification:
//   Given a leaf hash, its index, and the sibling co-path, recompute the root
//   by alternately hashing (leaf, sibling) or (sibling, leaf) based on whether
//   the current index is even (left child) or odd (right child).  The proof is
//   valid iff the recomputed root matches the stored batch root.

use soroban_sdk::{Bytes, Env};

use crate::types::BatchPriceEntry;

// ── Leaf encoding ─────────────────────────────────────────────────────────────

/// Compute the canonical SHA-256 leaf hash for a BatchPriceEntry.
///
/// Encoding (all big-endian, fixed width):
///   [asset bytes (variable)] ++ [0x00 separator]
///   ++ [price  : 16 bytes i128 big-endian]
///   ++ [decimals: 4 bytes u32 big-endian]
///   ++ [timestamp: 8 bytes u64 big-endian]
///   ++ [source: 32-byte Stellar account ID bytes]
///
/// A 0x00 separator after the asset string prevents length-extension attacks
/// where two different (asset, rest) pairs could produce the same byte sequence.
pub fn hash_leaf(env: &Env, entry: &BatchPriceEntry) -> Bytes {
    let mut buf = Bytes::new(env);

    // Asset string bytes
    buf.append(&entry.asset.to_bytes());
    // Separator
    buf.push_back(0x00);
    // price: i128 as 16-byte big-endian
    let price_bytes = entry.price.to_be_bytes();
    buf.append(&Bytes::from_array(env, &price_bytes));
    // decimals: u32 as 4-byte big-endian
    let dec_bytes = entry.decimals.to_be_bytes();
    buf.append(&Bytes::from_array(env, &dec_bytes));
    // timestamp: u64 as 8-byte big-endian
    let ts_bytes = entry.timestamp.to_be_bytes();
    buf.append(&Bytes::from_array(env, &ts_bytes));
    // source address bytes (32 bytes for Stellar public key)
    buf.append(&entry.source.to_string().to_bytes());

    env.crypto().sha256(&buf).into()
}

// ── Node hashing ──────────────────────────────────────────────────────────────

/// Hash two child nodes into a parent node.
/// Left and right are determined by leaf_index parity, not sorted by value,
/// so the tree structure is position-stable.
fn hash_pair(env: &Env, left: &Bytes, right: &Bytes) -> Bytes {
    let mut buf = Bytes::new(env);
    buf.append(left);
    buf.append(right);
    env.crypto().sha256(&buf).into()
}

// ── Proof verification ────────────────────────────────────────────────────────

/// Verify that `entry` is included in the batch whose Merkle root is `root`.
///
/// `leaf_index` is the 0-based position of the entry in the original batch
/// array.  `siblings` are the co-path hashes from leaf level to root level.
///
/// Returns `true` iff the proof is valid.
pub fn verify_proof(
    env: &Env,
    entry: &BatchPriceEntry,
    leaf_index: u32,
    siblings: &soroban_sdk::Vec<Bytes>,
    root: &Bytes,
) -> bool {
    let mut current = hash_leaf(env, entry);
    let mut index = leaf_index;

    for i in 0..siblings.len() {
        let sibling = match siblings.get(i) {
            Some(s) => s,
            None => return false,
        };
        current = if index % 2 == 0 {
            hash_pair(env, &current, &sibling)
        } else {
            hash_pair(env, &sibling, &current)
        };
        index /= 2;
    }

    &current == root
}

// ── Root computation (used for single-entry batch shortcut) ───────────────────

/// Compute the Merkle root for a slice of pre-hashed leaves.
/// Used on-chain when the full leaf set fits in the transaction budget
/// (typically for small batches ≤ 8 entries).
pub fn compute_root(env: &Env, leaves: soroban_sdk::Vec<Bytes>) -> Bytes {
    if leaves.is_empty() {
        return Bytes::new(env);
    }
    if leaves.len() == 1 {
        return leaves.get(0).unwrap();
    }

    let mut current_level = leaves;

    loop {
        let len = current_level.len();
        if len == 1 {
            break;
        }

        let mut next_level: soroban_sdk::Vec<Bytes> = soroban_sdk::Vec::new(env);
        let mut i = 0u32;
        while i < len {
            let left = current_level.get(i).unwrap();
            let right = if i + 1 < len {
                current_level.get(i + 1).unwrap()
            } else {
                left.clone() // duplicate last leaf if odd count
            };
            next_level.push_back(hash_pair(env, &left, &right));
            i += 2;
        }
        current_level = next_level;
    }

    current_level.get(0).unwrap()
}
