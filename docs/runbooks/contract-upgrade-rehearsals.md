# Runbook: Automated Contract Upgrade Rehearsals on an Isolated Network

**Owner:** Smart Contract Engineering / Release Engineering  
**Scope:** `contracts/price-oracle/` (`PriceOracleContract`, `ProxyContract`)  
**Status:** Approved & Enforced  
**Frequency:** Mandatory before every Release Candidate (RC) approval  

---

## 1. Overview & Objectives

Upgrades to Soroban smart contracts modifying storage layouts or proxy targets present substantial risk of silent data corruption, historical feed truncation, or authorization lockout.

This runbook establishes an automated, repeatable **upgrade rehearsal procedure** executed on an isolated network (local standalone node or isolated test instance) against **representative production-shaped state** prior to tagging and deploying any release candidate.

### Rehearsal Goals:
1. Verify storage layout backwards-compatibility.
2. Ensure instance storage (prices, sources, nonces, multi-sig, feed catalog) is 100% preserved.
3. Validate write-path continuity immediately after the code swap.
4. Verify multi-sig governance and timelock approval workflows survive the upgrade.
5. Practice and verify emergency rollback mechanisms.

---

## 2. Pre-Requisites & Environment Topology

Rehearsals must **NEVER** run against public testnet or mainnet. They must run in one of the following isolated environments:
- **Local Isolated Network:** Stellar Quickstart container running in standalone mode (`docker run --rm -p 8000:8000 stellar/quickstart:latest --local`).
- **Simulated Test Environment:** Automated harness runner (`npm run rehearsal:upgrade` or `cargo test --test upgrade_rehearsal_test`).

Ensure the following tools are present:
- Node.js >= 18
- Rust toolchain & Cargo with `wasm32-unknown-unknown` target
- Stellar CLI >= 21.0

---

## 3. Production-Shaped State Definition

To ensure realistic testing, the rehearsal harness must seed the following production state prior to attempting the upgrade:

| State Domain | Production-Shaped Profile | Invariant Requirement |
|---|---|---|
| **Admin & Governance** | Multi-sig initialized with 3 signers and threshold 2 | Signers list, threshold, and pending proposals preserved |
| **Oracle Sources** | 4 distinct registered sources (Chainlink, Band, Redstone, Reflector) | All sources remain active with identical names and addresses |
| **Asset Feeds** | 5 core assets (XLM, USDC, BTC, ETH, USDT) with 7 decimals | Latest prices, timestamps, and USD conversions match pre-upgrade |
| **Historical Data** | Deep price history with overflow (>100 data points) | Ring buffer strictly respects `MAX_HISTORY_LEN` (100) and preserves ordering |
| **Merkle Nonce** | Active Merkle batch submissions with nonces > 0 | `get_batch_nonce` must not regress or reset |
| **Feed Catalog** | Versioned on-chain catalog commitment (Issue #725) | Version number, 32-byte digest, and publisher address preserved |

---

## 4. Rehearsal Execution Procedure

### Step 1: Execute Automated Rehearsal Runner
From repository root:

```bash
npm run rehearsal:upgrade
```

Or for machine-readable JSON output:

```bash
node scripts/upgrade-rehearsal.mjs --json
```

### Step 2: Review Invariant Assertions
The runner automatically verifies 18 explicit state invariants across 6 phases:
- [ ] Phase 1: Pre-flight checks pass.
- [ ] Phase 2: State seeding succeeds.
- [ ] Phase 3: Cryptographic state snapshot captured.
- [ ] Phase 4: Upgrade execution completes without gas exhaustion.
- [ ] Phase 5: All 7 invariant domains pass (Admin, Sources, Feeds, History, Batch Nonce, Catalog, Write Continuity).
- [ ] Phase 6: Simulated failure modes (unauthorized upgrade, replay) and emergency rollback verified.

---

## 5. Production Rollout Guide

Once the rehearsal passes on the isolated network, follow the staged rollout:

1. **Staging / Testnet Deployment:**
   - Deploy compiled candidate WASM to testnet: `node scripts/deploy-soroban.js`
   - Queue proposal via multi-sig: `create_proposal(proposer, ProposalAction::UpgradeWasm(hash))`
   - Gather approvals from signers: `approve_proposal(signer, id)`
   - Execute upgrade once timelock expires: `execute_proposal(signer, id)`
2. **Post-Upgrade Smoke Verification:**
   - Run `node scripts/verify-feed-catalog.mjs --verify <committed_hash>`
   - Confirm healthy price updates via `/api/v1/health` and `/api/v1/prices`.
   - Validate that Prometheus metric `contract_submission_outcome{status="ok"}` continues incrementing.

---

## 6. Rollback Runbook

If any anomaly, data corruption, or elevated failure rate occurs post-upgrade:

1. **Trigger Emergency Pause:**
   Multi-sig signers execute `ProposalAction::Pause` to immediately suspend price-contract writes.
2. **Execute In-Place Rollback:**
   - Swap the contract bytecode back to the previous known-good WASM hash using `ProxyContract::upgrade_wasm`.
   - Alternatively, update the logical implementation pointer via `ProxyContract::upgrade`.
3. **Verify State Invariants Post-Rollback:**
   Execute `node scripts/upgrade-rehearsal.mjs` with `--verify-rollback` flag.
4. **Unpause Contract:**
   Execute `ProposalAction::Unpause` once data integrity is confirmed.
