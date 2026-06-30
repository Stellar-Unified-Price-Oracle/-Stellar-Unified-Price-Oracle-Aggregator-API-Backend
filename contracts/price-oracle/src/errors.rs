use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum OracleError {
    UnauthorizedSource = 1,
    AdminOnly = 2,
    AssetNotFound = 3,
    PriceTooOld = 4,
    InvalidDecimals = 5,
    AlreadyInitialized = 6,
    SourceAlreadyExists = 7,
    // Governance errors
    GovernanceNotInitialized = 8,
    GovernanceAlreadyInitialized = 9,
    InsufficientVotingPower = 10,
    ProposalNotFound = 11,
    VotingNotActive = 12,
    AlreadyVoted = 13,
    ProposalNotQueued = 14,
    TimeLockNotElapsed = 15,
    ProposalDefeated = 16,
    ProposalAlreadyExecuted = 17,
    ProposalCancelled = 18,
    GuardianOnly = 19,
    InvalidGovernanceConfig = 20,
}
