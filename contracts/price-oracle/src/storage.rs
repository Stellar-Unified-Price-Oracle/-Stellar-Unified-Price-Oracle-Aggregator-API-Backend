use soroban_sdk::{Address, Env, String, Vec};

use crate::errors::OracleError;
use crate::types::{DataKey, PriceDataPoint};

pub fn set_admin(env: &Env, admin: &Address) {
    env.storage().instance().set(&DataKey::Admin, admin);
}

pub fn verify_admin(env: &Env, admin: &Address) -> Result<(), OracleError> {
    let stored: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(OracleError::AdminOnly)?;
    if stored != *admin {
        return Err(OracleError::AdminOnly);
    }
    Ok(())
}

pub fn is_authorized_source(env: &Env, source: &Address) -> bool {
    env.storage()
        .instance()
        .has(&DataKey::Source(source.clone()))
}

pub fn add_source(env: &Env, source: &Address, name: &String) {
    env.storage()
        .instance()
        .set(&DataKey::Source(source.clone()), &true);
    env.storage()
        .instance()
        .set(&DataKey::SourceName(source.clone()), name);
    let count = get_source_count(env);
    env.storage()
        .instance()
        .set(&DataKey::SourceCount, &(count + 1));
}

pub fn remove_source(env: &Env, source: &Address) {
    env.storage()
        .instance()
        .remove(&DataKey::Source(source.clone()));
    env.storage()
        .instance()
        .remove(&DataKey::SourceName(source.clone()));
    let count = get_source_count(env);
    if count > 0 {
        env.storage()
            .instance()
            .set(&DataKey::SourceCount, &(count - 1));
    }
}

pub fn get_source_count(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::SourceCount)
        .unwrap_or(0)
}

pub fn set_latest_price(env: &Env, asset: &String, data_point: &PriceDataPoint) {
    env.storage()
        .instance()
        .set(&DataKey::LatestPrice(asset.clone()), data_point);

    if !env
        .storage()
        .instance()
        .has(&DataKey::LatestPrice(asset.clone()))
    {
        let mut assets: Vec<String> = env
            .storage()
            .instance()
            .get(&DataKey::AllAssets)
            .unwrap_or(Vec::new(env));
        assets.push_back(asset.clone());
        env.storage()
            .instance()
            .set(&DataKey::AllAssets, &assets);
    }
}

pub fn get_latest_price(env: &Env, asset: &String) -> Option<PriceDataPoint> {
    env.storage()
        .instance()
        .get(&DataKey::LatestPrice(asset.clone()))
}

pub fn set_price_history(env: &Env, asset: &String, history: &Vec<PriceDataPoint>) {
    env.storage()
        .instance()
        .set(&DataKey::PriceHistory(asset.clone()), history);
}

pub fn get_price_history(env: &Env, asset: &String) -> Vec<PriceDataPoint> {
    env.storage()
        .instance()
        .get(&DataKey::PriceHistory(asset.clone()))
        .unwrap_or(Vec::new(env))
}

pub fn get_all_assets(env: &Env) -> Vec<String> {
    env.storage()
        .instance()
        .get(&DataKey::AllAssets)
        .unwrap_or(Vec::new(env))
}

pub fn set_trusted_asset(env: &Env, asset: &String, trusted: bool) {
    env.storage()
        .instance()
        .set(&DataKey::TrustedAsset(asset.clone()), &trusted);
}

pub fn is_trusted_asset(env: &Env, asset: &String) -> bool {
    env.storage()
        .instance()
        .get(&DataKey::TrustedAsset(asset.clone()))
        .unwrap_or(false)
}
