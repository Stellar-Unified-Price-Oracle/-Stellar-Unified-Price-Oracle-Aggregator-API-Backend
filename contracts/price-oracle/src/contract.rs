use soroban_sdk::{contract, contractimpl, Address, Env, String, Vec};

use crate::errors::OracleError;
use crate::storage;
use crate::types::{AssetPrice, MultiSigConfig, Proposal, ProposalAction, PriceDataPoint, SourceReputation};

// Basis points threshold below which a submission is counted as accurate for reputation.
const REPUTATION_ACCURACY_THRESHOLD_BPS: u128 = 2000; // 20%
// Seconds between reputation decay applications (~7 days).
const REPUTATION_DECAY_PERIOD_SECS: u64 = 604_800;
// Decay factor per period: score = score * 95 / 100.
const REPUTATION_DECAY_NUMERATOR: u32 = 95;
const REPUTATION_DECAY_DENOMINATOR: u32 = 100;

#[contract]
pub struct PriceOracleContract;

#[contractimpl]
impl PriceOracleContract {
    pub fn initialize(env: Env, admin: Address) {
        storage::set_admin(&env, &admin);
        storage::set_storage_layout_version(&env, 1);
    }

    // -------------------------------------------------------------------------
    // Issue #69 — price submission with deviation threshold validation
    // -------------------------------------------------------------------------

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

        // Deviation check: only active when a threshold has been configured and a
        // previous price exists (bypassed for initial submission).
        if let Some(threshold_bps) = storage::get_deviation_threshold(&env) {
            if let Some(prev) = storage::get_latest_price(&env, &asset) {
                if deviation_exceeds(price, prev.price, threshold_bps) {
                    return Err(OracleError::PriceDeviationTooLarge);
                }
            }
        }

        let data_point = PriceDataPoint {
            asset: asset.clone(),
            price,
            decimals,
            timestamp,
            source: source.clone(),
        };

        // Update reputation before overwriting latest price so we still have
        // the previous price available for accuracy comparison.
        update_reputation(&env, &source, price, &asset, timestamp);

        storage::set_latest_price(&env, &asset, &data_point);

        let mut history = storage::get_price_history(&env, &asset);
        history.push_back(data_point.clone());
        storage::set_price_history(&env, &asset, &history);

