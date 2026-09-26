// On-chain Merkle proof verifier using Soroban's native SHA-256.
//
// Tree construction (mirrors the off-chain TypeScript builder):
//   1. For each BatchPriceEntry, compute leaf = SHA-256(canonical_bytes(entry)).
//   2. If the leaf count is odd, promote the last leaf unchanged to the next
//      level (do NOT duplicate it).  This avoids the ambiguity where the same
//      leaf appears at two tree positions with different valid proofs.
//   3. Build parent nodes: parent = SHA-256(left || right), sorted by
//      position (left child always has lower index).
//   4. Repeat until one root remains.
//
// Proof verification:
//   Given a leaf hash, its index, and the sibling co-path, recompute the root
//   by alternately hashing (leaf, sibling) or (sibling, leaf) based on whether
//   the current index is even (left child) or odd (right child). When a level
//   is odd-length and the verifier is at the last node (no sibling exists),
//   the node is promoted: the current hash becomes the parent directly.
//   The proof is valid iff the recomputed root matches the stored batch root.

use soroban_sdk::{Bytes, Env, String};

use crate::errors::OracleError;
use crate::types::BatchPriceEntry;

// Soroban's String has no direct byte accessor; copy_into_slice requires an
// exact-length buffer. Asset symbols and strkey-encoded addresses must not
// exceed this cap; the submission boundary rejects strings that do.
pub const MAX_STRING_LEN: usize = 64;

/// Maximum co-path length accepted by verify_proof (Issue #385).
pub const MAX_PROOF_SIBLINGS: usize = 64;

/// Validate that a Soroban string fits within MAX_STRING_LEN.
///
/// Call this at every submission boundary so the contract never reaches
/// string_to_bytes with an oversized input.
pub fn validate_string_len(s: &String) -> Result<(), OracleError> {
    if s.len() as usize > MAX_STRING_LEN {
        return Err(OracleError::AssetNameTooLong);
    }
    Ok(())
}

fn string_to_bytes(env: &Env, s: &String) -> Result<Bytes, OracleError> {
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
/// Returns Err(AssetNameTooLong) if asset or source string exceeds MAX_STRING_LEN.
pub fn hash_leaf(env: &Env, entry: &BatchPriceEntry) -> Result<Bytes, OracleError> {
    let mut buf = Bytes::new(env);
    buf.append(&string_to_bytes(env, &entry.asset)?);
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

fn hash_pair(env: &Env, left: &Bytes, right: &Bytes) -> Bytes {
    let mut buf = Bytes::new(env);
    buf.append(left);
    buf.append(right);
    env.crypto().sha256(&buf).into()
}

// -- Proof verification ------------------------------------------------------------

/// Verify inclusion of entry in batch with given root.
///
/// leaf_index >= batch_size returns Err(BatchIndexOutOfRange).
/// Odd-level promotion: last node on an odd-length level is promoted without hashing.
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
