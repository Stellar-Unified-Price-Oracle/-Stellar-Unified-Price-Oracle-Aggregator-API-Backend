use soroban_sdk::{contracttype, Address, String};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceDataPoint {
    pub asset: String,
    pub price: i128,
    pub decimals: u32,
    pub timestamp: u64,
    pub source: Address,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssetPrice {
    pub asset: String,
    pub price: i128,
    pub decimals: u32,
    pub price_usd: Option<i128>,
    pub timestamp: u64,
    pub source: Address,
    pub num_sources: u32,
    pub is_trusted: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OracleSource {
    pub address: Address,
    pub name: String,
    pub active: bool,
}

// Issue #70 — source reputation tracking
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SourceReputation {
    pub score: u32,                 // 0-10000 basis points; 10000 = perfect accuracy
    pub total_submissions: u32,
    pub accurate_submissions: u32,
    pub last_updated: u64,          // ledger timestamp of last submission
}

// Issue #67 — multi-sig admin control
#[contracttype]
#[derive(Clone, Debug)]
pub struct MultiSigConfig {
    pub signers: Vec<Address>,
    pub threshold: u32,
}

#[contracttype]
#[derive(Clone, Debug)]
pub enum ProposalAction {
    AddSource(Address, String),     // (source_address, name)
    RemoveSource(Address),
    SetTrustedAsset(String, u32),   // (asset, 1=trusted 0=untrusted, bool avoided for XDR compat)
    TransferAdmin(Address),
    SetDeviationThreshold(u32),     // new threshold in basis points
    ResetReputation(Address),       // source address
    AddSigner(Address),
    RemoveSigner(Address),
    SetThreshold(u32),
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Proposal {
    pub id: u32,
    pub action: ProposalAction,
    pub approvals: Vec<Address>,
    pub executed: u32,              // 0 = pending, 1 = executed (bool avoided for XDR compat)
    pub created_at: u64,
    pub proposer: Address,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Source(Address),
    SourceName(Address),
    LatestPrice(String),
    PriceHistory(String),
    TrustedAsset(String),
    AllAssets,
    SourceCount,
    // Issue #68 — proxy / upgradeability
    Implementation,
    PreviousImplementation,
    ContractVersion,
    StorageLayoutVersion,
    // Issue #69 — deviation threshold
    DeviationThreshold,
    // Issue #70 — reputation
    SourceReputation(Address),
 StakeInfo(Address),
 StakeTreasury,
 SlashHistory(Address, u32),
 SlashCount(Address),
    // Issue #67 — multi-sig
    MultiSigConfig,
    ProposalCount,
    Proposal(u32),
}
