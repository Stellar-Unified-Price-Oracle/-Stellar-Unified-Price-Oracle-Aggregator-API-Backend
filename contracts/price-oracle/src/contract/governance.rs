// Issue #297 — multi-sig proposal lifecycle and emergency pause, extracted
// from contract.rs.  (Token-based governance lives in crate::governance;
// this module covers the multi-sig admin path that operates directly on
// PriceOracleContract storage.)
//
// Fixes applied here:
//   #562 — signer/threshold mutation invariants (bounds, duplicates, min/max)
//   #563 — proposal expiry, cancellation, and hard-failure on unknown actions

use soroban_sdk::{Address, Env, Vec};

use crate::errors::OracleError;
use crate::events::{GovernanceExecuted, MultiSigApproved, MultiSigCancelled, MultiSigProposed};
use crate::storage;
use crate::types::{
    MultiSigConfig, MultiSigProposal, ProposalAction, MAX_SIGNERS, MIN_SIGNERS,
    PROPOSAL_EXPIRY_SECONDS,
};
use crate::utils;

pub(crate) fn init_multisig(
    env: &Env,
    admin: &Address,
    signers: &Vec<Address>,
    threshold: u32,
) -> Result<(), OracleError> {
    admin.require_auth();
    storage::verify_admin(env, admin)?;

    validate_multisig_config(env, signers, threshold)?;

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

    // Reject governance-only actions that this multi-sig path cannot handle
    // (#563 — no silent no-ops).
    ensure_action_supported(action)?;

    let id = storage::get_msig_proposal_count(env);
    let mut approvals: Vec<Address> = Vec::new(env);
    approvals.push_back(proposer.clone());

    let proposal = MultiSigProposal {
        id,
        action: action.clone(),
        approvals,
        executed: 0,
        cancelled: 0,
        created_at: env.ledger().timestamp(),
        proposer: proposer.clone(),
    };

    storage::set_multisig_proposal(env, &proposal);
    storage::set_proposal_count(env, id + 1);

    MultiSigProposed {
        proposer: proposer.clone(),
        proposal_id: id,
    }
    .publish(env);

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

    if proposal.cancelled == 1 {
        return Err(OracleError::ProposalCancelledError);
    }

    // #563 — reject approval of expired proposals
    if env.ledger().timestamp() > proposal.created_at + PROPOSAL_EXPIRY_SECONDS {
        return Err(OracleError::ProposalExpired);
    }

    if utils::vec_contains_address(&proposal.approvals, signer) {
        return Err(OracleError::AlreadyApproved);
    }

    proposal.approvals.push_back(signer.clone());
    storage::set_multisig_proposal(env, &proposal);

    MultiSigApproved {
        signer: signer.clone(),
        proposal_id,
    }
    .publish(env);

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

    if proposal.cancelled == 1 {
        return Err(OracleError::ProposalCancelledError);
    }

    // #563 — reject execution of expired proposals
    if env.ledger().timestamp() > proposal.created_at + PROPOSAL_EXPIRY_SECONDS {
        return Err(OracleError::ProposalExpired);
    }

    if proposal.approvals.len() < config.threshold {
        return Err(OracleError::ThresholdNotMet);
    }

    apply_proposal_action(env, &proposal.action)?;

    proposal.executed = 1;
    storage::set_multisig_proposal(env, &proposal);

    GovernanceExecuted {
        signer: signer.clone(),
        proposal_id,
    }
    .publish(env);

    Ok(())
}

