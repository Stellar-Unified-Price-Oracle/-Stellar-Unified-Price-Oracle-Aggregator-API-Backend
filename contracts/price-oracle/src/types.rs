use soroban_sdk::{contracttype, Address, String, Vec};

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

// ── Merkle batch types ────────────────────────────────────────────────────────

/// A single price entry encoded into the Merkle leaf.
/// leaf = SHA-256(asset || price || decimals || timestamp || source)
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BatchPriceEntry {
    pub asset: String,
    pub price: i128,
    pub decimals: u32,
    pub timestamp: u64,
    pub source: Address,
}

/// A Merkle inclusion proof for one leaf inside a batch.
/// `siblings` are the co-path hashes from leaf to root, ordered leaf→root.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MerkleProof {
    /// Index of the leaf in the original ordered leaf array (0-based).
    pub leaf_index: u32,
    /// Co-path sibling hashes, leaf level first.
    pub siblings: soroban_sdk::Vec<soroban_sdk::Bytes>,
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
    // Proxy pattern keys
    Implementation,
    PreviousImplementation,
    ContractVersion,
    // Merkle batch keys
    /// Stores the accepted Merkle root for a given batch nonce.
    BatchRoot(u64),
    /// Monotonically increasing nonce; next batch must use this value.
    BatchNonce,
}
