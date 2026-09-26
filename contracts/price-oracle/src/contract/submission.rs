// Issue #297 - price submission and Merkle batch flow.

use soroban_sdk::{token, Address, Bytes, Env, String};

use crate::errors::OracleError;
use crate::events::{BatchEntryApplied, BatchSubmitted, PriceSubmitted, SourceSlashed, SourceStaked};
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

    if storage::is_paused(env) {
        return Err(OracleError::ContractPaused);
    }

    if !storage::is_authorized_source(env, source) {
        return Err(OracleError::UnauthorizedSource);
    }
    if price < 0 {
        return Err(OracleError::InvalidPrice);
    }

    // Issue #568 - validate asset string length at the submission boundary.
    merkle::validate_string_len(asset)?;

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

    utils::update_reputation(env, source, price, asset, timestamp);

    storage::set_latest_price(env, asset, &data_point);
    utils::append_history(env, asset, data_point.clone());

    PriceSubmitted {
        asset: asset.clone(),
        source: source.clone(),
        price,
        timestamp,
    }
    .publish(env);

    Ok(data_point)
}

// -- Merkle batch submission -----------------------------------------------------------------------

/// Commit a Merkle root covering a batch of price entries.
///
/// Issue #567 - batch_size is committed alongside the root so apply_batch_entry
/// can enforce leaf_index < batch_size and reject the phantom duplicate-last slot.
pub(crate) fn submit_batch(
    env: &Env,
    source: &Address,
    nonce: u64,
    root: &Bytes,
    batch_size: u32,
) -> Result<u64, OracleError> {
    source.require_auth();

    if storage::is_paused(env) {
        return Err(OracleError::ContractPaused);
    }

    if !storage::is_authorized_source(env, source) {
        return Err(OracleError::UnauthorizedSource);
    }
    if root.len() != 32 {
        return Err(OracleError::InvalidMerkleProof);
    }
    if batch_size == 0 {
        return Err(OracleError::InvalidMerkleProof);
    }
    if nonce != storage::get_batch_nonce(env) {
        return Err(OracleError::BatchNonceMismatch);
    }

    storage::set_batch_root(env, nonce, root);
    storage::set_batch_size(env, nonce, batch_size);
    let new_nonce = storage::increment_batch_nonce(env);

    BatchSubmitted {
        source: source.clone(),
        nonce,
        root: root.clone(),
    }
    .publish(env);

    Ok(new_nonce)
}

/// Apply a single price entry from an already-committed batch.
///
/// Issue #570 - deviation threshold and reputation tracking applied here
/// so the batch path has the same guardrails as submit_price.
/// Issue #567 - batch_size retrieved and enforced via verify_proof.
/// Issue #568 - entry asset string validated before hashing.
pub(crate) fn apply_batch_entry(
    env: &Env,
    batch_nonce: u64,
    entry: &BatchPriceEntry,
    proof: &MerkleProof,
) -> Result<PriceDataPoint, OracleError> {
    if storage::is_paused(env) {
        return Err(OracleError::ContractPaused);
    }

    // Issue #568 - validate before hashing to prevent panic in permissionless path.
    merkle::validate_string_len(&entry.asset)?;

    let root = storage::get_batch_root(env, batch_nonce).ok_or(OracleError::BatchRootNotFound)?;
    let batch_size = storage::get_batch_size(env, batch_nonce).ok_or(OracleError::BatchRootNotFound)?;

    if entry.price < 0 {
        return Err(OracleError::InvalidPrice);
    }

    // Issue #570 - deviation check mirrors submit_price.
    if let Some(threshold_bps) = storage::get_deviation_threshold(env) {
        if let Some(prev) = storage::get_latest_price(env, &entry.asset) {
            if utils::deviation_exceeds(entry.price, prev.price, threshold_bps) {
                return Err(OracleError::PriceDeviationTooLarge);
            }
        }
    }

    if !merkle::verify_proof(env, entry, proof.leaf_index, batch_size, &proof.siblings, &root)? {
        return Err(OracleError::InvalidMerkleProof);
    }

    storage::mark_batch_leaf_applied(env, batch_nonce, proof.leaf_index)?;

    let data_point = PriceDataPoint {
        asset: entry.asset.clone(),
        price: entry.price,
        decimals: entry.decimals,
        timestamp: entry.timestamp,
        source: entry.source.clone(),
    };

    // Issue #570 - reputation tracked for batch path.
    utils::update_reputation(env, &entry.source, entry.price, &entry.asset, entry.timestamp);

    storage::set_latest_price(env, &entry.asset, &data_point);
    utils::append_history(env, &entry.asset, data_point.clone());

    BatchEntryApplied {
        asset: entry.asset.clone(),
        batch_nonce,
        price: entry.price,
    }
    .publish(env);

    Ok(data_point)
}

pub(crate) fn get_batch_nonce(env: &Env) -> u64 {
    storage::get_batch_nonce(env)
}

pub(crate) fn verify_batch_proof(
    env: &Env,
    batch_nonce: u64,
    entry: &BatchPriceEntry,
    proof: &MerkleProof,
) -> bool {
    let Some(root) = storage::get_batch_root(env, batch_nonce) else {
        return false;
    };
    let Some(batch_size) = storage::get_batch_size(env, batch_nonce) else {
        return false;
    };
    merkle::verify_proof(env, entry, proof.leaf_index, batch_size, &proof.siblings, &root)
        .unwrap_or(false)
}

// -- Staking / slashing -----------------------------------------------------------------------

pub(crate) fn stake(
    env: &Env,
    source: &Address,
    amount: i128,
    token: &Address,
) -> Result<(), OracleError> {
    source.require_auth();

    if amount <= 0 {
        return Err(OracleError::InvalidStakeAmount);
    }

    if let Some(recorded) = storage::get_stake_token(env, source) {
        if recorded != *token {
            return Err(OracleError::StakeTokenMismatch);
        }
    }

    let token_client = token::Client::new(env, token);
    token_client.transfer(source, &env.current_contract_address(), &amount);

    storage::set_stake_token(env, source, token);
    let current = storage::get_stake(env, source);
    storage::set_stake(env, source, &(current + amount));

    SourceStaked {
        source: source.clone(),
        amount,
    }
    .publish(env);

    Ok(())
}

pub(crate) fn slash(
    env: &Env,
    source: &Address,
    amount: i128,
    reason: &String,
) -> Result<(), OracleError> {
    let admin = storage::get_admin(env);
    admin.require_auth();

    if amount <= 0 {
        return Err(OracleError::InvalidSlashAmount);
    }

    let current = storage::get_stake(env, source);
    if current <= 0 {
        return Err(OracleError::NoStakeToSlash);
    }

    let token = storage::get_stake_token(env, source).ok_or(OracleError::StakeTokenNotRecorded)?;
    let treasury = storage::get_stake_treasury(env).ok_or(OracleError::TreasuryNotConfigured)?;

    let slashed = if amount > current { current } else { amount };

    let token_client = token::Client::new(env, &token);
    token_client.transfer(&env.current_contract_address(), &treasury, &slashed);

    storage::set_stake(env, source, &(current - slashed));
    let count = storage::get_slash_count(env, source);
    storage::set_slash_count(env, source, &(count + 1));

    SourceSlashed {
        source: source.clone(),
        reason: reason.clone(),
        slashed,
    }
    .publish(env);

    Ok(())
}

pub(crate) fn get_stake_balance(env: &Env, source: &Address) -> i128 {
    storage::get_stake(env, source)
}
