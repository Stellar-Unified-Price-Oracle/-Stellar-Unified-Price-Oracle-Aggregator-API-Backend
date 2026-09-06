use soroban_sdk::{contracttype, Address, Bytes, BytesN, String, Vec};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PostQuantumScheme {
    Dilithium,
    Falcon,
    Sphincs,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PostQuantumAdminKey {
    pub scheme: PostQuantumScheme,
    pub public_key: String,
    pub fingerprint: String,
    pub requested_at: u64,
    pub activates_at: u64,
    pub revoked_at: Option<u64>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HybridSignature {
    pub ed25519_signature: String,
    pub pq_signature: String,
    pub pq_scheme: PostQuantumScheme,
}

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

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BatchPriceEntry {
    pub asset: String,
    pub price: i128,
    pub decimals: u32,
    pub timestamp: u64,
    pub source: Address,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MerkleProof {
    pub leaf_index: u32,
    pub siblings: Vec<Bytes>,
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
    SetTrustedAsset(String, bool),  // (asset, trusted)
    TransferAdmin(Address),
    SetDeviationThreshold(u32),     // new threshold in basis points
    ResetReputation(Address),       // source address
    AddSigner(Address),
    RemoveSigner(Address),
    SetThreshold(u32),
    // Governance-specific actions
    SetAdmin(Address),
    AddOracleSource(Address, String),
    RemoveOracleSource(Address),
    UpdateGovernanceConfig(GovernanceConfig),
    // Issue #379 — multi-region aware emergency pause
    Pause,
    Unpause,
}

// ── Multi-sig types ──────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug)]
pub struct MultiSigProposal {
    pub id: u32,
    pub action: ProposalAction,
    pub approvals: Vec<Address>,
    pub executed: u32,              // 0 = pending, 1 = executed (bool avoided for XDR compat)
    pub created_at: u64,
    pub proposer: Address,
}

/// Governance proposal (token-based voting).  Distinct from MultiSigProposal
/// because the lifecycle includes voting stages, timelock, descriptions, etc.
#[contracttype]
#[derive(Clone, Debug)]
pub struct GovernanceProposal {
    pub id: u32,
    pub proposer: Address,
    pub action: ProposalAction,
    pub description: String,
    pub votes_for: i128,
    pub votes_against: i128,
    pub voting_start: u64,
    pub voting_end: u64,
    pub execution_time: u64,
    pub status: ProposalStatus,
}

/// Lifecycle status of a governance proposal.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProposalStatus {
    Active,
    Queued,
    Ready,
    Executed,
    Defeated,
    Cancelled,
}

/// On-chain governance configuration — voting parameters and token-gating.
#[contracttype]
#[derive(Clone, Debug)]
pub struct GovernanceConfig {
    /// SEP-41 token whose balance determines voting power.
    pub token: Address,
    /// Minimum voting period in ledger seconds.
    pub voting_period: u64,
    /// Minimum delay between passage and execution (timelock).
    pub timelock_delay: u64,
    /// Minimum total votes (for + against) needed for a proposal to pass.
    pub quorum: i128,
    /// Minimum token balance required to create a proposal.
    pub proposal_threshold: i128,
    /// Guardian address empowered to bypass timelock in emergencies.
    pub guardian: Address,
}

// Issue #375 — timelocked, quorum-gated proxy upgrades + canary rollout
#[contracttype]
#[derive(Clone, Debug)]
pub struct PendingProxyUpgrade {
    pub new_wasm_hash: BytesN<32>,
    pub unlock_time: u64,
    pub approvals: Vec<Address>,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct CanaryConfig {
    pub candidate: Address,
    pub share_bps: u32,
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
    BatchNonce,
    BatchRoot(u64),
    BatchAppliedLeaves(u64),
    BatchPruneWatermark,
    QueryFee,
    Whitelist(Address),
    FeeBalance,
    StakeInfo(Address),
    StakeTreasury,
    SlashHistory(Address, u32),
    SlashCount(Address),
    // Issue #67 — multi-sig
    MultiSigConfig,
    MultiSigProposalCount,
    MultiSigProposal(u32),
    // Issue #379 — multi-region aware emergency pause
    Paused,
    // Governance
    GovernanceConfig,
    GovernanceProposalCount,
    GovernanceProposal(u32),
    Vote(u32, Address),
    PostQuantumAdminKey(String),
    PostQuantumKeyLog(u32),
    PostQuantumKeyLogCount,
    // Issue #375 — proxy upgrade timelock + canary
    PendingUpgradeHash,
    PendingUpgradeEta,
    UpgradeApprovals,
    CanaryImplementation,
    CanaryTrafficShareBps,
}
