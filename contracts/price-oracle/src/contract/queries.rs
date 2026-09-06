// Issue #297 — read-only queries.  No function here mutates storage.

use soroban_sdk::{Address, Env, String, Vec};

use crate::storage;
use crate::types::{AssetPrice, PriceDataPoint, SourceReputation};

use crate::utils;

pub(crate) fn get_price(env: &Env, asset: &String) -> Option<AssetPrice> {
    let data_point = storage::get_latest_price(env, asset)?;
    let num_sources = storage::get_source_count(env);
    let is_trusted = storage::is_trusted_asset(env, asset);

    let price_usd = utils::calculate_usd_price(env, &data_point.asset, data_point.price, data_point.decimals);

    Some(AssetPrice {
        asset: data_point.asset,
        price: data_point.price,
        decimals: data_point.decimals,
        price_usd,
        timestamp: data_point.timestamp,
        source: data_point.source,
        num_sources,
        is_trusted,
    })
}

pub(crate) fn get_assets(env: &Env) -> Vec<String> {
    storage::get_all_assets(env)
}

pub(crate) fn get_price_history(env: &Env, asset: &String, limit: u32) -> Vec<PriceDataPoint> {
    let all_history = storage::get_price_history(env, asset);
    let len = all_history.len();
    let start = if len > limit { len - limit } else { 0 };
    let mut result: Vec<PriceDataPoint> = Vec::new(env);
    for i in start..len {
        if let Some(dp) = all_history.get(i) {
            result.push_back(dp);
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
