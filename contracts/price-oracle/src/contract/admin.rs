// Issue #297 — admin-only configuration, treasury, and maintenance operations.
// Every function here first verifies the caller is the contract admin.
//
// Fixes applied here:
//   #559 — withdraw_fees now uses an explicit FeeToken config instead of the
//           recipient address; balance is only zeroed after a successful
//           transfer; function returns Result<(), OracleError>.
//   #560 — set_query_fee, set_whitelist, and withdraw_fees now accept an
//           explicit `admin` parameter, call storage::verify_admin, and
//           return Result<(), OracleError> so rejection surfaces an error code.

use soroban_sdk::{token, Address, BytesN, Env, String};

use crate::errors::OracleError;
use crate::events::{
    AdminTransferAccepted, AdminTransferCancelled, AdminTransferProposed, DeviationThresholdSet,
    FeedPaused, FeedUnpaused, ReputationReset, SourceAdded, SourceRemoved, StakeTreasurySet,
    TrustedAssetSet, WritePathPaused, WritePathUnpaused,
};
use crate::storage;
use crate::types::FeedCatalogCommitment;

pub(crate) fn initialize(env: &Env, admin: &Address) -> Result<(), OracleError> {
    if storage::has_admin(env) {
        return Err(OracleError::AlreadyInitialized);
    }
    storage::set_admin(env, admin);
    storage::set_storage_layout_version(env, 1);
    Ok(())
}

// ── Issue #565 — Two-step admin handover ─────────────────────────────────────

pub(crate) fn propose_admin(
    env: &Env,
    admin: &Address,
    new_admin: &Address,
) -> Result<(), OracleError> {
    admin.require_auth();
    storage::verify_admin(env, admin)?;
    let now = env.ledger().timestamp();
    let deadline = now + storage::ADMIN_TRANSFER_WINDOW_SECONDS;
    storage::set_pending_admin(env, new_admin, deadline);
    AdminTransferProposed {
        current_admin: admin.clone(),
        pending_admin: new_admin.clone(),
        deadline,
    }
    .publish(env);
    Ok(())
}

pub(crate) fn accept_admin(
    env: &Env,
    new_admin: &Address,
) -> Result<(), OracleError> {
    new_admin.require_auth();
    let (pending, _deadline) =
        storage::get_pending_admin(env).ok_or(OracleError::NoPendingAdmin)?;
    if &pending != new_admin {
        return Err(OracleError::AdminOnly);
    }
    let old_admin = storage::get_admin(env);
    storage::set_admin(env, new_admin);
    storage::clear_pending_admin(env);
    AdminTransferAccepted {
        old_admin,
        new_admin: new_admin.clone(),
        timestamp: env.ledger().timestamp(),
    }
    .publish(env);
    Ok(())
}

pub(crate) fn cancel_admin_transfer(
    env: &Env,
    admin: &Address,
) -> Result<(), OracleError> {
    admin.require_auth();
    storage::verify_admin(env, admin)?;
    let (pending, deadline) =
        storage::get_pending_admin(env).ok_or(OracleError::NoPendingAdmin)?;
    let now = env.ledger().timestamp();
    if now > deadline {
        return Err(OracleError::AdminTransferWindowElapsed);
    }
    storage::clear_pending_admin(env);
    AdminTransferCancelled {
        admin: admin.clone(),
        pending_admin: pending,
        timestamp: now,
    }
    .publish(env);
    Ok(())
}

// ── Issue #69 — deviation threshold ──────────────────────────────────────────

pub(crate) fn set_deviation_threshold(
    env: &Env,
    admin: &Address,
    threshold_bps: u32,
) -> Result<(), OracleError> {
    admin.require_auth();
    storage::verify_admin(env, admin)?;
    storage::set_deviation_threshold(env, threshold_bps);
    DeviationThresholdSet { threshold_bps }.publish(env);
    Ok(())
}

// ── Issue #70 — reputation reset ─────────────────────────────────────────────

pub(crate) fn reset_reputation(
    env: &Env,
    admin: &Address,
    source: &Address,
) -> Result<(), OracleError> {
    admin.require_auth();
    storage::verify_admin(env, admin)?;
    storage::remove_source_reputation(env, source);
    ReputationReset {
        source: source.clone(),
    }
    .publish(env);
    Ok(())
}

// ── Oracle source management ─────────────────────────────────────────────────

