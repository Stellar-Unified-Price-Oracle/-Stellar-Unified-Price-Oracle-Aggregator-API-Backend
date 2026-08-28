# Contract Event Schema

Closes #377.

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
| `governance_executed` | `("governance_executed", signer: Address)` | `proposal_id: u32` | `execute_proposal` (multi-sig) |
| `source_staked` | `("source_staked", source: Address)` | `amount: i128` | `stake` |
| `source_slashed` | `("source_slashed", source: Address, reason: String)` | `slashed: i128` | `slash` |

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

## GovernanceContract

| Event | Topics | Data | Emitted by |
| --- | --- | --- | --- |
| `governance_proposed` | `("governance_proposed", proposer: Address)` | `proposal_id: u32` | `propose` |
| `governance_proposal_executed` | `("governance_proposal_executed", proposal_id: u32)` | `timestamp: u64` | `execute` |
| `governance_emergency_executed` | `("governance_emergency_executed", guardian: Address)` | `proposal_id: u32` | `emergency_execute` |

## Indexer reconciliation

The indexer that mirrors this event stream into the API's read models must
periodically diff its last-processed ledger sequence against the chain's
current state (`get_price`, `get_proposal`, `get_implementation`, etc.) for a
sample of assets/proposals and alert when a diff persists across more than
one polling interval — a stuck cursor or dropped event otherwise fails
silently. Wire this check into whatever job currently ingests contract
events (see `services/aggregator` for the event-consuming service) rather
than as a new standalone process.
