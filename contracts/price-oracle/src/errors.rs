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
    // Issue #69 — price deviation validation
    PriceDeviationTooLarge = 8,
    // Issue #67 — multi-sig admin
    NotASigner = 9,
    ProposalNotFound = 10,
    ProposalAlreadyExecuted = 11,
    AlreadyApproved = 12,
    InvalidThreshold = 13,
    ThresholdNotMet = 14,
    MultiSigNotInitialized = 15,
    // Governance errors
    GovernanceNotInitialized = 16,
    GovernanceAlreadyInitialized = 17,
    InsufficientVotingPower = 18,
    ProposalDefeated = 19,
    ProposalCancelled = 20,
    VotingNotActive = 21,
    AlreadyVoted = 22,
    TimeLockNotElapsed = 23,
    GuardianOnly = 24,
    InvalidGovernanceConfig = 25,
    InvalidMerkleProof = 26,
    BatchNonceMismatch = 27,
    BatchRootNotFound = 28,
    // Issue #375 — proxy upgrade timelock + canary
    UpgradeNotProposed = 29,
    UpgradeTimelockNotElapsed = 30,
    UpgradeAlreadyApproved = 31,
    InvalidPrice = 32,
    // Issue #379 — multi-region aware emergency pause
    ContractPaused = 33,
    // Issue #385 — Merkle batch replay resistance
    BatchEntryAlreadyApplied = 34,
}
