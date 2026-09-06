// Issue #297 — PriceOracleContract, split into focused modules.
//
// The contract entry points live in a single `#[contractimpl]` block (the
// Soroban SDK generates one client + spec per impl block, so a contract must
// have exactly one) and delegate to the focused modules below:
//
//   - submission.rs — submit_price, Merkle batch flow (submit_batch /
//     apply_batch_entry), staking
//   - admin.rs      — admin-only configuration and treasury operations
//   - governance.rs — multi-sig proposal lifecycle + emergency pause
//   - queries.rs    — read-only price/reputation queries
//
// Shared helpers live in crate::utils (Issue #298), used by both
// PriceOracleContract and ProxyContract.

use soroban_sdk::{contract, contractimpl, Address, Bytes, Env, String, Vec};

use crate::errors::OracleError;
use crate::types::{
    AssetPrice, BatchPriceEntry, MerkleProof, MultiSigConfig, MultiSigProposal, PriceDataPoint,
    ProposalAction, SourceReputation,
};

mod admin;
mod governance;
mod queries;
mod submission;

#[contract]
pub struct PriceOracleContract;

#[contractimpl]
impl PriceOracleContract {
    // ── Initialization ─────────────────────────────────────────────────────

    pub fn initialize(env: Env, admin: Address) -> Result<(), OracleError> {
        admin::initialize(&env, &admin)
    }

    // ── Issue #69 — price submission ───────────────────────────────────────

    pub fn submit_price(
        env: Env,
        source: Address,
        asset: String,
        price: i128,
        decimals: u32,
        timestamp: u64,
    ) -> Result<PriceDataPoint, OracleError> {
        submission::submit_price(&env, &source, &asset, price, decimals, timestamp)
    }

    // ── Issue #75 — Merkle batch submission ────────────────────────────────

    pub fn submit_batch(
        env: Env,
        source: Address,
        nonce: u64,
        root: Bytes,
    ) -> Result<u64, OracleError> {
        submission::submit_batch(&env, &source, nonce, &root)
    }

    pub fn apply_batch_entry(
        env: Env,
        batch_nonce: u64,
        entry: BatchPriceEntry,
        proof: MerkleProof,
    ) -> Result<PriceDataPoint, OracleError> {
        submission::apply_batch_entry(&env, batch_nonce, &entry, &proof)
    }

    pub fn get_batch_nonce(env: Env) -> u64 {
        submission::get_batch_nonce(&env)
    }

    /// Read-only inclusion check used by off-chain tooling and tests.
    pub fn verify_batch_proof(
        env: Env,
        batch_nonce: u64,
        entry: BatchPriceEntry,
        proof: MerkleProof,
    ) -> bool {
        submission::verify_batch_proof(&env, batch_nonce, &entry, &proof)
    }

    // ── Staking / slashing ─────────────────────────────────────────────────

    pub fn stake(env: Env, source: Address, amount: i128, token: Address) {
        submission::stake(&env, &source, amount, &token);
    }

    pub fn slash(env: Env, source: Address, amount: i128, reason: String) {
        submission::slash(&env, &source, amount, &reason);
    }

    pub fn get_stake_balance(env: Env, source: Address) -> i128 {
        submission::get_stake_balance(&env, &source)
    }

    // ── Issue #69 — deviation threshold ────────────────────────────────────

    pub fn set_deviation_threshold(
        env: Env,
        admin: Address,
        threshold_bps: u32,
    ) -> Result<(), OracleError> {
        admin::set_deviation_threshold(&env, &admin, threshold_bps)
    }

    pub fn get_deviation_threshold(env: Env) -> Option<u32> {
        queries::get_deviation_threshold(&env)
    }

    // ── Issue #70 — reputation ─────────────────────────────────────────────

    pub fn get_source_reputation(env: Env, source: Address) -> Option<SourceReputation> {
        queries::get_source_reputation(&env, &source)
    }

    pub fn reset_reputation(
        env: Env,
        admin: Address,
        source: Address,
    ) -> Result<(), OracleError> {
        admin::reset_reputation(&env, &admin, &source)
    }

    // ── Issue #67 — multi-sig admin control ────────────────────────────────

    pub fn init_multisig(
        env: Env,
        admin: Address,
        signers: Vec<Address>,
        threshold: u32,
    ) -> Result<(), OracleError> {
        governance::init_multisig(&env, &admin, &signers, threshold)
    }

    pub fn create_proposal(
        env: Env,
        proposer: Address,
        action: ProposalAction,
    ) -> Result<u32, OracleError> {
        governance::create_proposal(&env, &proposer, &action)
    }

    pub fn approve_proposal(
        env: Env,
        signer: Address,
        proposal_id: u32,
    ) -> Result<(), OracleError> {
        governance::approve_proposal(&env, &signer, proposal_id)
    }

    pub fn execute_proposal(
        env: Env,
        signer: Address,
        proposal_id: u32,
    ) -> Result<(), OracleError> {
        governance::execute_proposal(&env, &signer, proposal_id)
    }

    pub fn get_proposal(env: Env, proposal_id: u32) -> Option<MultiSigProposal> {
        governance::get_proposal(&env, proposal_id)
    }

    pub fn get_multisig_config(env: Env) -> Option<MultiSigConfig> {
        governance::get_multisig_config(&env)
    }

    // ── Issue #379 — multi-region aware emergency pause ────────────────────

    pub fn is_paused(env: Env) -> bool {
        governance::is_paused(&env)
    }

    // ── Queries ────────────────────────────────────────────────────────────

    pub fn get_price(env: Env, asset: String) -> Option<AssetPrice> {
        queries::get_price(&env, &asset)
    }

    pub fn get_assets(env: Env) -> Vec<String> {
        queries::get_assets(&env)
    }

    pub fn get_price_history(env: Env, asset: String, limit: u32) -> Vec<PriceDataPoint> {
        queries::get_price_history(&env, &asset, limit)
    }

    // ── Admin functions ────────────────────────────────────────────────────

    pub fn add_oracle_source(
        env: Env,
        admin: Address,
        source: Address,
        name: String,
    ) -> Result<(), OracleError> {
        admin::add_oracle_source(&env, &admin, &source, &name)
    }

    pub fn remove_oracle_source(
        env: Env,
        admin: Address,
        source: Address,
    ) -> Result<(), OracleError> {
        admin::remove_oracle_source(&env, &admin, &source)
    }

    pub fn set_trusted_asset(
        env: Env,
        admin: Address,
        asset: String,
        trusted: bool,
    ) -> Result<(), OracleError> {
        admin::set_trusted_asset(&env, &admin, &asset, trusted)
    }

    pub fn set_query_fee(env: Env, fee: i128) {
        admin::set_query_fee(&env, fee);
    }

    pub fn get_query_fee(env: Env) -> i128 {
        queries::get_query_fee(&env)
    }

    pub fn set_whitelist(env: Env, addr: Address, status: bool) {
        admin::set_whitelist(&env, &addr, status);
    }

    pub fn withdraw_fees(env: Env, to: Address) {
        admin::withdraw_fees(&env, &to);
    }

    // ── Issue #376 — scheduled TTL / rent extension ────────────────────────

    pub fn extend_storage_ttl(env: Env) {
        admin::extend_storage_ttl(&env);
    }

    pub fn extend_price_history_ttl(env: Env, asset: String, threshold: u32, extend_to: u32) {
        admin::extend_price_history_ttl(&env, &asset, threshold, extend_to);
    }

    pub fn extend_instance_ttl(env: Env, threshold: u32, extend_to: u32) {
        admin::extend_instance_ttl(&env, threshold, extend_to);
    }
}
