// On-chain event interface.
//
// Every event is declared here so the emitted topics and payloads are
// reviewable in one place. Struct names map to the leading topic
// (`PriceSubmitted` → `price_submitted`) and `data_format` mirrors the shape
// each event shipped with: "single-value" for a bare value, "vec" for the
// tuple payloads, and "single-value" with no data fields for the events that
// carried only topics. Keeping the original shapes means the topic order and
// payload encoding are unchanged for existing consumers.

use soroban_sdk::{contractevent, Address, Bytes, BytesN, String, Symbol};

// ── Event schema versioning (Issue #728) ─────────────────────────────────────
//
// `EVENT_SCHEMA_VERSION` is the single source of truth for the on-chain event
// schema. It is bumped whenever an existing event's topic order or payload
// encoding changes, or when a new event family is introduced. The decoding
// client library (`soroban-event-decoder`) reads this constant from the
// contract metadata and refuses to decode events whose embedded version is
// greater than the version it was built against.
//
// Version history:
//   1 — initial schema (all events prior to Issue #724/#728)
//   2 — adds `PriceSnapshotPublished` and `PriceEvidencePublished` (Issue #724)
pub const EVENT_SCHEMA_VERSION: u32 = 2;

// ── Proxy upgrade governance (Issue #375) ─────────────────────────────────────

#[contractevent(data_format = "vec")]
pub struct UpgradeProposed {
    #[topic]
    pub admin: Address,
    pub new_wasm_hash: BytesN<32>,
    pub eta: u64,
}

#[contractevent(data_format = "single-value")]
pub struct UpgradeApproved {
    #[topic]
    pub signer: Address,
    pub count: u32,
}

#[contractevent(data_format = "single-value")]
pub struct UpgradeExecuted {
    #[topic]
    pub new_wasm_hash: BytesN<32>,
    pub version: u32,
}

#[contractevent(data_format = "single-value")]
pub struct CanarySet {
    #[topic]
    pub canary: Address,
    pub traffic_share_bps: u32,
}

#[contractevent(data_format = "single-value")]
pub struct CanaryPromoted {
    #[topic]
    pub canary: Address,
    pub version: u32,
}

// ── Proxy implementation pointer (Issue #68) ──────────────────────────────────

#[contractevent(data_format = "vec")]
pub struct ImplementationUpdated {
    #[topic]
    pub admin: Address,
    pub new_implementation: Address,
    pub version: u32,
}

// ── Price submission ──────────────────────────────────────────────────────────

#[contractevent(data_format = "vec")]
pub struct PriceSubmitted {
    #[topic]
    pub asset: String,
    #[topic]
    pub source: Address,
    pub price: i128,
    pub timestamp: u64,
}

#[contractevent(data_format = "vec")]
pub struct BatchSubmitted {
    #[topic]
    pub source: Address,
    pub nonce: u64,
    pub root: Bytes,
}

#[contractevent(data_format = "vec")]
pub struct BatchEntryApplied {
    #[topic]
    pub asset: String,
    pub batch_nonce: u64,
    pub price: i128,
}

// ── Consumer-verifiable price evidence (Issue #724) ──────────────────────────
//
// `PriceSnapshotPublished` is emitted whenever a price snapshot is committed.
// It carries the `schema_version` (must equal `EVENT_SCHEMA_VERSION`) and the
// `policy_version` of the aggregation policy that produced the snapshot, so a
// consumer can (a) reject snapshots produced under an unknown policy and
// (b) verify the evidence payload against the exact policy semantics.
//
// `PriceEvidencePublished` carries the digest of the evidence bundle. The
// bundle itself is stored off-chain (or in contract storage) and is addressed
// by `evidence_hash`; consumers recompute the hash and compare. `source_count`
// and `quorum_bps` let a consumer check the trust assumption (how many sources
// contributed and what quorum was required) without trusting the publisher.

#[contractevent(data_format = "vec")]
pub struct PriceSnapshotPublished {
    #[topic]
    pub asset: String,
    pub schema_version: u32,
    pub policy_version: u32,
    pub price: i128,
    pub timestamp: u64,
}

