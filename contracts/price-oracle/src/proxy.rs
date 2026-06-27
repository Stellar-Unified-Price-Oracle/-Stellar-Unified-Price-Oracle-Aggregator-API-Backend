use soroban_sdk::{contract, contractimpl, Address, Env, String, Vec};

use crate::errors::OracleError;
use crate::storage;
use crate::types::{AssetPrice, DataKey, PriceDataPoint};

/// Proxy contract that delegates to the implementation contract
/// This enables upgradeable contracts while preserving storage
#[contract]
pub struct ProxyContract;

#[contractimpl]
impl ProxyContract {
    /// Initialize the proxy with admin and implementation contract address
    pub fn initialize(env: Env, admin: Address, implementation: Address) {
        storage::set_admin(&env, &admin);
        storage::set_implementation(&env, &implementation);
        storage::set_contract_version(&env, 1);
    }

    /// Upgrade the implementation contract (admin only)
    pub fn upgrade(
        env: Env,
        admin: Address,
        new_implementation: Address,
    ) -> Result<(), OracleError> {
        admin.require_auth();
        storage::verify_admin(&env, &admin)?;

        // Store old implementation for potential rollback reference
        if let Some(old) = storage::get_implementation(&env) {
            storage::set_previous_implementation(&env, &old);
        }

        storage::set_implementation(&env, &new_implementation);

        // Increment version on upgrade
        let current_version = storage::get_contract_version(&env);
        storage::set_contract_version(&env, current_version + 1);

        Ok(())
    }

    /// Get the current implementation contract address
    pub fn get_implementation(env: Env) -> Option<Address> {
        storage::get_implementation(&env)
    }

    /// Get the previous implementation contract address (for rollback reference)
    pub fn get_previous_implementation(env: Env) -> Option<Address> {
        storage::get_previous_implementation(&env)
    }

    /// Get the current contract version
    pub fn get_version(env: Env) -> u32 {
        storage::get_contract_version(&env)
    }

    /// Change admin (admin only)
    pub fn set_admin(env: Env, current_admin: Address, new_admin: Address) -> Result<(), OracleError> {
        current_admin.require_auth();
        storage::verify_admin(&env, &current_admin)?;

        storage::set_admin(&env, &new_admin);
        Ok(())
    }

    /// Submit price through proxy
    pub fn submit_price(
        env: Env,
        source: Address,
        asset: String,
        price: i128,
        decimals: u32,
        timestamp: u64,
    ) -> Result<PriceDataPoint, OracleError> {
        source.require_auth();

        let is_authorized = storage::is_authorized_source(&env, &source);
        if !is_authorized {
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

        let mut history = storage::get_price_history(&env, &asset);
        history.push_back(data_point.clone());
        storage::set_price_history(&env, &asset, &history);

        Ok(data_point)
    }

    /// Get price through proxy
    pub fn get_price(env: Env, asset: String) -> Option<AssetPrice> {
        let data_point = storage::get_latest_price(&env, &asset)?;
        let num_sources = storage::get_source_count(&env);
        let is_trusted = storage::is_trusted_asset(&env, &asset);

        Some(AssetPrice {
            asset: data_point.asset,
            price: data_point.price,
            decimals: data_point.decimals,
            price_usd: calculate_usd_price(&env, &data_point.asset, data_point.price, data_point.decimals),
            timestamp: data_point.timestamp,
            source: data_point.source,
            num_sources,
            is_trusted,
        })
    }

    /// Get all assets
    pub fn get_assets(env: Env) -> Vec<String> {
        storage::get_all_assets(&env)
    }

    /// Get price history
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

    /// Add oracle source
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

    /// Remove oracle source
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

    /// Set trusted asset
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

fn calculate_usd_price(env: &Env, asset: &String, price: i128, decimals: u32) -> Option<i128> {
    if asset.as_bytes().eq_ignore_ascii_case(b"XLM") {
        return Some(price);
    }

    if let Some(usdc_anchor) = storage::get_latest_price(env, &String::from_slice(env, b"USDC")) {
        if asset.as_bytes().eq_ignore_ascii_case(b"USDC") {
            return Some(10i128.pow(decimals));
        }
        if let Some(xlm_price) = storage::get_latest_price(env, &String::from_slice(env, b"XLM")) {
            let base_asset_price = (price * xlm_price.price * 10i128.pow(decimals))
                / (10i128.pow(decimals) * 10i128.pow(usdc_anchor.decimals));
            return Some(base_asset_price);
        }
    }

    None
}