pub(crate) fn add_oracle_source(
    env: &Env,
    admin: &Address,
    source: &Address,
    name: &String,
) -> Result<(), OracleError> {
    admin.require_auth();
    storage::verify_admin(env, admin)?;
    storage::add_source(env, source, name);
    SourceAdded {
        source: source.clone(),
        name: name.clone(),
    }
    .publish(env);
    Ok(())
}

pub(crate) fn remove_oracle_source(
    env: &Env,
    admin: &Address,
    source: &Address,
) -> Result<(), OracleError> {
    admin.require_auth();
    storage::verify_admin(env, admin)?;
    storage::remove_source(env, source);
    SourceRemoved {
        source: source.clone(),
    }
    .publish(env);
    Ok(())
}

pub(crate) fn set_trusted_asset(
    env: &Env,
    admin: &Address,
    asset: &String,
    trusted: bool,
) -> Result<(), OracleError> {
    admin.require_auth();
    storage::verify_admin(env, admin)?;
    storage::set_trusted_asset(env, asset, trusted);
    TrustedAssetSet {
        asset: asset.clone(),
        trusted,
    }
    .publish(env);
    Ok(())
}

// ── Slashed-stake treasury ───────────────────────────────────────────────────

/// Set the destination for slashed stake. `slash` requires this to be
/// configured: confiscated tokens have to go somewhere an admin chose.
pub(crate) fn set_stake_treasury(
    env: &Env,
    admin: &Address,
    treasury: &Address,
) -> Result<(), OracleError> {
    admin.require_auth();
    storage::verify_admin(env, admin)?;
    storage::set_stake_treasury(env, treasury);
    StakeTreasurySet {
        treasury: treasury.clone(),
    }
    .publish(env);
    Ok(())
}

// ── Fees and whitelist ───────────────────────────────────────────────────────

/// Configure the SEP-41 token whose collected fees are held in this contract
/// and paid out via `withdraw_fees`.  Must be called before any fee withdrawal.
/// (#559)
pub(crate) fn set_fee_token(
    env: &Env,
    admin: &Address,
    token: &Address,
) -> Result<(), OracleError> {
    admin.require_auth();
    storage::verify_admin(env, admin)?;
    storage::set_fee_token(env, token);
    Ok(())
}

/// Return the configured fee token address, or None if not yet set. (#559)
pub(crate) fn get_fee_token(env: &Env) -> Option<Address> {
    storage::get_fee_token(env)
}

/// Return the current accumulated fee balance. (#559)
pub(crate) fn get_fee_balance(env: &Env) -> i128 {
    storage::get_fee_balance(env)
}

/// Set the per-query fee.
/// (#560 — takes an explicit `admin` parameter, verifies caller, returns Result)
pub(crate) fn set_query_fee(
    env: &Env,
    admin: &Address,
    fee: i128,
) -> Result<(), OracleError> {
    admin.require_auth();
    storage::verify_admin(env, admin)?;
    storage::set_query_fee(env, &fee);
    QueryFeeSet {
        admin: admin.clone(),
        fee,
    }
    .publish(env);
    Ok(())
}

/// Toggle whitelist status for an address.
/// (#560 — takes an explicit `admin` parameter, verifies caller, returns Result)
pub(crate) fn set_whitelist(
    env: &Env,
    admin: &Address,
    addr: &Address,
    status: bool,
) -> Result<(), OracleError> {
    admin.require_auth();
    storage::verify_admin(env, admin)?;
    storage::set_whitelist(env, addr, status);
    WhitelistUpdated {
        admin: admin.clone(),
        addr: addr.clone(),
        status,
    }
    .publish(env);
    Ok(())
}

/// Transfer the accumulated fee balance to `to` using the explicitly
/// configured fee token.
///
/// - Resolves the fee token from storage, not from the `to` argument (#559).
/// - Only zeroes FeeBalance after the transfer succeeds (#559).
/// - Requires explicit `admin` parameter and verify_admin (#560).
/// - Returns Result<(), OracleError> (#559, #560).
/// - Emits FeesWithdrawn (#559).
pub(crate) fn withdraw_fees(
    env: &Env,
    admin: &Address,
    to: &Address,
) -> Result<(), OracleError> {
    admin.require_auth();
    storage::verify_admin(env, admin)?;

    let fee_token = storage::get_fee_token(env).ok_or(OracleError::FeeTokenNotConfigured)?;
    let balance = storage::get_fee_balance(env);
    if balance > 0 {
        let token_client = token::Client::new(env, &fee_token);
        token_client.transfer(&env.current_contract_address(), to, &balance);
        // Only zero the balance after a successful transfer.
        storage::set_fee_balance(env, &0);
        FeesWithdrawn {
            recipient: to.clone(),
            token: fee_token,
            amount: balance,
        }
        .publish(env);
    }
    Ok(())
}