#[contractevent(data_format = "vec")]
pub struct PriceEvidencePublished {
    #[topic]
    pub asset: String,
    #[topic]
    pub publisher: Address,
    pub schema_version: u32,
    pub evidence_hash: BytesN<32>,
    pub source_count: u32,
    pub quorum_bps: u32,
}

// ── Source staking ────────────────────────────────────────────────────────────

#[contractevent(data_format = "single-value")]
pub struct SourceStaked {
    #[topic]
    pub source: Address,
    pub amount: i128,
}

#[contractevent(data_format = "single-value")]
pub struct SourceSlashed {
    #[topic]
    pub source: Address,
    #[topic]
    pub reason: String,
    pub slashed: i128,
}

// ── Governance ────────────────────────────────────────────────────────────────

#[contractevent(data_format = "single-value")]
pub struct GovernanceProposed {
    #[topic]
    pub proposer: Address,
    pub proposal_id: u32,
}

#[contractevent(data_format = "single-value")]
pub struct GovVoted {
    #[topic]
    pub proposal_id: u32,
    #[topic]
    pub voter: Address,
    pub support: bool,
}

#[contractevent(data_format = "single-value")]
pub struct GovQueued {
    #[topic]
    pub proposal_id: u32,
    pub execution_time: u64,
}

#[contractevent(data_format = "single-value")]
pub struct GovernanceProposalExecuted {
    #[topic]
    pub proposal_id: u32,
    pub executed_at: u64,
}

#[contractevent(data_format = "single-value")]
pub struct GovCancelled {
    #[topic]
    pub proposal_id: u32,
    #[topic]
    pub caller: Address,
}

#[contractevent(data_format = "single-value")]
pub struct GovernanceEmergencyExecuted {
    #[topic]
    pub guardian: Address,
    pub proposal_id: u32,
}

// ── Multi-sig admin & proposal lifecycle (Issue #564) ─────────────────────────

#[contractevent(data_format = "vec")]
pub struct ProposalCreated {
    #[topic]
    pub proposer: Address,
    pub proposal_id: u32,
    pub action: Symbol,
}

#[contractevent(data_format = "vec")]
pub struct ProposalApproved {
    #[topic]
    pub signer: Address,
    pub proposal_id: u32,
    pub action: Symbol,
}

#[contractevent(data_format = "vec")]
pub struct ProposalCancelled {
    #[topic]
    pub caller: Address,
    pub proposal_id: u32,
    pub action: Symbol,
}

#[contractevent(data_format = "vec")]
pub struct ProposalExpired {
    #[topic]
    pub caller: Address,
    pub proposal_id: u32,
    pub action: Symbol,
}

#[contractevent(data_format = "vec")]
pub struct GovernanceExecuted {
    #[topic]
    pub signer: Address,
    pub proposal_id: u32,
    pub action: Symbol,
}

// ── Emergency pause (Issue #564) ──────────────────────────────────────────────

#[contractevent(data_format = "single-value")]
pub struct Paused {
    #[topic]
    pub signer: Address,
    pub proposal_id: u32,
}

#[contractevent(data_format = "single-value")]
pub struct Unpaused {
    #[topic]
    pub signer: Address,
    pub proposal_id: u32,
}

// ── Selective pause / recovery (Issue #731) ───────────────────────────────────
//
// Selective pauses are recorded per feed and per write path so operators can
// pause one component without disabling unrelated write paths. Each state
// change emits its own event so monitoring can reconstruct exactly which
// components are paused and which recovery steps have completed.

#[contractevent(data_format = "vec")]
pub struct FeedPaused {
    #[topic]
    pub asset: String,
    #[topic]
    pub signer: Address,
    pub reason: Symbol,
}

#[contractevent(data_format = "vec")]
pub struct FeedUnpaused {
    #[topic]
    pub asset: String,
    #[topic]
    pub signer: Address,
    pub paused_at: u64,
}

#[contractevent(data_format = "vec")]
pub struct WritePathPaused {
    #[topic]
    pub path: Symbol,
    #[topic]
    pub signer: Address,
    pub reason: Symbol,
}

