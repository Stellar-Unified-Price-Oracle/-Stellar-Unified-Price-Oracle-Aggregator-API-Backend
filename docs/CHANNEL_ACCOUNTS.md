# Channel-Account Strategy Evaluation & Decision

**Status:** Evaluated — Rejected for current scale (Issue #578)  
**Date:** September 2026  
**Scope:** Soroban contract submission pipeline, `ContractPublisher`, throughput scaling  

---

## 1. Executive Summary & Decision

**Decision:**  
**Reject channel accounts for the current deployment topology.** Continue utilizing **single-account local sequence bumping** for individual asset submissions and **Merkle batch submission (`submit_batch`)** for high-volume asset sets.

**Reasoning:**  
For our target asset portfolio (5–20 watched assets) and publishing interval (5–30 seconds), local sequence management inside `ContractPublisher` reduces RPC overhead by >90% and submits the full asset round within <1.2 seconds sequentially. Channel accounts introduce significant operational burden (multi-account balance funding, key rotation complexity, state synchronization, and on-chain authorization governance) with negligible throughput gain under current ledger throughput constraints.

**Adoption Threshold:**  
Channel accounts should only be adopted if:
1. The aggregator watched asset count exceeds **50 assets** with a required publishing cadence under **2 seconds**, exceeding the practical serialization capacity of a single Stellar account sequence per ledger.
2. The network experiences sustained high contention where parallel sub-mempool inclusions across distinct accounts are required to avoid sequence dependency stalling.

---

## 2. Background: Stellar Account Sequence Serialization

On the Stellar network, every transaction consumes a strictly sequential sequence number tied to its source account (`tx.sourceAccount`). When transactions are submitted from the same account:
- Transactions must enter the ledger in strict ascending sequence order ($N, N+1, N+2$).
- If transaction $N$ fails, stalls in the mempool, or experiences a timeout, all subsequent transactions ($N+1, \dots$) are blocked or rejected with `tx_bad_seq`.
- In a naive implementation where each asset submission independently queries `getAccount()`, all transactions attempt to build from sequence $N$, producing immediate sequence collisions and forcing strict serial wait cycles.

### The Channel Account Pattern

The standard Stellar pattern to achieve high concurrent submission throughput is the **Channel Account** strategy:
- A primary **base account** (or admin key) holds the core funds and contract administrative authority.
- Multiple auxiliary **channel accounts** ($C_1, C_2, \dots, C_k$) are created and pre-funded with minimum balances (1–2 XLM for base reserves and transaction fees).
- Each channel account maintains an independent sequence number.
- Submissions across different assets are partitioned across the channels, allowing $k$ transactions to be built, signed, and broadcast concurrently in the same ledger window without sequence collisions.

---

## 3. On-Chain Contract Authorization Mechanisms

In the Soroban Price Oracle contract (`contracts/price-oracle/src/contract/submission.rs`), the primary price submission entrypoint requires authorization:

```rust
pub fn submit_price(
    env: Env,
    source: Address,
    asset: String,
    price: i128,
    decimals: u32,
    timestamp: u64,
) -> Result<(), OracleError> {
    source.require_auth();
    // ...
}
```

If channel accounts are used, there are two distinct ways to handle on-chain authorization:

### Approach A: Channel Account as Transaction Fee/Sequence Source (Recommended if adopted)
- The channel account ($C_i$) acts **solely as the Stellar transaction source account** (`tx.sourceAccount = C_i`). It pays the base transaction fee and provides the sequence number.
- The oracle admin key ($A$) provides the contract invocation authorization (`source = A`, with `A` providing the Soroban invocation signature).
- **Pros:** No contract modifications needed. The contract only ever interacts with the single canonical admin address $A$.
- **Cons:** Transactions require dual signatures ($C_i$ for fee/sequence, $A$ for contract auth), slightly increasing transaction size and client-side signing latency.

### Approach B: Channel Accounts as Delegated Oracle Sources
- Each channel account ($C_1, \dots, C_k$) is registered directly on-chain via `add_oracle_source(admin, C_i, "Aggregator-Channel-i")`.
- Each channel account signs both the transaction envelope and the contract authorization.
- **Pros:** Single-signature transactions.
- **Cons:** Severe governance and operational overhead:
  - Contract source registry is polluted with artificial channel accounts.
  - Reputation tracking, source stake/slash mechanisms, and quorum calculations are fragmented across $k$ identities.
  - Key rotation requires $k$ separate on-chain administrative transactions.

---

## 4. Architectural Alternatives Comparison

| Criteria | Option 1: Local Sequence Bumping (Adopted) | Option 2: Channel Accounts (Rejected) | Option 3: Merkle Batch Submission (`submit_batch`) |
|---|---|---|---|
| **RPC calls per round** | 1 `getAccount` lookup | $k$ channel lookups | 1 `getAccount` lookup |
| **Throughput (assets/sec)** | ~5–10 assets/sec | ~30–50 assets/sec | >100 assets/round (in 1 tx) |
| **On-chain Gas Cost** | Standard per-asset gas | Standard per-asset gas | Amortized: 1 root commit + cheap proofs |
| **Operational Overhead** | Minimal (single keypair) | High (funding, monitoring $k$ accounts) | Minimal (single keypair) |
| **Sequence Recovery** | Single-point `tx_bad_seq` resync | Per-channel state tracking & resync | Atomic: 1 batch nonce per round |
| **Key Security** | Single admin secret in Vault | $k$ secrets in Vault / runtime memory | Single admin secret in Vault |

---

## 5. Justification for Rejection

1. **Local Sequence Bumping Solves the Immediate Bottleneck:**
   By caching `this.cachedAccount` in the singleton `ContractPublisher` and incrementing sequence numbers locally, sequential submissions no longer block on network `getAccount` RPC round-trips. Five assets publish in under 1 second.
2. **Heartbeat RPC Elimination:**
   Read-only `getOnChainTimestamp` checks now simulate against a virtual account without fetching or touching the on-chain sequence, eliminating 5 redundant RPC calls per heartbeat cycle.
3. **Batching is the Superior Scaling Path:**
   When watched asset volume grows beyond 20 assets, Merkle batch submission (`submit_batch`) compresses $N$ price updates into a single 32-byte root commit on-chain, eliminating the need for parallel individual transactions altogether.
4. **Maintenance Burden:**
   Channel accounts require automated balance re-topping, low-balance alerts, dead-channel pruning, and distributed sequence recovery. This operational surface area is unjustified for current throughput requirements.

---

## 6. Implementation Summary for Single-Key Sequence Management

- **Sequence Bumping:** Managed by `ContractPublisher.getAccount()`.
- **Bad-Sequence Recovery:** On receipt of `tx_bad_seq`, `cachedAccount` is invalidated and re-fetched from RPC, retrying the submission once.
- **Metrics:** `contract_rpc_calls_total` and `contract_rpc_calls_per_round` monitor RPC efficiency.
