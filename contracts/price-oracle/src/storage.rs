use soroban_sdk::{Address, Bytes, Env, String, Vec};

use crate::errors::OracleError;
use crate::types::{DataKey, MultiSigConfig, Proposal, PriceDataPoint, SourceReputation};

// Maximum number of historical data points kept per asset.
// Older entries beyond this cap are dropped on each write, keeping instance
// storage size bounded and preventing unbounded ledger-entry growth.
pub const MAX_HISTORY_LEN: u32 = 100;

// ── Admin ─────────────────────────────────────────────────────────────────────

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

// ── Proxy / upgrade keys ──────────────────────────────────────────────────────

pub fn set_implementation(env: &Env, implementation: &Address) {
    env.storage().instance().set(&DataKey::Implementation, implementation);
}

pub fn get_implementation(env: &Env) -> Option<Address> {
    env.storage().instance().get(&DataKey::Implementation)
}

pub fn set_previous_implementation(env: &Env, implementation: &Address) {
    env.storage().instance().set(&DataKey::PreviousImplementation, implementation);
}

pub fn get_previous_implementation(env: &Env) -> Option<Address> {
    env.storage().instance().get(&DataKey::PreviousImplementation)
}

pub fn set_contract_version(env: &Env, version: u32) {
    env.storage().instance().set(&DataKey::ContractVersion, &version);
}

pub fn get_contract_version(env: &Env) -> u32 {
    env.storage().instance().get(&DataKey::ContractVersion).unwrap_or(0)
}

// Issue #68 — storage layout version for migration safety
pub fn set_storage_layout_version(env: &Env, version: u32) {
    env.storage().instance().set(&DataKey::StorageLayoutVersion, &version);
}

pub fn get_storage_layout_version(env: &Env) -> u32 {
    env.storage().instance().get(&DataKey::StorageLayoutVersion).unwrap_or(1)
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
    let key = DataKey::Source(source.clone());
    let already_present = env.storage().instance().has(&key);

    // Write the authorization flag.
    env.storage().instance().set(&key, &true);

    // Only write the name and bump the counter on the first registration.
    // Re-registering an existing source is a no-op for count and name,
    // saving two storage writes on the common "re-add" path.
    if !already_present {
        env.storage()
            .instance()
            .set(&DataKey::SourceName(source.clone()), name);
        let count = get_source_count(env);
        env.storage()
            .instance()
            .set(&DataKey::SourceCount, &(count + 1));
    }
}

pub fn remove_source(env: &Env, source: &Address) {
    let key = DataKey::Source(source.clone());
    if !env.storage().instance().has(&key) {
        return;
    }
    env.storage().instance().remove(&key);
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

// ── Price data ────────────────────────────────────────────────────────────────

pub fn set_latest_price(env: &Env, asset: &String, data_point: &PriceDataPoint) {
    let is_new = !env
        .storage()
        .instance()
        .has(&DataKey::LatestPrice(asset.clone()));

    env.storage()
        .instance()
        .set(&DataKey::LatestPrice(asset.clone()), data_point);

    if is_new {
        let mut assets: Vec<String> = env
            .storage()
            .instance()
            .get(&DataKey::AllAssets)
            .unwrap_or_else(|| Vec::new(env));
        assets.push_back(asset.clone());
        env.storage().instance().set(&DataKey::AllAssets, &assets);
    }
}

pub fn get_latest_price(env: &Env, asset: &String) -> Option<PriceDataPoint> {
    env.storage()
        .instance()
        .get(&DataKey::LatestPrice(asset.clone()))
}

// Price history is stored in *persistent* storage.
// Instance storage is billed per ledger entry size on every transaction,
// making large growing vecs very expensive.  Persistent storage charges for
// access only when the entry is actually read or written.
pub fn set_price_history(env: &Env, asset: &String, history: &Vec<PriceDataPoint>) {
    env.storage()
        .persistent()
        .set(&DataKey::PriceHistory(asset.clone()), history);
}

pub fn get_price_history(env: &Env, asset: &String) -> Vec<PriceDataPoint> {
    env.storage()
        .persistent()
        .get(&DataKey::PriceHistory(asset.clone()))
        .unwrap_or_else(|| Vec::new(env))
}

pub fn get_all_assets(env: &Env) -> Vec<String> {
    env.storage()
        .instance()
        .get(&DataKey::AllAssets)
        .unwrap_or_else(|| Vec::new(env))
}

// ── Trusted assets ────────────────────────────────────────────────────────────

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

// Issue #69 — deviation threshold
pub fn set_deviation_threshold(env: &Env, threshold_bps: u32) {
    env.storage()
        .instance()
        .set(&DataKey::DeviationThreshold, &threshold_bps);
}

pub fn get_deviation_threshold(env: &Env) -> Option<u32> {
    env.storage().instance().get(&DataKey::DeviationThreshold)
}

// Issue #70 — source reputation
pub fn set_source_reputation(env: &Env, source: &Address, reputation: &SourceReputation) {
    env.storage()
        .instance()
        .set(&DataKey::SourceReputation(source.clone()), reputation);
}

pub fn get_source_reputation(env: &Env, source: &Address) -> Option<SourceReputation> {
    env.storage()
        .instance()
        .get(&DataKey::SourceReputation(source.clone()))
}

pub fn remove_source_reputation(env: &Env, source: &Address) {
    env.storage()
        .instance()
        .remove(&DataKey::SourceReputation(source.clone()));
}

// Issue #67 — multi-sig
pub fn set_multisig_config(env: &Env, config: &MultiSigConfig) {
    env.storage().instance().set(&DataKey::MultiSigConfig, config);
}

pub fn get_multisig_config(env: &Env) -> Option<MultiSigConfig> {
    env.storage().instance().get(&DataKey::MultiSigConfig)
}

pub fn get_proposal_count(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::ProposalCount)
        .unwrap_or(0)
}

pub fn set_proposal_count(env: &Env, count: u32) {
    env.storage().instance().set(&DataKey::ProposalCount, &count);
}

pub fn set_proposal(env: &Env, proposal: &Proposal) {
    env.storage()
        .instance()
        .set(&DataKey::Proposal(proposal.id), proposal);
}

pub fn get_proposal(env: &Env, id: u32) -> Option<Proposal> {
    env.storage().instance().get(&DataKey::Proposal(id))
}

pub fn get_stake(env: &Env, addr: &Address) -> i128 {
env.storage()
.instance()
.get(&DataKey::StakeInfo(addr.clone()))
.unwrap_or(0)
}

pub fn set_stake(env: &Env, addr: &Address, amount: &i128) {
env.storage()
.instance()
.set(&DataKey::StakeInfo(addr.clone()), amount);
}

pub fn get_slash_count(env: &Env, addr: &Address) -> u32 {
env.storage()
.instance()
.get(&DataKey::SlashCount(addr.clone()))
.unwrap_or(0)
}

pub fn set_slash_count(env: &Env, addr: &Address, count: &u32) {
env.storage()
.instance()
.set(&DataKey::SlashCount(addr.clone()), count);
}
