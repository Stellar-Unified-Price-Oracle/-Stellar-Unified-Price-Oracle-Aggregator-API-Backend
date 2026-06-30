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

// ── Governance types ──────────────────────────────────────────────────────────

/// What a proposal wants to change when executed.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProposalAction {
    /// Replace the contract admin.
    SetAdmin(Address),
    /// Authorise a new oracle source.
    AddOracleSource(Address, String),
    /// Revoke an oracle source.
    RemoveOracleSource(Address),
    /// Mark or unmark an asset as trusted.
    SetTrustedAsset(String, bool),
    /// Update the governance configuration itself.
    UpdateGovernanceConfig(GovernanceConfig),
}

/// Lifecycle state of a proposal.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProposalStatus {
    /// Voting window is open.
    Active,
    /// Voting passed; waiting for the time-lock delay.
    Queued,
    /// Time-lock elapsed; ready to execute.
    Ready,
    /// Successfully executed.
    Executed,
    /// Defeated (quorum not met or more votes against).
    Defeated,
    /// Cancelled by the proposer or admin.
    Cancelled,
}

/// A governance proposal.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Proposal {
    pub id: u32,
    pub proposer: Address,
    pub action: ProposalAction,
    pub description: String,
    pub votes_for: i128,
    pub votes_against: i128,
    /// Ledger timestamp when voting opens.
    pub voting_start: u64,
    /// Ledger timestamp when voting closes.
    pub voting_end: u64,
    /// Ledger timestamp after which execution is allowed (voting_end + timelock_delay).
    pub execution_time: u64,
    pub status: ProposalStatus,
}

/// Tunable governance parameters (can themselves be changed via a proposal).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GovernanceConfig {
    /// Governance token contract address (SEP-41 / token interface).
    pub token: Address,
    /// Minimum token balance to create a proposal (scaled to token decimals).
    pub proposal_threshold: i128,
    /// Seconds a voting window stays open.
    pub voting_period: u64,
    /// Seconds between voting_end and earliest execution.
    pub timelock_delay: u64,
    /// Minimum total votes (for + against) for a proposal to be valid.
    pub quorum: i128,
    /// Address allowed to execute emergency overrides without a time-lock.
    pub guardian: Address,
}

// ── Storage keys ─────────────────────────────────────────────────────────────

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
    // Proxy pattern keys
    Implementation,
    PreviousImplementation,
    ContractVersion,
    // Governance keys
    GovConfig,
    ProposalCount,
    Proposal(u32),
    /// Has `voter` cast a vote on proposal `id`?  value: bool (true=for, false=against)
    Vote(u32, Address),
}
