// Issue #297 — admin-only configuration, treasury, and maintenance operations.
// Every function here first verifies the caller is the contract admin.

use soroban_sdk::{token, Address, Env, String};

use crate::errors::OracleError;
use crate::storage;

pub(crate) fn initialize(env: &Env, admin: &Address) -> Result<(), OracleError> {
    if storage::has_admin(env) {
        return Err(OracleError::AlreadyInitialized);
    }
    storage::set_admin(env, admin);
    storage::set_storage_layout_version(env, 1);
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
    Ok(())
}

// ── Fees and whitelist ───────────────────────────────────────────────────────

pub(crate) fn set_query_fee(env: &Env, fee: i128) {
    let admin = storage::get_admin(env);
    admin.require_auth();
    storage::set_query_fee(env, &fee);
}

pub(crate) fn set_whitelist(env: &Env, addr: &Address, status: bool) {
    let admin = storage::get_admin(env);
    admin.require_auth();
    storage::set_whitelist(env, addr, status);
}

pub(crate) fn withdraw_fees(env: &Env, to: &Address) {
    let admin = storage::get_admin(env);
    admin.require_auth();
    let balance = storage::get_fee_balance(env);
    if balance > 0 {
        storage::set_fee_balance(env, &0);
        let token = token::Client::new(env, to);
        token.transfer(&env.current_contract_address(), to, &balance);
    }
}

// ── Issue #376 — scheduled TTL / rent extension ──────────────────────────────

/// Extend the TTL of every persistent price-history entry plus the shared
/// instance storage entry (Admin, GovernanceConfig, GovernanceProposal,
/// MultiSigConfig) so state never expires between scheduled rent-payment
/// runs. Callable by anyone — it only pays rent and cannot mutate oracle
/// state, so no admin auth is required.
pub(crate) fn extend_storage_ttl(env: &Env) {
    storage::extend_instance_ttl(env);
    let assets = storage::get_all_assets(env);
    for i in 0..assets.len() {
        if let Some(asset) = assets.get(i) {
            storage::extend_price_history_ttl(env, &asset);
        }
    }
}

pub(crate) fn extend_price_history_ttl(env: &Env, asset: &String, threshold: u32, extend_to: u32) {
    storage::extend_price_history_ttl(env, asset, threshold, extend_to);
}

pub(crate) fn extend_instance_ttl(env: &Env, threshold: u32, extend_to: u32) {
    storage::extend_instance_ttl(env, threshold, extend_to);
}
