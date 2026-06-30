use soroban_sdk::{contract, contractimpl, Address, Env, String};

use crate::errors::OracleError;
use crate::storage;
use crate::types::{GovernanceConfig, Proposal, ProposalAction, ProposalStatus};

// SEP-41 token interface — only the balance query is needed.
mod token {
    use soroban_sdk::{contractclient, Address, Env};

    #[contractclient(name = "TokenClient")]
    pub trait Token {
        fn balance(env: Env, id: Address) -> i128;
    }
}

use token::TokenClient;

// ── Helpers ──────────────────────────────────────────────────────────────────

fn require_gov(env: &Env) -> Result<GovernanceConfig, OracleError> {
    storage::get_gov_config(env).ok_or(OracleError::GovernanceNotInitialized)
}

fn voting_power(env: &Env, config: &GovernanceConfig, account: &Address) -> i128 {
    TokenClient::new(env, &config.token).balance(env.clone(), account.clone())
}

fn resolve_proposal(env: &Env, proposal: &mut Proposal, config: &GovernanceConfig) {
    if matches!(proposal.status, ProposalStatus::Active) {
        let now = env.ledger().timestamp();
        if now >= proposal.voting_end {
            let quorum_met = proposal.votes_for + proposal.votes_against >= config.quorum;
            if quorum_met && proposal.votes_for > proposal.votes_against {
                proposal.status = ProposalStatus::Queued;
                proposal.execution_time = proposal.voting_end + config.timelock_delay;
            } else {
                proposal.status = ProposalStatus::Defeated;
            }
        }
    }
}

fn apply_action(env: &Env, action: &ProposalAction) {
    match action {
        ProposalAction::SetAdmin(new_admin) => {
            storage::set_admin(env, new_admin);
        }
        ProposalAction::AddOracleSource(source, name) => {
            storage::add_source(env, source, name);
        }
        ProposalAction::RemoveOracleSource(source) => {
            storage::remove_source(env, source);
        }
        ProposalAction::SetTrustedAsset(asset, trusted) => {
            storage::set_trusted_asset(env, asset, *trusted);
        }
        ProposalAction::UpdateGovernanceConfig(new_config) => {
            storage::set_gov_config(env, new_config);
        }
    }
}

// ── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct GovernanceContract;

#[contractimpl]
impl GovernanceContract {
    /// Bootstrap the governance contract.  Sets the initial admin and governance
    /// config in a single call.  Can only be called once.
    pub fn initialize(
        env: Env,
        admin: Address,
        config: GovernanceConfig,
    ) -> Result<(), OracleError> {
        admin.require_auth();

        if storage::get_gov_config(&env).is_some() {
            return Err(OracleError::GovernanceAlreadyInitialized);
        }

        validate_config(&config)?;
        storage::set_admin(&env, &admin);
        storage::set_gov_config(&env, &config);
        Ok(())
    }

    /// Create a new proposal.  Caller must hold ≥ `proposal_threshold` tokens.
    pub fn propose(
        env: Env,
        proposer: Address,
        action: ProposalAction,
        description: String,
    ) -> Result<u32, OracleError> {
        proposer.require_auth();
        let config = require_gov(&env)?;

        let power = voting_power(&env, &config, &proposer);
        if power < config.proposal_threshold {
            return Err(OracleError::InsufficientVotingPower);
        }

        let id = storage::increment_proposal_count(&env);
        let now = env.ledger().timestamp();

        let proposal = Proposal {
            id,
            proposer: proposer.clone(),
            action,
            description,
            votes_for: 0,
            votes_against: 0,
            voting_start: now,
            voting_end: now + config.voting_period,
            execution_time: now + config.voting_period + config.timelock_delay,
            status: ProposalStatus::Active,
        };

        storage::set_proposal(&env, &proposal);
        Ok(id)
    }

    /// Cast a vote on an active proposal.
    /// `support = true` → vote for; `support = false` → vote against.
    pub fn vote(
        env: Env,
        voter: Address,
        proposal_id: u32,
        support: bool,
    ) -> Result<(), OracleError> {
        voter.require_auth();
        let config = require_gov(&env)?;

        let mut proposal = storage::get_proposal(&env, proposal_id)
            .ok_or(OracleError::ProposalNotFound)?;

        let now = env.ledger().timestamp();
        if !matches!(proposal.status, ProposalStatus::Active)
            || now < proposal.voting_start
            || now >= proposal.voting_end
        {
            return Err(OracleError::VotingNotActive);
        }

        if storage::has_voted(&env, proposal_id, &voter) {
            return Err(OracleError::AlreadyVoted);
        }

        let power = voting_power(&env, &config, &voter);
        if support {
            proposal.votes_for += power;
        } else {
            proposal.votes_against += power;
        }

        storage::record_vote(&env, proposal_id, &voter, support);
        storage::set_proposal(&env, &proposal);
        Ok(())
    }

