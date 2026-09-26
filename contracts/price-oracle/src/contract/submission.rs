// Issue #297 — price submission and Merkle batch flow.

use soroban_sdk::{token, Address, Bytes, Env, String};

use crate::errors::OracleError;
use crate::events::{BatchEntryApplied, BatchSubmitted, PriceSubmitted, SourceSlashed, SourceStaked};
use crate::merkle;
use crate::storage;
use crate::types::{BatchPriceEntry, MerkleProof, PriceDataPoint};

use crate::utils;

// Issue #569 — maximum supported price decimals scale
pub const MAX_DECIMALS: u32 = 18;

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
    // Issue #569 — validate decimals range and prevent un-governed scale changes
    if decimals > MAX_DECIMALS {
        return Err(OracleError::InvalidDecimals);
    }
    if let Some(prev) = storage::get_latest_price(env, asset) {
        if prev.decimals != decimals {
            return Err(OracleError::InvalidDecimals);
        }
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

    PriceSubmitted {
        asset: asset.clone(),
        source: source.clone(),
        price,
        timestamp,
    }
    .publish(env);

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
    // Issue #379 — this is a submission path, not a read.  The emergency pause
    // is what stops prices being written during an incident, and this entrypoint
    // is permissionless (the Merkle proof is the authorization), so without the
    // check here the pause could be stepped around entirely by anyone holding a
    // proof for a batch that was committed before the freeze.
    if storage::is_paused(env) {
        return Err(OracleError::ContractPaused);
    }

    let root = storage::get_batch_root(env, batch_nonce).ok_or(OracleError::BatchRootNotFound)?;

    if entry.price < 0 {
        return Err(OracleError::InvalidPrice);
    }

    // Issue #569 — validate decimals range and prevent un-governed scale changes
    if entry.decimals > MAX_DECIMALS {
        return Err(OracleError::InvalidDecimals);
    }
    if let Some(prev) = storage::get_latest_price(env, &entry.asset) {
        if prev.decimals != entry.decimals {
            return Err(OracleError::InvalidDecimals);
        }
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

    // A source's stake is denominated in exactly one token.  Letting a second
    // token top up the same `StakeInfo` counter would make the counter
    // meaningless — and later `slash` would transfer from whichever token
    // happened to be recorded first.
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

/// Confiscate part of a source's stake and move the tokens to the treasury.
///
/// The accounting and the ledger have to move together: the counter is only
/// decremented once the transfer has succeeded, so a failed transfer leaves
/// the recorded stake untouched rather than reporting a slash that never
/// happened.
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

    // Without the recorded token there is no way to know which asset to move.
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
