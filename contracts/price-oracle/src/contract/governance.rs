// Issue #297 — multi-sig proposal lifecycle and emergency pause, extracted
// from contract.rs.  (Token-based governance lives in crate::governance;
// this module covers the multi-sig admin path that operates directly on
// PriceOracleContract storage.)

use soroban_sdk::{Address, Env, Vec};

use crate::errors::OracleError;
use crate::storage;
use crate::types::{MultiSigConfig, MultiSigProposal, ProposalAction};

use crate::utils;

pub(crate) fn init_multisig(
    env: &Env,
    admin: &Address,
    signers: &Vec<Address>,
    threshold: u32,
) -> Result<(), OracleError> {
    admin.require_auth();
    storage::verify_admin(env, admin)?;

    if threshold == 0 || threshold as usize > signers.len() as usize {
        return Err(OracleError::InvalidThreshold);
    }

    let config = MultiSigConfig {
        signers: signers.clone(),
        threshold,
    };
    storage::set_multisig_config(env, &config);
    Ok(())
}

pub(crate) fn create_proposal(
    env: &Env,
    proposer: &Address,
    action: &ProposalAction,
) -> Result<u32, OracleError> {
    proposer.require_auth();

    let config = storage::get_multisig_config(env).ok_or(OracleError::MultiSigNotInitialized)?;

    if !utils::vec_contains_address(&config.signers, proposer) {
        return Err(OracleError::NotASigner);
    }

    let id = storage::get_msig_proposal_count(env);
    let mut approvals: Vec<Address> = Vec::new(env);
    approvals.push_back(proposer.clone());

    let proposal = MultiSigProposal {
        id,
        action: action.clone(),
        approvals,
        executed: 0,
        created_at: env.ledger().timestamp(),
        proposer: proposer.clone(),
    };

    storage::set_multisig_proposal(env, &proposal);
    storage::set_proposal_count(env, id + 1);

    Ok(id)
}

pub(crate) fn approve_proposal(
    env: &Env,
    signer: &Address,
    proposal_id: u32,
) -> Result<(), OracleError> {
    signer.require_auth();

    let config = storage::get_multisig_config(env).ok_or(OracleError::MultiSigNotInitialized)?;

    if !utils::vec_contains_address(&config.signers, signer) {
        return Err(OracleError::NotASigner);
    }

    let mut proposal =
        storage::get_multisig_proposal(env, proposal_id).ok_or(OracleError::ProposalNotFound)?;

    if proposal.executed == 1 {
        return Err(OracleError::ProposalAlreadyExecuted);
    }

    if utils::vec_contains_address(&proposal.approvals, signer) {
        return Err(OracleError::AlreadyApproved);
    }

    proposal.approvals.push_back(signer.clone());
    storage::set_multisig_proposal(env, &proposal);
    Ok(())
}

pub(crate) fn execute_proposal(
    env: &Env,
    signer: &Address,
    proposal_id: u32,
) -> Result<(), OracleError> {
    signer.require_auth();

    let config = storage::get_multisig_config(env).ok_or(OracleError::MultiSigNotInitialized)?;

    if !utils::vec_contains_address(&config.signers, signer) {
        return Err(OracleError::NotASigner);
    }

    let mut proposal =
        storage::get_multisig_proposal(env, proposal_id).ok_or(OracleError::ProposalNotFound)?;

    if proposal.executed == 1 {
        return Err(OracleError::ProposalAlreadyExecuted);
    }

    if proposal.approvals.len() < config.threshold {
        return Err(OracleError::ThresholdNotMet);
    }

    apply_proposal_action(env, &proposal.action)?;

    proposal.executed = 1;
    storage::set_multisig_proposal(env, &proposal);

    env.events()
        .publish(("governance_executed", signer.clone()), proposal_id);

    Ok(())
}

pub(crate) fn get_proposal(env: &Env, proposal_id: u32) -> Option<MultiSigProposal> {
    storage::get_multisig_proposal(env, proposal_id)
}

pub(crate) fn get_multisig_config(env: &Env) -> Option<MultiSigConfig> {
    storage::get_multisig_config(env)
}

// ── Issue #379 — multi-region aware emergency pause ──────────────────────────

/// Read-only pause flag. Off-chain aggregators in every region poll this
/// on their normal cycle and skip submission while it is `true`, so all
/// regions honor the freeze within one poll cycle without a separate
/// off-chain coordination bus — the chain itself is the single source of
/// truth for pause state.
pub(crate) fn is_paused(env: &Env) -> bool {
    storage::is_paused(env)
}

// ── Issue #67 — proposal action executor ─────────────────────────────────────

pub(crate) fn apply_proposal_action(
    env: &Env,
    action: &ProposalAction,
) -> Result<(), OracleError> {
    match action {
        ProposalAction::AddSource(source, name) => {
            storage::add_source(env, source, name);
        }
        ProposalAction::RemoveSource(source) => {
            storage::remove_source(env, source);
        }
        ProposalAction::SetTrustedAsset(asset, trusted) => {
            storage::set_trusted_asset(env, asset, *trusted);
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
                if !utils::vec_contains_address(&config.signers, new_signer) {
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
        ProposalAction::Pause => {
            storage::set_paused(env, true);
        }
        ProposalAction::Unpause => {
            storage::set_paused(env, false);
        }
        _ => {}
    }
    Ok(())
}