    /// Queue a passed proposal (transitions Active→Queued after voting_end).
    /// Anyone can call this once the voting window has closed.
    pub fn queue(env: Env, proposal_id: u32) -> Result<(), OracleError> {
        let config = require_gov(&env)?;

        let mut proposal = storage::get_proposal(&env, proposal_id)
            .ok_or(OracleError::ProposalNotFound)?;

        resolve_proposal(&env, &mut proposal, &config);

        match proposal.status {
            ProposalStatus::Queued | ProposalStatus::Ready => {
                storage::set_proposal(&env, &proposal);
                Ok(())
            }
            ProposalStatus::Defeated => Err(OracleError::ProposalDefeated),
            ProposalStatus::Executed => Err(OracleError::ProposalAlreadyExecuted),
            ProposalStatus::Cancelled => Err(OracleError::ProposalCancelled),
            ProposalStatus::Active => Err(OracleError::VotingNotActive),
        }
    }

    /// Execute a queued proposal whose time-lock has elapsed.
    pub fn execute(env: Env, proposal_id: u32) -> Result<(), OracleError> {
        let config = require_gov(&env)?;

        let mut proposal = storage::get_proposal(&env, proposal_id)
            .ok_or(OracleError::ProposalNotFound)?;

        resolve_proposal(&env, &mut proposal, &config);

        match proposal.status {
            ProposalStatus::Queued | ProposalStatus::Ready => {}
            ProposalStatus::Executed => return Err(OracleError::ProposalAlreadyExecuted),
            ProposalStatus::Cancelled => return Err(OracleError::ProposalCancelled),
            ProposalStatus::Defeated => return Err(OracleError::ProposalDefeated),
            ProposalStatus::Active => return Err(OracleError::VotingNotActive),
        }

        let now = env.ledger().timestamp();
        if now < proposal.execution_time {
            return Err(OracleError::TimeLockNotElapsed);
        }

        proposal.status = ProposalStatus::Executed;
        storage::set_proposal(&env, &proposal);

        apply_action(&env, &proposal.action);
        Ok(())
    }

    /// Cancel a proposal.  Only the original proposer or the contract admin may cancel.
    pub fn cancel(env: Env, caller: Address, proposal_id: u32) -> Result<(), OracleError> {
        caller.require_auth();
        require_gov(&env)?;

        let mut proposal = storage::get_proposal(&env, proposal_id)
            .ok_or(OracleError::ProposalNotFound)?;

        match proposal.status {
            ProposalStatus::Executed => return Err(OracleError::ProposalAlreadyExecuted),
            ProposalStatus::Cancelled => return Err(OracleError::ProposalCancelled),
            _ => {}
        }

        let is_proposer = proposal.proposer == caller;
        let is_admin = storage::verify_admin(&env, &caller).is_ok();
        if !is_proposer && !is_admin {
            return Err(OracleError::AdminOnly);
        }

        proposal.status = ProposalStatus::Cancelled;
        storage::set_proposal(&env, &proposal);
        Ok(())
    }

    /// Emergency override: the guardian bypasses the time-lock and executes immediately.
    /// Intended for critical fixes (e.g. a compromised oracle source).
    pub fn emergency_execute(
        env: Env,
        guardian: Address,
        proposal_id: u32,
    ) -> Result<(), OracleError> {
        guardian.require_auth();
        let config = require_gov(&env)?;

        if guardian != config.guardian {
            return Err(OracleError::GuardianOnly);
        }

        let mut proposal = storage::get_proposal(&env, proposal_id)
            .ok_or(OracleError::ProposalNotFound)?;

        match proposal.status {
            ProposalStatus::Executed => return Err(OracleError::ProposalAlreadyExecuted),
            ProposalStatus::Cancelled => return Err(OracleError::ProposalCancelled),
            _ => {}
        }

        proposal.status = ProposalStatus::Executed;
        storage::set_proposal(&env, &proposal);

        apply_action(&env, &proposal.action);
        Ok(())
    }

    /// Read a proposal by id.
    pub fn get_proposal(env: Env, proposal_id: u32) -> Option<Proposal> {
        storage::get_proposal(&env, proposal_id)
    }

    /// Total number of proposals created (also the id of the most recent one).
    pub fn proposal_count(env: Env) -> u32 {
        storage::get_proposal_count(&env)
    }

    /// Check whether `voter` has already voted on `proposal_id`.
    pub fn has_voted(env: Env, proposal_id: u32, voter: Address) -> bool {
        storage::has_voted(&env, proposal_id, &voter)
    }

    /// Return the current governance configuration.
    pub fn get_governance_config(env: Env) -> Option<GovernanceConfig> {
        storage::get_gov_config(&env)
    }
}

// ── Validation ────────────────────────────────────────────────────────────────

fn validate_config(config: &GovernanceConfig) -> Result<(), OracleError> {
    if config.voting_period == 0
        || config.quorum <= 0
        || config.proposal_threshold <= 0
    {
        return Err(OracleError::InvalidGovernanceConfig);
    }
    Ok(())
}
