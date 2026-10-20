use soroban_sdk::{contracttype, Address, Bytes, BytesN, String, Symbol, Vec};

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

// Issue #726 — stable contract read snapshot interface.
//
// A `PriceSnapshot` is a mutually consistent view of a published price and
// every piece of metadata a consumer needs to reason about it. All fields are
// captured atomically from the same ledger state, so a consumer never observes
// a price paired with a timestamp or policy version from a different write.
//
// Trust assumptions (see docs/PRICE_EVIDENCE.md):
//   * `submission_timestamp` is the ledger timestamp at which the source
//     submitted the price; it is set by the contract, not the caller.
//   * `observation_timestamp` is the ledger timestamp at which this snapshot
//     was produced. Consumers should bound `observation_timestamp -
//     submission_timestamp` by their own staleness policy.
//   * `policy_version` identifies the aggregation/trust policy in force when
//     the snapshot was produced. A consumer that does not recognise the
//     version MUST treat the snapshot as unverifiable.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceSnapshot {
    pub asset: String,
    pub price: i128,
    pub decimals: u32,
    pub price_usd: Option<i128>,
    /// Ledger timestamp of the underlying price submission.
    pub submission_timestamp: u64,
    /// Ledger timestamp at which this snapshot was produced.
    pub observation_timestamp: u64,
    /// Aggregation/trust policy version in force for this snapshot.
    pub policy_version: u32,
    /// Version of the snapshot layout itself (see `SNAPSHOT_VERSION`).
    pub snapshot_version: u32,
    /// Evidence binding the price to its inputs; `None` when the contract is
    /// not configured to emit evidence for this asset.
    pub evidence: Option<PriceEvidence>,
}

/// Version of the `PriceSnapshot` layout. Bumped whenever fields are added,
/// removed, or their meaning changes. Consumers MUST reject snapshots whose
/// `snapshot_version` they do not understand.
pub const SNAPSHOT_VERSION: u32 = 1;

/// Version of the `PriceEvidence` layout.
pub const EVIDENCE_VERSION: u32 = 1;

/// Issue #724 — consumer-verifiable evidence for a published price.
///
/// The evidence is a self-describing record of *how* a price was produced so a
/// consumer can independently check it against the trust assumptions it
/// accepts. It does not itself prove correctness; it commits to the inputs and
/// the policy so the consumer can decide whether to trust the result.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceEvidence {
    /// Version of this evidence layout (see `EVIDENCE_VERSION`).
    pub evidence_version: u32,
    /// Policy version the evidence was produced under. Must match the
    /// snapshot's `policy_version` or the evidence is rejected.
    pub policy_version: u32,
    /// The set of sources whose submissions contributed to the price.
    pub sources: Vec<Address>,
    /// Number of source submissions aggregated (may exceed `sources.len()`
    /// when a single source submitted more than once in the window).
    pub num_submissions: u32,
    /// Aggregation method applied to the submissions.
    pub aggregation: AggregationMethod,
    /// Merkle root committing to the per-submission leaves, when the price was
    /// derived from a committed batch. `None` for direct submissions.
    pub merkle_root: Option<BytesN<32>>,
    /// Batch nonce the `merkle_root` belongs to, when applicable.
    pub batch_nonce: Option<u64>,
    /// Hash of the attestation record (e.g. signed source set) backing the
    /// evidence, when the deployment uses attestations.
    pub attestation_hash: Option<BytesN<32>>,
}

/// How multiple source submissions were combined into the published price.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AggregationMethod {
    /// A single source submission, used verbatim.
    Single,
    /// Arithmetic median of the submissions.
    Median,
    /// Arithmetic mean of the submissions.
    Mean,
    /// Median after discarding the lowest and highest submissions.
    TrimmedMedian,
}

// Issue #70 — source reputation tracking
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SourceReputation {
    pub score: u32, // 0-10000 basis points; 10000 = perfect accuracy
    pub total_submissions: u32,
    pub accurate_submissions: u32,
    pub last_updated: u64, // ledger timestamp of last submission
}

// Issue #67 — multi-sig admin control
#[contracttype]
#[derive(Clone, Debug)]
pub struct MultiSigConfig {
    pub signers: Vec<Address>,
    pub threshold: u32,
}

/// Maximum number of signers the multisig may hold.
/// Bounded to keep instance-storage serialisation size predictable.
pub const MAX_SIGNERS: u32 = 20;

/// Minimum number of signers required at all times (prevents bricking by
/// removing every signer).
pub const MIN_SIGNERS: u32 = 2;

/// Proposal TTL in ledger seconds (~5 s/ledger on mainnet).
/// After this window the proposal can no longer be approved or executed.
/// 30 days = 30 * 24 * 60 * 60 = 2_592_000 seconds.
pub const PROPOSAL_EXPIRY_SECONDS: u64 = 2_592_000;

#[contracttype]
#[derive(Clone, Debug)]
pub enum ProposalAction {
    AddSource(Address, String), // (source_address, name)
    RemoveSource(Address),
    SetTrustedAsset(String, bool), // (asset, trusted)
    TransferAdmin(Address),
    SetDeviationThreshold(u32), // new threshold in basis points
    ResetReputation(Address),   // source address
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
    // Issue #564 — Proposal action for setting stake treasury
    SetStakeTreasury(Address),
    // Issue #569 — Governed decimals change
    UpdateAssetDecimals(String, u32),
    // Issue #725 — Feed catalog version commitment
    CommitFeedCatalog(u32, BytesN<32>),
}

// Issue #725 — On-chain feed catalog commitment
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeedCatalogCommitment {
    pub version: u32,
    pub catalog_hash: BytesN<32>,
    pub updated_at: u64,
    pub publisher: Address,
}

// ── Multi-sig types ──────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug)]
pub struct MultiSigProposal {
    pub id: u32,
    pub action: ProposalAction,
    pub approvals: Vec<Address>,
    pub executed: u32,   // 0 = pending, 1 = executed (bool avoided for XDR compat)
    pub cancelled: u32,  // 0 = active, 1 = cancelled
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
    Paused,
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
    // Issue #567 — committed entry count per batch (enables leaf_index < batch_size check)
    BatchSize(u64),
    BatchAppliedLeaves(u64),
    BatchPruneWatermark,
    QueryFee,
    Whitelist(Address),
    FeeBalance,
    FeeToken,
    StakeInfo(Address),
    StakeToken(Address),
    StakeTreasury,
    SlashHistory(Address, u32),
    SlashCount(Address),
    // Issue #67 — multi-sig
    MultiSigConfig,
    ProposalCount,
    MultiSigProposalCount,
    MultiSigProposal(u32),
    // Governance
    GovernanceConfig,
    GovernanceProposalCount,
    GovernanceProposal(u32),
    Vote(u32, Address),
    PostQuantumAdminKey(String), // reserved — no entrypoints; see docs/PQ_READINESS.md migration note
    PostQuantumKeyLog(u32),      // reserved — no entrypoints; see docs/PQ_READINESS.md migration note
    PostQuantumKeyLogCount,      // reserved — no entrypoints; see docs/PQ_READINESS.md migration note
    // Issue #375 — proxy upgrade timelock + canary
    PendingUpgradeHash,
    PendingUpgradeEta,
    UpgradeApprovals,
    CanaryImplementation,
    CanaryTrafficShareBps,
    // Issue #565 — Two-step admin handover
    PendingAdmin,
    // Issue #731 — selective pause of individual feeds and write paths
    FeedPaused(String),
    WritePathPaused(Symbol),
}