        Ok(data_point)
    }

    // -------------------------------------------------------------------------
    // Issue #69 — admin: configure deviation threshold
    // -------------------------------------------------------------------------

    pub fn set_deviation_threshold(
        env: Env,
        admin: Address,
        threshold_bps: u32,
    ) -> Result<(), OracleError> {
        admin.require_auth();
        storage::verify_admin(&env, &admin)?;
        storage::set_deviation_threshold(&env, threshold_bps);
        Ok(())
    }

    pub fn get_deviation_threshold(env: Env) -> Option<u32> {
        storage::get_deviation_threshold(&env)
    }

    // -------------------------------------------------------------------------
    // Issue #70 — reputation query and admin reset
    // -------------------------------------------------------------------------

    pub fn get_source_reputation(env: Env, source: Address) -> Option<SourceReputation> {
        let rep = storage::get_source_reputation(&env, &source)?;
        Some(apply_reputation_decay(&env, rep))
    }

    pub fn reset_reputation(
        env: Env,
        admin: Address,
        source: Address,
    ) -> Result<(), OracleError> {
        admin.require_auth();
        storage::verify_admin(&env, &admin)?;
        storage::remove_source_reputation(&env, &source);
        Ok(())
    }

    // -------------------------------------------------------------------------
    // Issue #67 — multi-sig admin control
    // -------------------------------------------------------------------------

    pub fn init_multisig(
        env: Env,
        admin: Address,
        signers: Vec<Address>,
        threshold: u32,
    ) -> Result<(), OracleError> {
        admin.require_auth();
        storage::verify_admin(&env, &admin)?;

        if threshold == 0 || threshold as usize > signers.len() as usize {
            return Err(OracleError::InvalidThreshold);
        }

        let config = MultiSigConfig { signers, threshold };
        storage::set_multisig_config(&env, &config);
        Ok(())
    }

    pub fn create_proposal(
        env: Env,
        proposer: Address,
        action: ProposalAction,
    ) -> Result<u32, OracleError> {
        proposer.require_auth();

        let config = storage::get_multisig_config(&env)
            .ok_or(OracleError::MultiSigNotInitialized)?;

        if !vec_contains_address(&config.signers, &proposer) {
            return Err(OracleError::NotASigner);
        }

        let id = storage::get_proposal_count(&env);
        let mut approvals: Vec<Address> = Vec::new(&env);
        approvals.push_back(proposer.clone());

        let proposal = Proposal {
            id,
            action,
            approvals,
            executed: 0,
            created_at: env.ledger().timestamp(),
            proposer,
        };

        storage::set_proposal(&env, &proposal);
        storage::set_proposal_count(&env, id + 1);

        Ok(id)
    }

    pub fn approve_proposal(
        env: Env,
        signer: Address,
        proposal_id: u32,
    ) -> Result<(), OracleError> {
        signer.require_auth();

        let config = storage::get_multisig_config(&env)
            .ok_or(OracleError::MultiSigNotInitialized)?;

        if !vec_contains_address(&config.signers, &signer) {
            return Err(OracleError::NotASigner);
        }

        let mut proposal = storage::get_proposal(&env, proposal_id)
            .ok_or(OracleError::ProposalNotFound)?;

        if proposal.executed == 1 {
            return Err(OracleError::ProposalAlreadyExecuted);
        }

        if vec_contains_address(&proposal.approvals, &signer) {
            return Err(OracleError::AlreadyApproved);
        }

        proposal.approvals.push_back(signer);
        storage::set_proposal(&env, &proposal);
        Ok(())
    }

    pub fn execute_proposal(
        env: Env,
        signer: Address,
        proposal_id: u32,
    ) -> Result<(), OracleError> {
        signer.require_auth();

        let config = storage::get_multisig_config(&env)
            .ok_or(OracleError::MultiSigNotInitialized)?;

        if !vec_contains_address(&config.signers, &signer) {
            return Err(OracleError::NotASigner);
        }

        let mut proposal = storage::get_proposal(&env, proposal_id)
            .ok_or(OracleError::ProposalNotFound)?;

        if proposal.executed == 1 {
            return Err(OracleError::ProposalAlreadyExecuted);
        }

        if proposal.approvals.len() < config.threshold {
            return Err(OracleError::ThresholdNotMet);
        }

        apply_proposal_action(&env, &proposal.action)?;

        proposal.executed = 1;
        storage::set_proposal(&env, &proposal);
        Ok(())
    }

    pub fn get_proposal(env: Env, proposal_id: u32) -> Option<Proposal> {
        storage::get_proposal(&env, proposal_id)
    }

    pub fn get_multisig_config(env: Env) -> Option<MultiSigConfig> {
        storage::get_multisig_config(&env)
    }

    // -------------------------------------------------------------------------
    // Existing oracle functions
    // -------------------------------------------------------------------------

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

// -------------------------------------------------------------------------
// Issue #69 — deviation helper
// Returns true when the new price deviates from prev_price by more than threshold_bps.
// Uses u128 arithmetic throughout to avoid i128 overflow under any input.
// -------------------------------------------------------------------------
fn deviation_exceeds(new_price: i128, prev_price: i128, threshold_bps: u32) -> bool {
    if prev_price == 0 {
        return false;
    }
    let prev_abs = prev_price.unsigned_abs(); // u128, correct for i128::MIN

    let diff: u128 = if (new_price >= 0) == (prev_price >= 0) {
        // Same sign: simple magnitude difference, no overflow possible.
        let new_abs = new_price.unsigned_abs();
        if new_abs >= prev_abs { new_abs - prev_abs } else { prev_abs - new_abs }
    } else {
        // Opposite signs: |new| + |prev| with saturation guard.
        new_price.unsigned_abs().saturating_add(prev_abs)
    };

    // deviation_bps = diff * 10_000 / prev_abs, saturating to avoid overflow.
    let deviation_bps = diff.saturating_mul(10_000) / prev_abs;
    deviation_bps > threshold_bps as u128
}

