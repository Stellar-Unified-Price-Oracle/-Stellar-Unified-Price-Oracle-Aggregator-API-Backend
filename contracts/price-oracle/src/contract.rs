use soroban_sdk::{contract, contractimpl, Address, Bytes, Env, String, Vec};

use crate::errors::OracleError;
use crate::merkle;
use crate::storage;
use crate::types::{AssetPrice, BatchPriceEntry, MerkleProof, PriceDataPoint};

// Maximum entries stored per asset (prevents unbounded history growth).
const MAX_HISTORY_LEN: u32 = 100;

#[contract]
pub struct PriceOracleContract;

#[contractimpl]
impl PriceOracleContract {
    pub fn initialize(env: Env, admin: Address) {
        storage::set_admin(&env, &admin);
    }

    // ── Individual price submission ───────────────────────────────────────────

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
        append_history(&env, &asset, data_point.clone());
        Ok(data_point)
    }

    // ── Merkle batch submission ───────────────────────────────────────────────

    /// Commit a Merkle root covering a batch of price entries.
    ///
    /// The authorized source submits one transaction with the root hash of an
    /// ordered batch.  Individual entries are applied later via
    /// `apply_batch_entry` using inclusion proofs — one cheap tx per price
    /// instead of one full auth+storage tx per price.
    ///
    /// `nonce` must equal the current BatchNonce (prevents replay attacks).
    /// Returns the new nonce after this batch.
    pub fn submit_batch(
        env: Env,
        source: Address,
        nonce: u64,
        root: Bytes,
    ) -> Result<u64, OracleError> {
        source.require_auth();

        if !storage::is_authorized_source(&env, &source) {
            return Err(OracleError::UnauthorizedSource);
        }
        if root.len() != 32 {
            return Err(OracleError::InvalidMerkleProof);
        }
        if nonce != storage::get_batch_nonce(&env) {
            return Err(OracleError::BatchNonceMismatch);
        }

        storage::set_batch_root(&env, nonce, &root);
        let new_nonce = storage::increment_batch_nonce(&env);
        Ok(new_nonce)
    }

    /// Apply a single price entry from an already-committed batch.
    ///
    /// The Merkle proof is verified against the stored root; no additional
    /// source auth is required because the root was already committed by an
    /// authorized source.  Anyone can submit proofs — the cryptographic proof
    /// is the authorization.
    pub fn apply_batch_entry(
        env: Env,
        batch_nonce: u64,
        entry: BatchPriceEntry,
        proof: MerkleProof,
    ) -> Result<PriceDataPoint, OracleError> {
        let root = storage::get_batch_root(&env, batch_nonce)
            .ok_or(OracleError::BatchRootNotFound)?;

        if !merkle::verify_proof(&env, &entry, proof.leaf_index, &proof.siblings, &root) {
            return Err(OracleError::InvalidMerkleProof);
        }

        let data_point = PriceDataPoint {
            asset: entry.asset.clone(),
            price: entry.price,
            decimals: entry.decimals,
            timestamp: entry.timestamp,
            source: entry.source.clone(),
        };

        storage::set_latest_price(&env, &entry.asset, &data_point);
        append_history(&env, &entry.asset, data_point.clone());
        Ok(data_point)
    }

    /// Read-only Merkle proof verification (does not write any state).
    pub fn verify_batch_proof(
        env: Env,
        batch_nonce: u64,
        entry: BatchPriceEntry,
        proof: MerkleProof,
    ) -> bool {
        let root = match storage::get_batch_root(&env, batch_nonce) {
            Some(r) => r,
            None => return false,
        };
        merkle::verify_proof(&env, &entry, proof.leaf_index, &proof.siblings, &root)
    }

    /// Return the current batch nonce (next expected nonce for submit_batch).
    pub fn get_batch_nonce(env: Env) -> u64 {
        storage::get_batch_nonce(&env)
    }

    // ── Read functions ────────────────────────────────────────────────────────

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

    // ── Admin functions ───────────────────────────────────────────────────────

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

// ── Shared helpers ────────────────────────────────────────────────────────────

fn append_history(env: &Env, asset: &String, data_point: PriceDataPoint) {
    let mut history = storage::get_price_history(env, asset);
    if history.len() >= MAX_HISTORY_LEN {
        let mut trimmed: Vec<PriceDataPoint> = Vec::new(env);
        for i in 1..history.len() {
            if let Some(dp) = history.get(i) {
                trimmed.push_back(dp);
            }
        }
        trimmed.push_back(data_point);
        storage::set_price_history(env, asset, &trimmed);
    } else {
        history.push_back(data_point);
        storage::set_price_history(env, asset, &history);
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
