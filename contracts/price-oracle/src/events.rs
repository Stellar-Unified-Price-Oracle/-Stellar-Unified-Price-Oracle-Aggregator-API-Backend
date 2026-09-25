// On-chain event interface.
//
// Every event is declared here so the emitted topics and payloads are
// reviewable in one place. Struct names map to the leading topic
// (`PriceSubmitted` → `price_submitted`) and `data_format` mirrors the shape
// each event shipped with: "single-value" for a bare value, "vec" for the
// tuple payloads, and "single-value" with no data fields for the events that
// carried only topics. Keeping the original shapes means the topic order and
// payload encoding are unchanged for existing consumers.

use soroban_sdk::{contractevent, Address, Bytes, BytesN, String};

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

// ── Multi-sig admin ───────────────────────────────────────────────────────────

#[contractevent(data_format = "single-value")]
pub struct GovernanceExecuted {
    #[topic]
    pub signer: Address,
    pub proposal_id: u32,
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
