# Contract Event Schema

Closes #377, #564, #565, #569, #572.

Every state-changing entry point on `PriceOracleContract`, `ProxyContract`,
and `GovernanceContract` publishes an event via `env.events().publish(topics,
data)`. Topics are listed in order; the first topic is always the event
name. Integrators should subscribe by event name (topic 0) and decode the
remaining topics/data per the tables below.

## PriceOracleContract / ProxyContract

| Event | Topics | Data | Emitted by |
| --- | --- | --- | --- |
| `price_submitted` | `("price_submitted", asset: String, source: Address)` | `(price: i128, timestamp: u64)` | `submit_price` |
| `batch_submitted` | `("batch_submitted", source: Address)` | `(nonce: u64, root: Bytes)` | `submit_batch` |
| `batch_entry_applied` | `("batch_entry_applied", asset: String)` | `(batch_nonce: u64, price: i128)` | `apply_batch_entry` |
| `source_staked` | `("source_staked", source: Address)` | `amount: i128` | `stake` |
| `source_slashed` | `("source_slashed", source: Address, reason: String)` | `slashed: i128` | `slash` |
| `ttl_extended` | `("ttl_extended", asset: String, caller: Address)` | `(previous_ttl: u32, new_ttl: u32)` | `extend_price_history_ttl`, `extend_instance_ttl` |

## Multi-Sig Governance Lifecycle & Emergency Pause (Issue #564)

| Event | Topics | Data | Emitted by |
| --- | --- | --- | --- |
| `proposal_created` | `("proposal_created", proposer: Address)` | `(proposal_id: u32, action: Symbol)` | `create_proposal` |
| `proposal_approved` | `("proposal_approved", signer: Address)` | `(proposal_id: u32, action: Symbol)` | `approve_proposal` |
| `proposal_cancelled` | `("proposal_cancelled", caller: Address)` | `(proposal_id: u32, action: Symbol)` | `cancel_proposal` |
| `proposal_expired` | `("proposal_expired", caller: Address)` | `(proposal_id: u32, action: Symbol)` | `expire_proposal` |
| `governance_executed` | `("governance_executed", signer: Address)` | `(proposal_id: u32, action: Symbol)` | `execute_proposal` |
| `paused` | `("paused", signer: Address)` | `proposal_id: u32` | `execute_proposal` (Pause action) |
| `unpaused` | `("unpaused", signer: Address)` | `proposal_id: u32` | `execute_proposal` (Unpause action) |

## Admin-Config Mutations (Issue #564 & #569)

| Event | Topics | Data | Emitted by |
| --- | --- | --- | --- |
| `source_added` | `("source_added", source: Address)` | `name: String` | `add_oracle_source`, proposal executor |
| `source_removed` | `("source_removed", source: Address)` | `()` | `remove_oracle_source`, proposal executor |
| `trusted_asset_set` | `("trusted_asset_set", asset: String)` | `trusted: bool` | `set_trusted_asset`, proposal executor |
| `reputation_reset` | `("reputation_reset", source: Address)` | `()` | `reset_reputation`, proposal executor |
| `stake_treasury_set` | `("stake_treasury_set", treasury: Address)` | `()` | `set_stake_treasury`, proposal executor |
| `deviation_threshold_set` | `("deviation_threshold_set")` | `threshold_bps: u32` | `set_deviation_threshold`, proposal executor |
| `signer_added` | `("signer_added", signer: Address)` | `()` | proposal executor (`AddSigner`) |
| `signer_removed` | `("signer_removed", signer: Address)` | `()` | proposal executor (`RemoveSigner`) |
| `threshold_set` | `("threshold_set")` | `threshold: u32` | proposal executor (`SetThreshold`) |
| `asset_decimals_updated` | `("asset_decimals_updated", asset: String)` | `(old_decimals: u32, new_decimals: u32)` | proposal executor (`UpdateAssetDecimals`) |

## Two-Step Admin Handover (Issue #565)

