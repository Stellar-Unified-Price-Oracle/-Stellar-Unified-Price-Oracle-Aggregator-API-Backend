// Issue #297 — price submission and Merkle batch flow.

use soroban_sdk::{token, Address, Bytes, Env, String};

use crate::errors::OracleError;
use crate::merkle;
use crate::storage;
use crate::types::{BatchPriceEntry, MerkleProof, PriceDataPoint};

use crate::utils;

pub(crate) fn submit_price(
    env: &Env,
    source: &Address,
    asset: &String,
    price: i128,
    decimals: u32,
    timestamp: u64,
) -> Result<PriceDataPoint, OracleError> {
    source.require_auth();

    // Issue #379 — a multi-sig-guarded emergency pause halts submission
    // globally; reads (get_price/get_price_history) remain unaffected so
    // every region keeps serving cached data during the freeze.
    if storage::is_paused(env) {
        return Err(OracleError::ContractPaused);
    }

    if !storage::is_authorized_source(env, source) {
        return Err(OracleError::UnauthorizedSource);
    }
    if price < 0 {
        return Err(OracleError::InvalidPrice);
    }

    // Deviation check: only active when a threshold has been configured and a
    // previous price exists (bypassed for initial submission).
    if let Some(threshold_bps) = storage::get_deviation_threshold(env) {
        if let Some(prev) = storage::get_latest_price(env, asset) {
            if utils::deviation_exceeds(price, prev.price, threshold_bps) {
                return Err(OracleError::PriceDeviationTooLarge);
            }
        }
    }

    let data_point = PriceDataPoint {
        asset: asset.clone(),
        price,
        decimals,
        timestamp,
        source: source.clone(),
    };

    // Update reputation before overwriting latest price so we still have
    // the previous price available for accuracy comparison.
    utils::update_reputation(env, source, price, asset, timestamp);

    storage::set_latest_price(env, asset, &data_point);
    utils::append_history(env, asset, data_point.clone());

    env.events()
        .publish(("price_submitted", asset.clone(), source.clone()), (price, timestamp));

    Ok(data_point)
}

// ── Issue #75 — Merkle batch submission ──────────────────────────────────────

/// Commit a Merkle root covering a batch of price entries.
///
/// The authorized source submits one transaction with the root hash of an
/// ordered batch.  Individual entries are applied later via
/// `apply_batch_entry` using inclusion proofs — one cheap tx per price
/// instead of one full auth+storage tx per price.
///
/// `nonce` must equal the current BatchNonce (prevents replay attacks).
/// Returns the new nonce after this batch.
pub(crate) fn submit_batch(
    env: &Env,
    source: &Address,
    nonce: u64,
    root: &Bytes,
) -> Result<u64, OracleError> {
    source.require_auth();

    // Issue #379 — batch commits are a submission path too and must
    // honor the same global emergency pause as submit_price.
    if storage::is_paused(env) {
        return Err(OracleError::ContractPaused);
    }

    if !storage::is_authorized_source(env, source) {
        return Err(OracleError::UnauthorizedSource);
    }
    if root.len() != 32 {
        return Err(OracleError::InvalidMerkleProof);
    }
    if nonce != storage::get_batch_nonce(env) {
        return Err(OracleError::BatchNonceMismatch);
    }

    storage::set_batch_root(env, nonce, root);
    let new_nonce = storage::increment_batch_nonce(env);

    env.events()
        .publish(("batch_submitted", source.clone()), (nonce, root.clone()));

    Ok(new_nonce)
}

/// Apply a single price entry from an already-committed batch.
///
/// The Merkle proof is verified against the stored root; no additional
/// source auth is required because the root was already committed by an
/// authorized source.  Anyone can submit proofs — the cryptographic proof
/// is the authorization.
pub(crate) fn apply_batch_entry(
    env: &Env,
    batch_nonce: u64,
    entry: &BatchPriceEntry,
    proof: &MerkleProof,
) -> Result<PriceDataPoint, OracleError> {
    let root = storage::get_batch_root(env, batch_nonce).ok_or(OracleError::BatchRootNotFound)?;

    if entry.price < 0 {
        return Err(OracleError::InvalidPrice);
    }

    if !merkle::verify_proof(env, entry, proof.leaf_index, &proof.siblings, &root) {
        return Err(OracleError::InvalidMerkleProof);
    }

    // Issue #385 — each (batch, leaf) pair can be applied exactly once; a
    // repeated apply of an already-applied leaf fails with
    // BatchEntryAlreadyApplied instead of writing a duplicate history entry.
    storage::mark_batch_leaf_applied(env, batch_nonce, proof.leaf_index)?;

    let data_point = PriceDataPoint {
        asset: entry.asset.clone(),
        price: entry.price,
        decimals: entry.decimals,
        timestamp: entry.timestamp,
        source: entry.source.clone(),
    };

    storage::set_latest_price(env, &entry.asset, &data_point);
    utils::append_history(env, &entry.asset, data_point.clone());

    env.events().publish(
        ("batch_entry_applied", entry.asset.clone()),
        (batch_nonce, entry.price),
    );

    Ok(data_point)
}

pub(crate) fn get_batch_nonce(env: &Env) -> u64 {
    storage::get_batch_nonce(env)
}

/// Read-only inclusion check used by off-chain tooling and tests.
pub(crate) fn verify_batch_proof(
    env: &Env,
    batch_nonce: u64,
    entry: &BatchPriceEntry,
    proof: &MerkleProof,
) -> bool {
    let Some(root) = storage::get_batch_root(env, batch_nonce) else {
        return false;
    };
    merkle::verify_proof(env, entry, proof.leaf_index, &proof.siblings, &root)
}

// ── Staking / slashing ───────────────────────────────────────────────────────

pub(crate) fn stake(env: &Env, source: &Address, amount: i128, token: &Address) {
    source.require_auth();
    let token_client = token::Client::new(env, token);
    token_client.transfer(source, &env.current_contract_address(), &amount);
    let current = storage::get_stake(env, source);
    storage::set_stake(env, source, &(current + amount));
    env.events().publish(("source_staked", source.clone()), amount);
}

pub(crate) fn slash(env: &Env, source: &Address, amount: i128, reason: &String) {
    let admin = storage::get_admin(env);
    admin.require_auth();
    let current = storage::get_stake(env, source);
    let slashed = if amount > current { current } else { amount };
    storage::set_stake(env, source, &(current - slashed));
    let count = storage::get_slash_count(env, source);
    storage::set_slash_count(env, source, &(count + 1));
    env.events()
        .publish(("source_slashed", source.clone(), reason.clone()), slashed);
}

pub(crate) fn get_stake_balance(env: &Env, source: &Address) -> i128 {
    storage::get_stake(env, source)
}
