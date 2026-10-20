# On-Chain Feed Catalog Version Commitment

**Workstream:** Soroban protocol evolution  
**Status:** Approved & Implemented  
**Date:** October 2026  
**Implementation:** `contracts/price-oracle/` (`types.rs`, `storage.rs`, `admin.rs`, `queries.rs`, `proxy.rs`, `governance.rs`)  

---

## 1. Context & Motivation

In multi-asset oracle aggregator networks, off-chain services publish a rich catalog of supported asset feeds, precision/decimals, upstream provider allocations, staleness thresholds, and heartbeat requirements.

Downstream smart contracts, automated market makers (AMMs), and lending protocols on Stellar need a cryptographic anchor to verify that the off-chain catalog they consume conforms to what the oracle protocol's governing authorities have reviewed and committed to.

Without an on-chain commitment:
- Off-chain feed definitions could drift or be spoofed without on-chain consumer visibility.
- Integrators had no verifiable way to detect whether an off-chain API or CDN returned a stale or tampered feed schema.
- Governance could not atomically coordinate updates across on-chain parameters and off-chain feed configurations.

---

## 2. On-Chain Design & Compact Commitment

Storing entire feed catalog definitions on Soroban instance storage is expensive and scales poorly with the number of assets. Instead, we implement a **compact 32-byte cryptographic commitment**:

$$\text{catalog\_hash} = \text{SHA-256}(\text{CanonicalFeedCatalogJSON})$$

### 2.1 Storage Layout & Types

The commitment is defined in `contracts/price-oracle/src/types.rs`:

```rust
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeedCatalogCommitment {
    pub version: u32,
    pub catalog_hash: BytesN<32>,
    pub updated_at: u64,
    pub publisher: Address,
}
```

Stored under `DataKey::FeedCatalogCommitment` in instance storage.

### 2.2 Invariants & State Transition Rules

1. **Strict Monotonicity:**  
   Every new catalog commitment must specify a version strictly greater than the currently stored version ($v_{\text{new}} > v_{\text{current}}$). Version 0 is prohibited. This prevents rollback attacks or replay of obsolete feed catalog configurations.
2. **Dual Governance Authorization:**  
   Commitments can be published through either:
   - **Direct Admin Execution:** `commit_feed_catalog(admin, version, catalog_hash)` requiring admin authorization.
   - **Multi-Sig Governance Execution:** `ProposalAction::CommitFeedCatalog(version, catalog_hash)` executed through the quorum proposal lifecycle (`create_proposal` $\rightarrow$ `approve_proposal` $\rightarrow$ `execute_proposal`).
3. **Observability & Event Stream:**  
   Every successful commitment publishes the `FeedCatalogCommitted` event:
   ```rust
   pub struct FeedCatalogCommitted {
       pub publisher: Address,
       pub version: u32,
       pub catalog_hash: BytesN<32>,
       pub timestamp: u64,
   }
   ```
4. **Proxy Compatibility:**  
   Both `PriceOracleContract` and `ProxyContract` export:
   - `commit_feed_catalog(env, admin, version, catalog_hash) -> Result<(), OracleError>`
   - `get_feed_catalog_commitment(env) -> Option<FeedCatalogCommitment>`
   - `get_feed_catalog_version(env) -> u32`

---

## 3. Off-Chain Consumer Verification Workflow

```
┌─────────────────────────┐           ┌─────────────────────────┐
│ Off-chain API / Gateway │           │  On-Chain Contract      │
│ GET /api/v1/catalog     │           │  get_feed_catalog_...   │
└────────────┬────────────┘           └────────────┬────────────┘
             │                                     │
             ▼                                     ▼
     Canonical JSON                       Commitment Hash
   SHA-256(Canonical)                   BytesN<32> (Version V)
             │                                     │
             └───────────────► Assert ◄────────────┘
                               Match?
                               ├── Yes: Trust feed metadata
                               └── No: Reject & alert on-call
```

1. Consumer fetches feed catalog from the API or off-chain registry.
2. Consumer canonicalizes the JSON schema and computes its SHA-256 digest.
3. Consumer calls `get_feed_catalog_commitment()` on the deployed Soroban contract.
4. If hashes match and the version satisfies the consumer's minimum requirement, the catalog metadata is accepted.

---

## 4. Operational Impact, Rollout & Rollback

### Rollout Guidance
1. Deploy contract containing the feed catalog entrypoints (or upgrade existing proxy instance).
2. Seed initial feed catalog commitment ($v=1$) using admin key or initial multi-sig proposal.
3. Update aggregator and API documentation to reference the committed on-chain version.
4. Run `node scripts/verify-feed-catalog.mjs` in CI to ensure agreement between repository feed definitions and on-chain commitment.

### Rollback Guidance
- Because catalog versions are strictly monotonic, reverting an erroneous catalog requires incrementing the version counter ($v_{\text{revert}} = v_{\text{current}} + 1$) and committing the hash of the known-good previous catalog definition.
- If emergency pause is required due to upstream schema corruption, multi-sig signers can execute `ProposalAction::Pause` on the contract.