// ── Issue #376 & Issue #572 — scheduled TTL / rent extension ─────────────────

/// Extend the TTL of every persistent price-history entry plus the shared
/// instance storage entry (Admin, GovernanceConfig, GovernanceProposal,
/// MultiSigConfig) so state never expires between scheduled rent-payment
/// runs. Callable by anyone — it only pays rent and cannot mutate oracle
/// state, so no admin auth is required.
pub(crate) fn extend_storage_ttl(env: &Env) {
    storage::extend_instance_ttl_default(env);
    let assets = storage::get_all_assets(env);
    for i in 0..assets.len() {
        if let Some(asset) = assets.get(i) {
            storage::extend_price_history_ttl_default(env, &asset);
        }
    }
}

pub(crate) fn extend_price_history_ttl(
    env: &Env,
    caller: &Address,
    asset: &String,
    threshold: u32,
    extend_to: u32,
) -> Result<(), OracleError> {
    storage::extend_price_history_ttl(env, caller, asset, threshold, extend_to)
}

pub(crate) fn extend_instance_ttl(
    env: &Env,
    caller: &Address,
    threshold: u32,
    extend_to: u32,
) -> Result<(), OracleError> {
    storage::extend_instance_ttl(env, caller, threshold, extend_to)
}

// ── Issue #731 — selective pause / safe recovery ─────────────────────────────
//
// Pausing is deliberately scoped: a feed pause only blocks submissions for the
// named asset, and a write-path pause only blocks the named write entry point.
// Recovery is symmetric and idempotent so an operator can re-run an unpause
// without side effects. Unpausing one component never clears unrelated pauses.

/// Pause submissions for a single feed (asset). Other feeds and unrelated
/// write paths remain fully operational.
pub(crate) fn pause_feed(
    env: &Env,
    admin: &Address,
    asset: &String,
    reason: &String,
) -> Result<(), OracleError> {
    admin.require_auth();
    storage::verify_admin(env, admin)?;
    storage::set_feed_paused(env, asset, true);
    FeedPaused {
        admin: admin.clone(),
        asset: asset.clone(),
        reason: reason.clone(),
        timestamp: env.ledger().timestamp(),
    }
    .publish(env);
    Ok(())
}

/// Resume a previously paused feed. Idempotent: unpausing an active feed is a
/// no-op that still emits the recovery event for auditability. Does not touch
/// any other feed or write-path pause.
pub(crate) fn unpause_feed(
    env: &Env,
    admin: &Address,
    asset: &String,
) -> Result<(), OracleError> {
    admin.require_auth();
    storage::verify_admin(env, admin)?;
    storage::set_feed_paused(env, asset, false);
    FeedUnpaused {
        admin: admin.clone(),
        asset: asset.clone(),
        timestamp: env.ledger().timestamp(),
    }
    .publish(env);
    Ok(())
}

/// Pause a single named write path (e.g. a specific mutating entry point).
/// Unrelated write paths and read paths are unaffected.
pub(crate) fn pause_write_path(
    env: &Env,
    admin: &Address,
    path: &String,
    reason: &String,
) -> Result<(), OracleError> {
    admin.require_auth();
    storage::verify_admin(env, admin)?;
    storage::set_write_path_paused(env, path, true);
    WritePathPaused {
        admin: admin.clone(),
        path: path.clone(),
        reason: reason.clone(),
        timestamp: env.ledger().timestamp(),
    }
    .publish(env);
    Ok(())
}

/// Resume a single named write path. Idempotent and scoped: it never enables
/// unrelated write paths that were paused separately.
pub(crate) fn unpause_write_path(
    env: &Env,
    admin: &Address,
    path: &String,
) -> Result<(), OracleError> {
    admin.require_auth();
    storage::verify_admin(env, admin)?;
    storage::set_write_path_paused(env, path, false);
    WritePathUnpaused {
        admin: admin.clone(),
        path: path.clone(),
        timestamp: env.ledger().timestamp(),
    }
    .publish(env);
    Ok(())
}
