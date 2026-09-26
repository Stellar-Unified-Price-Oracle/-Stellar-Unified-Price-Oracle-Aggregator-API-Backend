// On-chain Merkle proof verifier using Soroban's native SHA-256 with RFC 6962 domain separation.
//
// Domain separation (Issue #566):
//   To prevent second-preimage attacks where an internal node can be presented
//   as a leaf, leaf hashes and internal node hashes are prefixed with distinct
//   1-byte domain separation tags:
//     - Leaves:        0x00 (LEAF_DOMAIN_TAG)
//     - Internal nodes: 0x01 (NODE_DOMAIN_TAG)
//
// Tree construction (mirrors off-chain TypeScript MerkleTree builder in services/aggregator):
//   1. For each BatchPriceEntry, compute leaf = SHA-256(0x00 || canonical_bytes(entry)).
//   2. If the leaf count is odd, duplicate the last leaf.
//   3. Build parent nodes: parent = SHA-256(0x01 || left || right), sorted by
//      position (left child always has lower index).
//   4. Repeat until one root remains.
//
// Proof verification:
//   Given a leaf entry, its index, and sibling co-path, recompute the root
//   by hashing leaf with 0x00 tag, then iteratively hashing with siblings
//   using the 0x01 node tag based on index parity. The proof is valid iff
//   the recomputed root matches the stored batch root.

use soroban_sdk::{Bytes, Env, String};

use crate::errors::OracleError;
use crate::types::BatchPriceEntry;

// Soroban's `String` has no direct byte accessor; `copy_into_slice` requires an
// exact-length buffer. Asset symbols and strkey-encoded addresses are always
// well under this cap in practice.
const MAX_STRING_LEN: usize = 64;

/// Maximum co-path length accepted by verify_proof (Issue #385).
pub const MAX_PROOF_SIBLINGS: usize = 64;

/// Domain separation tag for leaf hashes (RFC 6962 / NIST SP 800-108 pattern).
pub const LEAF_DOMAIN_TAG: u8 = 0x00;

/// Domain separation tag for internal node hashes.
pub const NODE_DOMAIN_TAG: u8 = 0x01;

fn string_to_bytes(env: &Env, s: &String) -> Bytes {
    let len = s.len() as usize;
    if len > MAX_STRING_LEN {
        return Err(OracleError::AssetNameTooLong);
    }
    let mut buf = [0u8; MAX_STRING_LEN];
    s.copy_into_slice(&mut buf[..len]);
    Ok(Bytes::from_slice(env, &buf[..len]))
}

// -- Leaf encoding -----------------------------------------------------------------

/// Compute the canonical SHA-256 leaf hash for a BatchPriceEntry.
///
/// Encoding (all big-endian, fixed width):
///   [0x00 domain tag]
///   ++ [asset bytes (variable)] ++ [0x00 separator]
///   ++ [price  : 16 bytes i128 big-endian]
///   ++ [decimals: 4 bytes u32 big-endian]
///   ++ [timestamp: 8 bytes u64 big-endian]
///   ++ [source: 32-byte Stellar account ID bytes]
///
/// A 0x00 domain tag prefix distinguishes leaf hashes from internal node hashes (Issue #566).
/// A 0x00 separator after the asset string prevents length-extension attacks
/// where two different (asset, rest) pairs could produce the same byte sequence.
pub fn hash_leaf(env: &Env, entry: &BatchPriceEntry) -> Bytes {
    let mut buf = Bytes::new(env);

    // Leaf domain separation tag (Issue #566)
    buf.push_back(LEAF_DOMAIN_TAG);

    // Asset string bytes
    buf.append(&string_to_bytes(env, &entry.asset));
    // Separator
    buf.push_back(0x00);
    let price_bytes = entry.price.to_be_bytes();
    buf.append(&Bytes::from_array(env, &price_bytes));
    let dec_bytes = entry.decimals.to_be_bytes();
    buf.append(&Bytes::from_array(env, &dec_bytes));
    let ts_bytes = entry.timestamp.to_be_bytes();
    buf.append(&Bytes::from_array(env, &ts_bytes));
    buf.append(&string_to_bytes(env, &entry.source.to_string())?);
    Ok(env.crypto().sha256(&buf).into())
}

// -- Node hashing ------------------------------------------------------------------

/// Hash two child nodes into a parent node.
/// Prefixed with 0x01 domain separation tag (Issue #566).
/// Left and right are determined by leaf_index parity, not sorted by value,
/// so the tree structure is position-stable.
fn hash_pair(env: &Env, left: &Bytes, right: &Bytes) -> Bytes {
    let mut buf = Bytes::new(env);
    // Node domain separation tag (Issue #566)
    buf.push_back(NODE_DOMAIN_TAG);
    buf.append(left);
    buf.append(right);
    env.crypto().sha256(&buf).into()
}

// -- Proof verification ------------------------------------------------------------

/// Verify inclusion of entry in batch with given root.
///
/// `leaf_index` is the 0-based position of the entry in the original batch
/// array. `siblings` are the co-path hashes from leaf level to root level.
///
/// Returns `true` iff the proof is valid.
pub fn verify_proof(
    env: &Env,
    entry: &BatchPriceEntry,
    leaf_index: u32,
    batch_size: u32,
    siblings: &soroban_sdk::Vec<Bytes>,
    root: &Bytes,
) -> Result<bool, OracleError> {
    if siblings.len() as usize > MAX_PROOF_SIBLINGS {
        return Ok(false);
    }
    if leaf_index >= batch_size {
        return Err(OracleError::BatchIndexOutOfRange);
    }
    let mut current = hash_leaf(env, entry)?;
    let mut index = leaf_index;
    let mut level_size = batch_size;
    let mut sibling_cursor = 0u32;
    while level_size > 1 {
        let is_last = index == level_size - 1;
        let is_odd_level = level_size % 2 == 1;
        if is_last && is_odd_level {
            // Promote: no sibling, carry current up unchanged.
        } else {
            let sibling = match siblings.get(sibling_cursor) {
                Some(s) => s,
                None => return Ok(false),
            };
            sibling_cursor += 1;
            current = if index % 2 == 0 {
                hash_pair(env, &current, &sibling)
            } else {
                hash_pair(env, &sibling, &current)
            };
        }
        index /= 2;
        level_size = (level_size + 1) / 2;
    }
    Ok(&current == root)
}

// -- Root computation --------------------------------------------------------------

/// Compute the Merkle root for a slice of pre-hashed leaves.
/// Odd-level rule: last node is promoted, not duplicated.
#[allow(dead_code)]
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
        if len == 1 { break; }
        let mut next_level: soroban_sdk::Vec<Bytes> = soroban_sdk::Vec::new(env);
        let mut i = 0u32;
        while i < len {
            let left = current_level.get(i).unwrap();
            if i + 1 < len {
                let right = current_level.get(i + 1).unwrap();
                next_level.push_back(hash_pair(env, &left, &right));
                i += 2;
            } else {
                next_level.push_back(left);
                i += 1;
            }
        }
        current_level = next_level;
    }
    current_level.get(0).unwrap()
}
