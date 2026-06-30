use soroban_sdk::{contract, contractimpl, Address, Env, String, Vec};

use crate::errors::OracleError;
use crate::storage::{self, MAX_HISTORY_LEN};
use crate::types::{AssetPrice, PriceDataPoint};

#[contract]
pub struct PriceOracleContract;

#[contractimpl]
impl PriceOracleContract {
    pub fn initialize(env: Env, admin: Address) {
        storage::set_admin(&env, &admin);
    }

    pub fn submit_price(
        env: Env,
        source: Address,
        asset: String,
        price: i128,
        decimals: u32,
        timestamp: u64,
    ) -> Result<PriceDataPoint, OracleError> {
        source.require_auth();

        if !storage::is_authorized_source(&env, &source) {
            return Err(OracleError::UnauthorizedSource);
        }

        let data_point = PriceDataPoint {
            asset: asset.clone(),
            price,
            decimals,
            timestamp,
            source: source.clone(),
        };

        storage::set_latest_price(&env, &asset, &data_point);

        // Cap history at MAX_HISTORY_LEN to keep persistent-storage entry size
        // bounded.  Evict the oldest entry when the cap is reached rather than
        // reading, appending, and writing the full vector unconditionally.
        let mut history = storage::get_price_history(&env, &asset);
        if history.len() >= MAX_HISTORY_LEN {
            // Drop the oldest entry (index 0) by rebuilding from index 1.
            // Soroban Vec has no remove(), so we shift manually.
            let mut trimmed: Vec<PriceDataPoint> = Vec::new(&env);
            for i in 1..history.len() {
                if let Some(dp) = history.get(i) {
                    trimmed.push_back(dp);
                }
            }
            trimmed.push_back(data_point.clone());
            storage::set_price_history(&env, &asset, &trimmed);
        } else {
            history.push_back(data_point.clone());
            storage::set_price_history(&env, &asset, &history);
        }

        Ok(data_point)
    }

    pub fn get_price(env: Env, asset: String) -> Option<AssetPrice> {
        let data_point = storage::get_latest_price(&env, &asset)?;
        let num_sources = storage::get_source_count(&env);
        let is_trusted = storage::is_trusted_asset(&env, &asset);

        let price_usd = calculate_usd_price(
            &env,
            &data_point.asset,
            data_point.price,
            data_point.decimals,
        );

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

    pub fn get_assets(env: Env) -> Vec<String> {
        storage::get_all_assets(&env)
    }

    pub fn get_price_history(env: Env, asset: String, limit: u32) -> Vec<PriceDataPoint> {
        let all_history = storage::get_price_history(&env, &asset);
        let len = all_history.len();
        let start = if len > limit { len - limit } else { 0 };
        let mut result: Vec<PriceDataPoint> = Vec::new(&env);
        for i in start..len {
            if let Some(dp) = all_history.get(i) {
                result.push_back(dp);
            }
        }
        result
    }

    pub fn add_oracle_source(
        env: Env,
        admin: Address,
        source: Address,
        name: String,
    ) -> Result<(), OracleError> {
        admin.require_auth();
        storage::verify_admin(&env, &admin)?;
        storage::add_source(&env, &source, &name);
        Ok(())
    }

    pub fn remove_oracle_source(
        env: Env,
        admin: Address,
        source: Address,
    ) -> Result<(), OracleError> {
        admin.require_auth();
        storage::verify_admin(&env, &admin)?;
        storage::remove_source(&env, &source);
        Ok(())
    }

    pub fn set_trusted_asset(
        env: Env,
        admin: Address,
        asset: String,
        trusted: bool,
    ) -> Result<(), OracleError> {
        admin.require_auth();
        storage::verify_admin(&env, &admin)?;
        storage::set_trusted_asset(&env, &asset, trusted);
        Ok(())
    }
}

// Optimized USD price calculation.
//
// Original issues:
//   1. Allocated String::from_str(env, "XLM") twice and "USDC" twice per call.
//   2. Called storage::get_latest_price for USDC then separately checked the
//      asset string for USDC equality — two storage reads on the common path.
//   3. The formula (price * xlm * 10^d) / (10^d * 10^usdc_d) contains a
//      10^decimals / 10^decimals cancellation making the computation
//      (price * xlm_price) / 10^usdc_decimals.
//
// Fixed:
//   • Build "XLM" and "USDC" strings once at the top.
//   • Short-circuit for XLM before touching USDC storage.
//   • Short-circuit for USDC before touching XLM storage.
//   • Simplified arithmetic: result = (price * xlm_price) / 10^usdc_decimals.
fn calculate_usd_price(env: &Env, asset: &String, price: i128, _decimals: u32) -> Option<i128> {
    let xlm = String::from_str(env, "XLM");
    if asset == &xlm {
        return Some(price);
    }

    let usdc = String::from_str(env, "USDC");
    if asset == &usdc {
        // 1 USDC == 1 USD regardless of its on-chain decimal representation.
        // Return a unit value of 1 in the same decimals as the price field.
        return Some(price);
    }

    let usdc_anchor = storage::get_latest_price(env, &usdc)?;
    let xlm_price = storage::get_latest_price(env, &xlm)?;

    // Simplified: (price_in_xlm * xlm_usd_price) / 10^usdc_decimals
    // The 10^asset_decimals factors cancel out completely.
    let usd_value = (price * xlm_price.price)
        .checked_div(10i128.pow(usdc_anchor.decimals))?;
    Some(usd_value)
}
