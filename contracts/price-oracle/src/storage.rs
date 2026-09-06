use soroban_sdk::{Address, Bytes, BytesN, Env, String, Vec};

use crate::errors::OracleError;
use crate::types::{CanaryConfig, DataKey, GovernanceConfig, GovernanceProposal, MultiSigConfig, MultiSigProposal, PendingProxyUpgrade, PriceDataPoint, SourceReputation};

// Maximum number of historical data points kept per asset.
// Older entries beyond this cap are dropped on each write, keeping instance
// storage size bounded and preventing unbounded ledger-entry growth.
pub const MAX_HISTORY_LEN: u32 = 100;

// ── Admin ─────────────────────────────────────────────────────────────────────

pub fn set_admin(env: &Env, admin: &Address) {
    env.storage().instance().set(&DataKey::Admin, admin);
}

pub fn get_admin(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&DataKey::Admin)
        .expect("admin not initialized")
}

pub fn has_admin(env: &Env) -> bool {
    env.storage().instance().has(&DataKey::Admin)
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

// ── Issue #379 — multi-region aware emergency pause ────────────────────────────

pub fn set_paused(env: &Env, paused: bool) {
    env.storage().instance().set(&DataKey::Paused, &paused);
}

pub fn is_paused(env: &Env) -> bool {
    env.storage()
        .instance()
        .get(&DataKey::Paused)
        .unwrap_or(false)
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

// Issue #376 — TTL / rent extension. Called periodically by an off-chain job
// so PriceHistory (persistent) and the contract instance (Admin, GovConfig,
// proposals, etc. — all instance storage) never hit their TTL floor and get
// archived/evicted.
pub fn extend_price_history_ttl(env: &Env, asset: &String, threshold: u32, extend_to: u32) {
    env.storage()
        .persistent()
        .extend_ttl(&DataKey::PriceHistory(asset.clone()), threshold, extend_to);
}

pub fn extend_instance_ttl(env: &Env, threshold: u32, extend_to: u32) {
    env.storage().instance().extend_ttl(threshold, extend_to);
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

pub fn get_batch_nonce(env: &Env) -> u64 {
    env.storage().instance().get(&DataKey::BatchNonce).unwrap_or(0)
}

pub fn increment_batch_nonce(env: &Env) -> u64 {
    let next = get_batch_nonce(env) + 1;
    env.storage().instance().set(&DataKey::BatchNonce, &next);
    next
}

// Issue #385 — Merkle batch replay / DoS hardening.
//
// Only the most recent RETAINED_BATCH_ROOTS roots are retained.  Older roots
// (and their applied-leaf trackers) are pruned on every new batch commit so
// batch bookkeeping cannot grow without bound over the contract's lifetime.
// A watermark avoids rescanning already-pruned nonces on each commit.
pub const RETAINED_BATCH_ROOTS: u64 = 16;

pub fn set_batch_root(env: &Env, nonce: u64, root: &Bytes) {
    env.storage()
        .instance()
        .set(&DataKey::BatchRoot(nonce), root);
    // The just-committed root is at `nonce`; the next batch will be `nonce + 1`.
    prune_batch_roots(env, nonce + 1);
}

pub fn get_batch_root(env: &Env, nonce: u64) -> Option<Bytes> {
    env.storage().instance().get(&DataKey::BatchRoot(nonce))
}

fn prune_batch_roots(env: &Env, current_nonce: u64) {
    let keep_from = current_nonce.saturating_sub(RETAINED_BATCH_ROOTS);
    let watermark = get_batch_prune_watermark(env);
    let prune_to = keep_from.max(watermark).min(current_nonce);

    let mut k = watermark;
    while k < prune_to {
        env.storage().instance().remove(&DataKey::BatchRoot(k));
        env.storage()
            .instance()
            .remove(&DataKey::BatchAppliedLeaves(k));
        k += 1;
    }
    if prune_to > watermark {
        env.storage()
            .instance()
            .set(&DataKey::BatchPruneWatermark, &prune_to);
    }
}

pub fn get_batch_prune_watermark(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::BatchPruneWatermark)
        .unwrap_or(0)
}

/// Applied-leaf tracker for a committed batch (Issue #385).
///
/// `apply_batch_entry` is permissionless (the Merkle proof is the
/// authorization), so without a per-batch applied-set anyone could re-apply
/// the same leaf repeatedly, spamming history with duplicate entries.  The
/// tracker makes each leaf single-use per batch; it is pruned together with
/// its root once the batch ages out of RETAINED_BATCH_ROOTS.
pub fn get_batch_applied_leaves(env: &Env, nonce: u64) -> Vec<u32> {
    env.storage()
        .instance()
        .get(&DataKey::BatchAppliedLeaves(nonce))
        .unwrap_or_else(|| Vec::new(env))
}

pub fn mark_batch_leaf_applied(env: &Env, nonce: u64, leaf_index: u32) -> Result<(), OracleError> {
    let mut applied = get_batch_applied_leaves(env, nonce);
    for i in 0..applied.len() {
        if let Some(idx) = applied.get(i) {
            if idx == leaf_index {
                return Err(OracleError::BatchEntryAlreadyApplied);
            }
        }
    }
    applied.push_back(leaf_index);
    env.storage()
        .instance()
        .set(&DataKey::BatchAppliedLeaves(nonce), &applied);
    Ok(())
}

pub fn set_query_fee(env: &Env, fee: &i128) {
    env.storage().instance().set(&DataKey::QueryFee, fee);
}

pub fn get_query_fee(env: &Env) -> i128 {
    env.storage().instance().get(&DataKey::QueryFee).unwrap_or(0)
}

pub fn set_whitelist(env: &Env, addr: &Address, status: bool) {
    env.storage()
        .instance()
        .set(&DataKey::Whitelist(addr.clone()), &status);
}

pub fn get_fee_balance(env: &Env) -> i128 {
    env.storage().instance().get(&DataKey::FeeBalance).unwrap_or(0)
}

pub fn set_fee_balance(env: &Env, balance: &i128) {
    env.storage().instance().set(&DataKey::FeeBalance, balance);
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

// ── Multi-sig ─────────────────────────────────────────────────────────────────

pub fn set_multisig_config(env: &Env, config: &MultiSigConfig) {
    env.storage().instance().set(&DataKey::MultiSigConfig, config);
}

pub fn get_multisig_config(env: &Env) -> Option<MultiSigConfig> {
    env.storage().instance().get(&DataKey::MultiSigConfig)
}

pub fn get_msig_proposal_count(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::ProposalCount)
        .unwrap_or(0)
}

pub fn set_msig_proposal_count(env: &Env, count: u32) {
    env.storage().instance().set(&DataKey::ProposalCount, &count);
}

pub fn set_proposal_count(env: &Env, count: u32) {
    set_msig_proposal_count(env, count);
}

/// Increment the multi-sig proposal counter (alias used by contract.rs and
/// multisig.rs after creating a proposal).
pub fn set_proposal_count(env: &Env, count: u32) {
    env.storage().instance().set(&DataKey::MultiSigProposalCount, &count);
}

pub fn set_msig_proposal(env: &Env, proposal: &MultiSigProposal) {
    env.storage()
        .instance()
        .set(&DataKey::MultiSigProposal(proposal.id), proposal);
}

pub fn get_msig_proposal(env: &Env, id: u32) -> Option<MultiSigProposal> {
    env.storage().instance().get(&DataKey::MultiSigProposal(id))
}

// ── Governance (token-based voting) ──────────────────────────────────────────

pub fn set_gov_config(env: &Env, config: &GovernanceConfig) {
    env.storage().instance().set(&DataKey::GovernanceConfig, config);
}

pub fn get_gov_config(env: &Env) -> Option<GovernanceConfig> {
    env.storage().instance().get(&DataKey::GovernanceConfig)
}

pub fn increment_proposal_count(env: &Env) -> u32 {
    let count = env.storage()
        .instance()
        .get(&DataKey::GovernanceProposalCount)
        .unwrap_or(0);
    let next = count + 1;
    env.storage()
        .instance()
        .set(&DataKey::GovernanceProposalCount, &next);
    next
}

pub fn get_proposal_count(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::GovernanceProposalCount)
        .unwrap_or(0)
}

pub fn set_gov_proposal(env: &Env, proposal: &GovernanceProposal) {
    env.storage()
        .instance()
        .set(&DataKey::GovernanceProposal(proposal.id), proposal);
}

pub fn get_gov_proposal(env: &Env, id: u32) -> Option<GovernanceProposal> {
    env.storage().instance().get(&DataKey::GovernanceProposal(id))
}

pub fn set_multisig_proposal(env: &Env, proposal: &MultiSigProposal) {
    env.storage()
        .instance()
        .set(&DataKey::MultiSigProposal(proposal.id), proposal);
}

pub fn get_multisig_proposal(env: &Env, id: u32) -> Option<MultiSigProposal> {
    env.storage().instance().get(&DataKey::MultiSigProposal(id))
}

pub fn get_gov_proposal(env: &Env, id: u32) -> Option<GovernanceProposal> {
    env.storage().instance().get(&DataKey::GovernanceProposal(id))
}

pub fn record_vote(env: &Env, proposal_id: u32, voter: &Address, support: bool) {
    env.storage()
        .instance()
        .set(&DataKey::Vote(proposal_id, voter.clone()), &support);
}

pub fn has_voted(env: &Env, proposal_id: u32, voter: &Address) -> bool {
    env.storage()
        .instance()
        .has(&DataKey::Vote(proposal_id, voter.clone()))
}

// ── Staking ───────────────────────────────────────────────────────────────────

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

// ── Proxy upgrade timelock (Issue #375) ────────────────────────────────────────

pub fn set_pending_upgrade(env: &Env, wasm_hash: &BytesN<32>, eta: u64) {
    env.storage()
        .instance()
        .set(&DataKey::PendingUpgradeHash, wasm_hash);
    env.storage().instance().set(&DataKey::PendingUpgradeEta, &eta);
    env.storage()
        .instance()
        .set(&DataKey::UpgradeApprovals, &Vec::<Address>::new(env));
}

pub fn get_pending_upgrade(env: &Env) -> Option<BytesN<32>> {
    env.storage().instance().get(&DataKey::PendingUpgradeHash)
}

pub fn get_pending_upgrade_eta(env: &Env) -> Option<u64> {
    env.storage().instance().get(&DataKey::PendingUpgradeEta)
}

pub fn clear_pending_upgrade(env: &Env) {
    env.storage().instance().remove(&DataKey::PendingUpgradeHash);
    env.storage().instance().remove(&DataKey::PendingUpgradeEta);
    env.storage().instance().remove(&DataKey::UpgradeApprovals);
}

pub fn get_upgrade_approvals(env: &Env) -> Vec<Address> {
    env.storage()
        .instance()
        .get(&DataKey::UpgradeApprovals)
        .unwrap_or_else(|| Vec::new(env))
}

pub fn record_upgrade_approval(env: &Env, signer: &Address) {
    let mut approvals = get_upgrade_approvals(env);
    approvals.push_back(signer.clone());
    env.storage()
        .instance()
        .set(&DataKey::UpgradeApprovals, &approvals);
}

// ── Canary rollout (Issue #375) ─────────────────────────────────────────────────

pub fn set_canary(env: &Env, implementation: &Address, traffic_share_bps: u32) {
    env.storage()
        .instance()
        .set(&DataKey::CanaryImplementation, implementation);
    env.storage()
        .instance()
        .set(&DataKey::CanaryTrafficShareBps, &traffic_share_bps);
}

pub fn get_canary(env: &Env) -> Option<(Address, u32)> {
    let implementation: Address = env
        .storage()
        .instance()
        .get(&DataKey::CanaryImplementation)?;
    let bps: u32 = env
        .storage()
        .instance()
        .get(&DataKey::CanaryTrafficShareBps)
        .unwrap_or(0);
    Some((implementation, bps))
}

pub fn clear_canary(env: &Env) {
    env.storage().instance().remove(&DataKey::CanaryImplementation);
    env.storage()
        .instance()
        .remove(&DataKey::CanaryTrafficShareBps);
}

// ── TTL / rent management (Issue #376) ──────────────────────────────────────────

// Persistent-entry TTL floor and extension target, expressed in ledgers
// (~5s/ledger on mainnet). Floor ~7 days, extended out to ~90 days so the
// scheduled rent job (see scripts/extend-ttl-job.ts) has a wide safety
// margin between runs.
pub const TTL_FLOOR_LEDGERS: u32 = 120_960; // ~7 days
pub const TTL_EXTEND_TO_LEDGERS: u32 = 1_555_200; // ~90 days

/// Extend the TTL of a single asset's price history entry so it never
/// expires between scheduled rent-payment runs.
pub fn extend_price_history_ttl(env: &Env, asset: &String) {
    env.storage().persistent().extend_ttl(
        &DataKey::PriceHistory(asset.clone()),
        TTL_FLOOR_LEDGERS,
        TTL_EXTEND_TO_LEDGERS,
    );
}

/// Extend the instance storage TTL, which covers Admin, GovernanceConfig,
/// GovernanceProposal, and MultiSigConfig entries (Soroban bills and expires
/// instance storage as a single ledger entry shared by all `.instance()`
/// keys, so there is no per-key TTL to extend for these).
pub fn extend_instance_ttl(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(TTL_FLOOR_LEDGERS, TTL_EXTEND_TO_LEDGERS);
}

pub fn set_slash_count(env: &Env, addr: &Address, count: &u32) {
    env.storage()
        .instance()
        .set(&DataKey::SlashCount(addr.clone()), count);
}

// ── Proxy upgrade governance (Issue #375) ───────────────────────────────────

pub fn set_pending_upgrade(env: &Env, upgrade: &PendingProxyUpgrade) {
    env.storage().instance().set(&DataKey::PendingProxyUpgrade, upgrade);
}

pub fn get_pending_upgrade(env: &Env) -> Option<PendingProxyUpgrade> {
    env.storage().instance().get(&DataKey::PendingProxyUpgrade)
}

pub fn clear_pending_upgrade(env: &Env) {
    env.storage().instance().remove(&DataKey::PendingProxyUpgrade);
}

pub fn set_canary_config(env: &Env, config: &CanaryConfig) {
    env.storage().instance().set(&DataKey::CanaryConfig, config);
}

pub fn get_canary_config(env: &Env) -> Option<CanaryConfig> {
    env.storage().instance().get(&DataKey::CanaryConfig)
}

pub fn clear_canary_config(env: &Env) {
    env.storage().instance().remove(&DataKey::CanaryConfig);
}
