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
}
