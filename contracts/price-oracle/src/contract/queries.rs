// Issue #297 — read-only queries.  No function here mutates storage.

use soroban_sdk::{Address, Env, String, Vec};

use crate::errors::OracleError;
use crate::storage;
use crate::types::{AssetPrice, PriceDataPoint, SourceReputation};

use crate::utils;

// Issue #561 — the whitelist is a fee-exempt consumer allowlist.
// get_price enforces it when a non-zero query fee is configured:
// callers on the whitelist bypass the fee; all others are rejected with
// NotWhitelisted when fee > 0.  A query fee of zero means the endpoint is
// open to everyone, preserving existing behaviour for deployments that have
// not configured a fee.
pub(crate) fn get_price(
    env: &Env,
    caller: &Address,
    asset: &String,
) -> Result<Option<AssetPrice>, OracleError> {
    let fee = storage::get_query_fee(env);
    if fee > 0 && !storage::is_whitelisted(env, caller) {
        return Err(OracleError::NotWhitelisted);
    }

    let data_point = match storage::get_latest_price(env, asset) {
        Some(dp) => dp,
        None => return Ok(None),
    };
    let num_sources = storage::get_source_count(env);
    let is_trusted = storage::is_trusted_asset(env, asset);

    let price_usd =
        utils::calculate_usd_price(env, &data_point.asset, data_point.price, data_point.decimals);

    Ok(Some(AssetPrice {
        asset: data_point.asset,
        price: data_point.price,
        decimals: data_point.decimals,
        price_usd,
        timestamp: data_point.timestamp,
        source: data_point.source,
        num_sources,
        is_trusted,
    }))
}

pub(crate) fn get_assets(env: &Env) -> Vec<String> {
    storage::get_all_assets(env)
}

// Issue #561 — expose the whitelist state so operators can verify what they configured.
pub(crate) fn is_whitelisted(env: &Env, addr: &Address) -> bool {
    storage::is_whitelisted(env, addr)
}

// Issue #571 — get_price_history with a clamped, documented limit.
//
// MAX_HISTORY_LIMIT caps the entries a single call can return and equals
// MAX_HISTORY_LEN (100), the ring-buffer cap.  Callers that pass limit = 0
// receive MAX_HISTORY_LIMIT entries ("give me as many as allowed").
// Callers that pass limit > MAX_HISTORY_LIMIT also receive MAX_HISTORY_LIMIT
// entries; the effective limit is always ≤ MAX_HISTORY_LIMIT.
pub(crate) const MAX_HISTORY_LIMIT: u32 = storage::MAX_HISTORY_LEN;

pub(crate) fn get_price_history(env: &Env, asset: &String, limit: u32) -> Vec<PriceDataPoint> {
    let effective = if limit == 0 || limit > MAX_HISTORY_LIMIT {
        MAX_HISTORY_LIMIT
    } else {
        limit
    };

    let all_history = storage::get_price_history(env, asset);
    let len = all_history.len();
    let start = if len > effective { len - effective } else { 0 };
    let mut result: Vec<PriceDataPoint> = Vec::new(env);
    for i in start..len {
        if let Some(dp) = all_history.get(i) {
            result.push_back(dp);
        }
    }
    result
}

// Issue #571 — time-bounded history query.
//
// Returns up to `limit` (clamped to MAX_HISTORY_LIMIT) entries whose
// `timestamp` is ≥ `since_timestamp`.  Enables consumers to ask for
// "everything since T" without over-fetching and client-side filtering.
pub(crate) fn get_price_history_since(
    env: &Env,
    asset: &String,
    since_timestamp: u64,
    limit: u32,
) -> Vec<PriceDataPoint> {
    let effective = if limit == 0 || limit > MAX_HISTORY_LIMIT {
        MAX_HISTORY_LIMIT
    } else {
        limit
    };

    let all_history = storage::get_price_history(env, asset);
    let mut result: Vec<PriceDataPoint> = Vec::new(env);
    for i in 0..all_history.len() {
        if result.len() >= effective {
            break;
        }
        if let Some(dp) = all_history.get(i) {
            if dp.timestamp >= since_timestamp {
                result.push_back(dp);
            }
        }
    }
    result
}

// ── Issue #70 — reputation query ─────────────────────────────────────────────

pub(crate) fn get_source_reputation(env: &Env, source: &Address) -> Option<SourceReputation> {
    let rep = storage::get_source_reputation(env, source)?;
    Some(utils::apply_reputation_decay(env, rep))
}

// ── Issue #69 — deviation threshold query ────────────────────────────────────

pub(crate) fn get_deviation_threshold(env: &Env) -> Option<u32> {
    storage::get_deviation_threshold(env)
}

pub(crate) fn get_query_fee(env: &Env) -> i128 {
    storage::get_query_fee(env)
}

/// Destination for slashed stake, if an admin has configured one.  `slash`
/// fails while this is unset.
pub(crate) fn get_stake_treasury(env: &Env) -> Option<Address> {
    storage::get_stake_treasury(env)
}

// ── Issue #565 — Two-step admin handover query ───────────────────────────────

pub(crate) fn get_pending_admin(env: &Env) -> Option<Address> {
    storage::get_pending_admin(env).map(|(admin, _)| admin)
}