/// Cancel a proposal.  Only the original proposer or any current signer may
/// cancel.  A cancelled proposal cannot be approved or executed.
pub(crate) fn cancel_proposal(
    env: &Env,
    caller: &Address,
    proposal_id: u32,
) -> Result<(), OracleError> {
    caller.require_auth();

    let config = storage::get_multisig_config(env).ok_or(OracleError::MultiSigNotInitialized)?;

    let mut proposal =
        storage::get_multisig_proposal(env, proposal_id).ok_or(OracleError::ProposalNotFound)?;

    if proposal.executed == 1 {
        return Err(OracleError::ProposalAlreadyExecuted);
    }

    if proposal.cancelled == 1 {
        return Err(OracleError::ProposalCancelledError);
    }

    // Must be the proposer or a current signer.
    let is_proposer = &proposal.proposer == caller;
    let is_signer = utils::vec_contains_address(&config.signers, caller);
    if !is_proposer && !is_signer {
        return Err(OracleError::NotASigner);
    }

    proposal.cancelled = 1;
    storage::set_multisig_proposal(env, &proposal);

    MultiSigCancelled {
        proposal_id,
        cancelled_by: caller.clone(),
    }
    .publish(env);

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

// ── Internal helpers ─────────────────────────────────────────────────────────

/// Validate a prospective multisig configuration:
///   - threshold must be >= 1 and <= signers.len()
///   - signers.len() must be >= MIN_SIGNERS and <= MAX_SIGNERS
///   - no duplicate signers
///
/// (#562)
fn validate_multisig_config(
    env: &Env,
    signers: &Vec<Address>,
    threshold: u32,
) -> Result<(), OracleError> {
    let len = signers.len();

    if len < MIN_SIGNERS {
        return Err(OracleError::InsufficientSigners);
    }
    if len > MAX_SIGNERS {
        return Err(OracleError::TooManySigners);
    }
    if threshold == 0 || threshold > len {
        return Err(OracleError::InvalidThreshold);
    }

    // Duplicate check — O(n²) but n <= MAX_SIGNERS (20) so cost is bounded
    let mut dedup: Vec<Address> = Vec::new(env);
    for i in 0..len {
        if let Some(s) = signers.get(i) {
            if utils::vec_contains_address(&dedup, &s) {
                return Err(OracleError::DuplicateSigner);
            }
            dedup.push_back(s);
        }
    }

    Ok(())
}

/// Return `Err(UnsupportedProposalAction)` for variants that can only be
/// dispatched through the token-based governance path, or that have no
/// handler here.  This prevents the `_ => {}` silent-no-op bug (#563).
fn ensure_action_supported(action: &ProposalAction) -> Result<(), OracleError> {
    match action {
        ProposalAction::AddSource(_, _)
        | ProposalAction::RemoveSource(_)
        | ProposalAction::SetTrustedAsset(_, _)
        | ProposalAction::TransferAdmin(_)
        | ProposalAction::SetDeviationThreshold(_)
        | ProposalAction::ResetReputation(_)
        | ProposalAction::AddSigner(_)
        | ProposalAction::RemoveSigner(_)
        | ProposalAction::SetThreshold(_)
        | ProposalAction::Pause
        | ProposalAction::Unpause => Ok(()),
        // These are governance-token-path-only variants; reject at proposal
        // creation so they can never silently succeed here.
        ProposalAction::SetAdmin(_)
        | ProposalAction::AddOracleSource(_, _)
        | ProposalAction::RemoveOracleSource(_)
        | ProposalAction::UpdateGovernanceConfig(_) => Err(OracleError::UnsupportedProposalAction),
    }
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
        // #562 — validate the resulting config before writing it
        ProposalAction::AddSigner(new_signer) => {
            let mut config = storage::get_multisig_config(env)
                .ok_or(OracleError::MultiSigNotInitialized)?;
            if utils::vec_contains_address(&config.signers, new_signer) {
                return Err(OracleError::DuplicateSigner);
            }
            if config.signers.len() >= MAX_SIGNERS {
                return Err(OracleError::TooManySigners);
            }
            config.signers.push_back(new_signer.clone());
            // threshold remains valid: adding a signer cannot violate threshold <= len
            storage::set_multisig_config(env, &config);
        }
        ProposalAction::RemoveSigner(signer) => {
            let mut config = storage::get_multisig_config(env)
                .ok_or(OracleError::MultiSigNotInitialized)?;
            let new_len = config.signers.len().saturating_sub(1);
            if new_len < MIN_SIGNERS {
                return Err(OracleError::InsufficientSigners);
            }
            if config.threshold > new_len {
                return Err(OracleError::InvalidThreshold);
            }
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
        ProposalAction::SetThreshold(new_threshold) => {
            let mut config = storage::get_multisig_config(env)
                .ok_or(OracleError::MultiSigNotInitialized)?;
            if *new_threshold == 0 || *new_threshold > config.signers.len() {
                return Err(OracleError::InvalidThreshold);
            }
            config.threshold = *new_threshold;
            storage::set_multisig_config(env, &config);
        }
        ProposalAction::Pause => {
            storage::set_paused(env, true);
        }
        ProposalAction::Unpause => {
            storage::set_paused(env, false);
        }
        // #563 — governance-token-path variants are hard failures here
        ProposalAction::SetAdmin(_)
        | ProposalAction::AddOracleSource(_, _)
        | ProposalAction::RemoveOracleSource(_)
        | ProposalAction::UpdateGovernanceConfig(_) => {
            return Err(OracleError::UnsupportedProposalAction);
        }
    }
    Ok(())
}
