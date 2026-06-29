use soroban_sdk::{contract, contractimpl, Address, Env, String, Vec};

use crate::errors::OracleError;
use crate::storage;
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
        let start = if len > limit {
            len - limit
        } else {
            0
        };
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

fn calculate_usd_price(env: &Env, asset: &String, price: i128, decimals: u32) -> Option<i128> {
    let asset_str = String::from_str(env, "XLM");
    if asset == &asset_str {
        return Some(price);
    }

    if let Some(usdc_anchor) = storage::get_latest_price(env, &String::from_str(env, "USDC")) {
        let usdc_str = String::from_str(env, "USDC");
        if asset == &usdc_str {
            return Some(10i128.pow(decimals));
        }
        if let Some(xlm_price) = storage::get_latest_price(env, &String::from_str(env, "XLM")) {
            let base_asset_price = (price * xlm_price.price * 10i128.pow(decimals))
                / (10i128.pow(decimals) * 10i128.pow(usdc_anchor.decimals));
            return Some(base_asset_price);
        }
    }

    None
}

impl PriceOracleContract {
pub fn set_query_fee(env: Env, fee: i128) {
let admin = storage::get_admin(&env);
admin.require_auth();
storage::set_query_fee(&env, &fee);
}

pub fn get_query_fee(env: Env) -> i128 {
storage::get_query_fee(&env)
}

pub fn set_whitelist(env: Env, addr: Address, status: bool) {
let admin = storage::get_admin(&env);
admin.require_auth();
storage::set_whitelist(&env, &addr, status);
}

pub fn withdraw_fees(env: Env, to: Address) {
let admin = storage::get_admin(&env);
admin.require_auth();
let balance = storage::get_fee_balance(&env);
if balance > 0 {
storage::set_fee_balance(&env, &0);
let token = soroban_sdk::token::Client::new(&env, &to);
token.transfer(&env.current_contract_address(), &to, &balance);
}
}
}