| Event | Topics | Data | Emitted by |
| --- | --- | --- | --- |
| `admin_transfer_proposed` | `("admin_transfer_proposed", current_admin: Address, pending_admin: Address)` | `deadline: u64` | `propose_admin`, proposal executor |
| `admin_transfer_accepted` | `("admin_transfer_accepted", old_admin: Address, new_admin: Address)` | `timestamp: u64` | `accept_admin` |
| `admin_transfer_cancelled` | `("admin_transfer_cancelled", admin: Address, pending_admin: Address)` | `timestamp: u64` | `cancel_admin_transfer` |

## ProxyContract — upgrades and canary rollout

| Event | Topics | Data | Emitted by |
| --- | --- | --- | --- |
| `upgrade_proposed` | `("upgrade_proposed", admin: Address)` | `(wasm_hash: BytesN<32>, eta: u64)` | `propose_upgrade` |
| `upgrade_approved` | `("upgrade_approved", signer: Address)` | `approval_count: u32` | `approve_upgrade` |
| `upgrade_executed` | `("upgrade_executed", wasm_hash: BytesN<32>)` | `new_version: u32` | `execute_upgrade` |
| `upgrade_cancelled` | `("upgrade_cancelled", admin: Address)` | `timestamp: u64` | `cancel_upgrade` |
| `implementation_updated` | `("implementation_updated", admin: Address)` | `(new_implementation: Address, new_version: u32)` | `upgrade` |
| `canary_set` | `("canary_set", canary: Address)` | `traffic_share_bps: u32` | `set_canary` |
| `canary_promoted` | `("canary_promoted", canary: Address)` | `new_version: u32` | `promote_canary` |

## GovernanceContract (Token-based)

| Event | Topics | Data | Emitted by |
| --- | --- | --- | --- |
| `governance_proposed` | `("governance_proposed", proposer: Address)` | `proposal_id: u32` | `propose` |
| `governance_proposal_executed` | `("governance_proposal_executed", proposal_id: u32)` | `timestamp: u64` | `execute` |
| `governance_emergency_executed` | `("governance_emergency_executed", guardian: Address)` | `proposal_id: u32` | `emergency_execute` |

## Reconstructing the Governance Timeline from Events Alone

Off-chain operators, indexers, and analytics services can reconstruct the complete multi-sig lifecycle and admin audit log without reading contract storage:

1. **Proposal Creation**: A `proposal_created` event yields the `proposal_id`, initiating `proposer`, and the `action` kind (e.g. `pause`, `add_source`, `transfer_admin`).
2. **Review & Approvals**: Each signer approval emits `proposal_approved` carrying `(signer, proposal_id, action)`. Indexers track distinct signers until the multi-sig `threshold` is satisfied.
3. **Cancellation or Expiration**:
   - If cancelled before execution, `proposal_cancelled` records the `caller` (proposer or admin), `proposal_id`, and `action`.
   - If not executed within `PROPOSAL_EXPIRY_SECONDS` (7 days), `proposal_expired` is emitted upon evaluation.
4. **Execution & Action Dispatch**: When threshold approvals exist and `execute_proposal` is invoked, `governance_executed` logs the executing `signer`, `proposal_id`, and `action`.
5. **Direct Mutation Signals**: Alongside `governance_executed`, the contract synchronously emits the specific mutation event:
   - `paused` / `unpaused` identify exactly why price intake halted or resumed.
   - `source_added` / `source_removed` track oracle signer set evolution.
   - `admin_transfer_proposed` initiates the two-step admin handover with a 72-hour cancellation window, completed by `admin_transfer_accepted` or aborted with `admin_transfer_cancelled`.
6. **Indexer Reconciliation**: Consumers verify sequence continuity by checking that each `proposal_id` transitions strictly through `created -> approved* -> [executed | cancelled | expired]`.

## Indexer reconciliation

The indexer that mirrors this event stream into the API's read models must
periodically diff its last-processed ledger sequence against the chain's
current state (`get_price`, `get_proposal`, `get_implementation`, etc.) for a
sample of assets/proposals and alert when a diff persists across more than
one polling interval — a stuck cursor or dropped event otherwise fails
silently. Wire this check into whatever job currently ingests contract
events (see `services/aggregator` for the event-consuming service) rather
than as a new standalone process.