// -------------------------------------------------------------------------
// Issue #70 — reputation helpers
// -------------------------------------------------------------------------
fn update_reputation(env: &Env, source: &Address, new_price: i128, asset: &String, timestamp: u64) {
    let is_accurate = match storage::get_latest_price(env, asset) {
        None => true, // initial submission — always accurate
        Some(prev) => !deviation_exceeds(new_price, prev.price, REPUTATION_ACCURACY_THRESHOLD_BPS as u32),
    };

    let mut rep = storage::get_source_reputation(env, source).unwrap_or(SourceReputation {
        score: 10_000,
        total_submissions: 0,
        accurate_submissions: 0,
        last_updated: timestamp,
    });

    rep.total_submissions = rep.total_submissions.saturating_add(1);
    if is_accurate {
        rep.accurate_submissions = rep.accurate_submissions.saturating_add(1);
    }
    rep.score = if rep.total_submissions == 0 {
        10_000
    } else {
        (rep.accurate_submissions as u32)
            .saturating_mul(10_000)
            / rep.total_submissions
    };
    rep.last_updated = timestamp;

    storage::set_source_reputation(env, source, &rep);
}

fn apply_reputation_decay(env: &Env, mut rep: SourceReputation) -> SourceReputation {
    let now = env.ledger().timestamp();
    let elapsed = now.saturating_sub(rep.last_updated);
    if elapsed < REPUTATION_DECAY_PERIOD_SECS {
        return rep;
    }
    let periods = (elapsed / REPUTATION_DECAY_PERIOD_SECS).min(40) as u32;
    for _ in 0..periods {
        rep.score = rep
            .score
            .saturating_mul(REPUTATION_DECAY_NUMERATOR)
            / REPUTATION_DECAY_DENOMINATOR;
    }
    rep
}

// -------------------------------------------------------------------------
// Issue #67 — proposal action executor
// -------------------------------------------------------------------------
fn apply_proposal_action(env: &Env, action: &ProposalAction) -> Result<(), OracleError> {
    match action {
        ProposalAction::AddSource(source, name) => {
            storage::add_source(env, source, name);
        }
        ProposalAction::RemoveSource(source) => {
            storage::remove_source(env, source);
        }
        ProposalAction::SetTrustedAsset(asset, trusted) => {
            storage::set_trusted_asset(env, asset, *trusted != 0);
        }
        ProposalAction::TransferAdmin(new_admin) => {
            storage::set_admin(env, new_admin);
        }
        ProposalAction::SetDeviationThreshold(threshold_bps) => {
            storage::set_deviation_threshold(env, *threshold_bps);
        }
        ProposalAction::ResetReputation(source) => {
            storage::remove_source_reputation(env, source);
        }
        ProposalAction::AddSigner(new_signer) => {
            if let Some(mut config) = storage::get_multisig_config(env) {
                if !vec_contains_address(&config.signers, new_signer) {
                    config.signers.push_back(new_signer.clone());
                    storage::set_multisig_config(env, &config);
                }
            }
        }
        ProposalAction::RemoveSigner(signer) => {
            if let Some(mut config) = storage::get_multisig_config(env) {
                let mut new_signers: Vec<Address> = Vec::new(env);
                for i in 0..config.signers.len() {
                    if let Some(s) = config.signers.get(i) {
                        if &s != signer {
                            new_signers.push_back(s);
                        }
                    }
                }
                config.signers = new_signers;
                storage::set_multisig_config(env, &config);
            }
        }
        ProposalAction::SetThreshold(new_threshold) => {
            if let Some(mut config) = storage::get_multisig_config(env) {
                config.threshold = *new_threshold;
                storage::set_multisig_config(env, &config);
            }
        }
    }
    Ok(())
}

fn vec_contains_address(vec: &Vec<Address>, target: &Address) -> bool {
    for i in 0..vec.len() {
        if let Some(addr) = vec.get(i) {
            if &addr == target {
                return true;
            }
        }
    }
    false
}

fn calculate_usd_price(env: &Env, asset: &String, price: i128, decimals: u32) -> Option<i128> {
    let xlm = String::from_str(env, "XLM");
    if asset == &xlm {
        return Some(price);
    }

    let usdc = String::from_str(env, "USDC");
    if let Some(usdc_anchor) = storage::get_latest_price(env, &usdc) {
        if asset == &usdc {
            return Some(10i128.pow(decimals));
        }
        if let Some(xlm_price) = storage::get_latest_price(env, &xlm) {
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