#[contractevent(data_format = "vec")]
pub struct WritePathUnpaused {
    #[topic]
    pub path: Symbol,
    #[topic]
    pub signer: Address,
    pub paused_at: u64,
}

// ── Admin-config mutations (Issue #564) ────────────────────────────────────────

#[contractevent(data_format = "single-value")]
pub struct SourceAdded {
    #[topic]
    pub source: Address,
    pub name: String,
}

#[contractevent(data_format = "single-value")]
pub struct SourceRemoved {
    #[topic]
    pub source: Address,
}

#[contractevent(data_format = "single-value")]
pub struct TrustedAssetSet {
    #[topic]
    pub asset: String,
    pub trusted: bool,
}

#[contractevent(data_format = "single-value")]
pub struct ReputationReset {
    #[topic]
    pub source: Address,
}

#[contractevent(data_format = "single-value")]
pub struct StakeTreasurySet {
    #[topic]
    pub treasury: Address,
}

#[contractevent(data_format = "single-value")]
pub struct DeviationThresholdSet {
    pub threshold_bps: u32,
}

#[contractevent(data_format = "single-value")]
pub struct SignerAdded {
    #[topic]
    pub signer: Address,
}

#[contractevent(data_format = "single-value")]
pub struct SignerRemoved {
    #[topic]
    pub signer: Address,
}

#[contractevent(data_format = "single-value")]
pub struct ThresholdSet {
    pub threshold: u32,
}

// ── Governed decimals update (Issue #569) ─────────────────────────────────────

#[contractevent(data_format = "vec")]
pub struct AssetDecimalsUpdated {
    #[topic]
    pub asset: String,
    pub old_decimals: u32,
    pub new_decimals: u32,
}

// ── Storage rent / TTL extension (Issue #572) ─────────────────────────────────

#[contractevent(data_format = "vec")]
pub struct TtlExtended {
    #[topic]
    pub asset: String,
    #[topic]
    pub caller: Address,
    pub previous_ttl: u32,
    pub new_ttl: u32,
}

// ── Two-step admin handover (Issue #565) ──────────────────────────────────────

#[contractevent(data_format = "single-value")]
pub struct AdminTransferProposed {
    #[topic]
    pub current_admin: Address,
    #[topic]
    pub pending_admin: Address,
    pub deadline: u64,
}

#[contractevent(data_format = "single-value")]
pub struct AdminTransferAccepted {
    #[topic]
    pub old_admin: Address,
    #[topic]
    pub new_admin: Address,
    pub timestamp: u64,
}

#[contractevent(data_format = "single-value")]
pub struct AdminTransferCancelled {
    #[topic]
    pub admin: Address,
    #[topic]
    pub pending_admin: Address,
    pub timestamp: u64,
}

#[contractevent(data_format = "single-value")]
pub struct MultiSigProposed {
    #[topic]
    pub proposer: Address,
    pub proposal_id: u32,
}

#[contractevent(data_format = "single-value")]
pub struct MultiSigApproved {
    #[topic]
    pub signer: Address,
    pub proposal_id: u32,
}

#[contractevent(data_format = "single-value")]
pub struct MultiSigCancelled {
    #[topic]
    pub proposal_id: u32,
    pub cancelled_by: Address,
}

// ── Fee treasury ──────────────────────────────────────────────────────────────

#[contractevent(data_format = "vec")]
pub struct FeesWithdrawn {
    #[topic]
    pub recipient: Address,
    pub token: Address,
    pub amount: i128,
}

#[contractevent(data_format = "single-value")]
pub struct QueryFeeSet {
    #[topic]
    pub admin: Address,
    pub fee: i128,
}

#[contractevent(data_format = "single-value")]
pub struct WhitelistUpdated {
    #[topic]
    pub admin: Address,
    #[topic]
    pub addr: Address,
    pub status: bool,
}

// ── Feed catalog commitment (Issue #725) ─────────────────────────────────────

#[contractevent(data_format = "vec")]
pub struct FeedCatalogCommitted {
    #[topic]
    pub publisher: Address,
    pub version: u32,
    pub catalog_hash: BytesN<32>,
    pub timestamp: u64,
}

