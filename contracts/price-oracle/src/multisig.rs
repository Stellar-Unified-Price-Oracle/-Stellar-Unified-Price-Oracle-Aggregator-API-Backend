// Issue #67 — Multi-signature admin control for the Soroban price oracle.
//
// Deployment pattern:
//   1. Deploy MultiSigAdminContract with desired signers and threshold.
//   2. On PriceOracleContract (or ProxyContract) call
//      `init_multisig(admin, signers, threshold)` passing the multi-sig
//      contract's address as one of the signers, then transfer admin to this
//      contract's address via a proposal.
//
// Proposal lifecycle:
//   create_proposal → approve_proposal (×N until threshold) → execute_proposal
//
// execute_proposal validates threshold, marks the proposal executed, and
// returns the resolved ProposalAction so the caller can perform any necessary
// follow-up oracle invocations (or chain them in the same transaction via the
// oracle's `execute_multisig_action` entry point).

use soroban_sdk::{contract, contractimpl, Address, Env, Vec};

use crate::errors::OracleError;
use crate::storage;
use crate::types::{MultiSigConfig, Proposal, ProposalAction, SourceReputation};

#[contract]
pub struct MultiSigAdminContract;

#[contractimpl]
impl MultiSigAdminContract {
    // -------------------------------------------------------------------------
    // Initialization
    // -------------------------------------------------------------------------

    pub fn initialize(
        env: Env,
        signers: Vec<Address>,
        threshold: u32,
    ) -> Result<(), OracleError> {
        if threshold == 0 || (threshold as usize) > signers.len() as usize {
            return Err(OracleError::InvalidThreshold);
        }
        let config = MultiSigConfig { signers, threshold };
        storage::set_multisig_config(&env, &config);
        storage::set_proposal_count(&env, 0);
        Ok(())
    }

    // -------------------------------------------------------------------------
    // Proposal lifecycle
    // -------------------------------------------------------------------------

    /// Create a new proposal. The proposer automatically counts as the first approval.
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

    /// Add an approval to an existing proposal.
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

    /// Validate threshold and mark proposal executed. Also applies signer/threshold
    /// mutations to the local multi-sig config. Oracle-side actions (add source,
    /// set threshold, etc.) must be dispatched by the caller or by calling
    /// `PriceOracleContract::execute_multisig_action` in the same transaction.
    pub fn execute_proposal(
        env: Env,
        signer: Address,
        proposal_id: u32,
    ) -> Result<ProposalAction, OracleError> {
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

        // Apply signer/threshold mutations that only affect the multi-sig itself.
        apply_local_multisig_action(&env, &proposal.action);

        proposal.executed = 1;
        let action = proposal.action.clone();
        storage::set_proposal(&env, &proposal);

        Ok(action)
    }

    // -------------------------------------------------------------------------
    // Queries
    // -------------------------------------------------------------------------

    pub fn get_proposal(env: Env, proposal_id: u32) -> Option<Proposal> {
        storage::get_proposal(&env, proposal_id)
    }

    pub fn get_config(env: Env) -> Option<MultiSigConfig> {
        storage::get_multisig_config(&env)
    }

    pub fn get_signers(env: Env) -> Vec<Address> {
        storage::get_multisig_config(&env)
            .map(|c| c.signers)
            .unwrap_or(Vec::new(&env))
    }

    pub fn get_threshold(env: Env) -> u32 {
        storage::get_multisig_config(&env)
            .map(|c| c.threshold)
            .unwrap_or(0)
    }

    pub fn get_proposal_count(env: Env) -> u32 {
        storage::get_proposal_count(&env)
    }

    pub fn get_source_reputation(env: Env, source: Address) -> Option<SourceReputation> {
        storage::get_source_reputation(&env, &source)
    }
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

fn apply_local_multisig_action(env: &Env, action: &ProposalAction) {
    match action {
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
        _ => {}
    }
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
