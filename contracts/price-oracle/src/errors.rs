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
}
