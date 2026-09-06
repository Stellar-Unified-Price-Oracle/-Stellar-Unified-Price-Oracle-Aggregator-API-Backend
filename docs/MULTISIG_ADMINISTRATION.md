# Multi-Sig Administration & Operations Guide

This guide is written for the administrators and operators who run the
multi-signature (multi-sig) control plane for the Stellar Unified Price
Oracle on mainnet. It covers signer setup, threshold configuration, the full
proposal lifecycle (create → approve → execute), emergency guardian
procedures, and day-to-day operational hygiene.

It complements, and should be read alongside:

- [Contract Upgrade Governance](./CONTRACT_UPGRADE_GOVERNANCE.md) — how
  upgrades are proposed, approved, and deployed.
- [Key Management](./KEY_MANAGEMENT.md) — custody and rotation of signer keys.
- [Threat Model](./THREAT_MODEL.md) — trust boundaries and attacker profiles.

## 1. Roles

| Role | Responsibility | Minimum trust requirements |
|---|---|---|
| Signer | Creates, approves, and executes proposals | Threshold of signers must collude to act; each signer is independently custodied |
| Proposer | Creates a proposal (must itself be a signer) | Automatically counts as the first approval |
| Guardian | Emergency bypass of the governance timelock | Held by a trusted party; only used for emergency-execute |
| Admin (initial) | Calls `init_multisig` to bootstrap the signer set | Retained only until multi-sig is active; transfers away after bootstrap |

Every proposal action requires `threshold` distinct signer approvals before it
can be executed. No single signer — including the proposer — can execute
unilaterally.

## 2. Signer setup

### 2.1 Bootstrap (first-time initialization)

Multi-sig is initialized on the price oracle contract by the current admin:

```rust
// contract.rs — PriceOracleContract::init_multisig
pub fn init_multisig(env: Env, admin: Address, signers: Vec<Address>, threshold: u32)
```

Pre-flight checklist before calling `init_multisig`:

1. **Agree on the signer set.** Each signer must be a Stellar account
   controlled by a distinct individual/entity, custodied per
   `docs/KEY_MANAGEMENT.md` (HSM, hardware wallet, or KMS — never plaintext).
2. **Agree on the threshold.** A common baseline is `threshold = ceil(n/2) + 1`
   for an odd `n` (e.g. 3-of-5), which keeps the system operational if one
   signer is unavailable while preventing two from acting alone.
3. **Validate the addresses offline.** Confirm every signer address with the
   signer directly (out-of-band) before adding it.
4. **Dry-run on testnet first.** Run the same sequence against a testnet
   deployment and confirm proposals flow end-to-end.
5. **Record the ceremony.** Log the initialization proposal/transaction hash,
   the signer addresses, the threshold, and the approving admin in the
   incident/ops log (`docs/runbooks/`).

Once the contract reports a valid `MultiSigConfig`, the admin key should be
rotated away from day-to-day use (see §6).

### 2.2 Constraints enforced by the contract

- `threshold` must be `> 0` and `<= signers.len()`. A threshold of `0` or a
  threshold larger than the signer set is rejected with `InvalidThreshold`
  (error code 13).
- Proposals can only be created by an address in `MultiSigConfig.signers`
  (`NotASigner`, code 9).
- A signer cannot approve the same proposal twice (`AlreadyApproved`, code 12).
- Execution requires `approvals.len() >= threshold` (`ThresholdNotMet`, code 14).
- Proposals that do not exist report `ProposalNotFound` (code 10); already
  executed proposals report `ProposalAlreadyExecuted` (code 11).
- All of these are surfaced by the API as error codes; see
  `api/src/infrastructure/catalog.ts` for the HTTP mapping.

## 3. Threshold configuration

The threshold is set at bootstrap and can later be changed — but only via the
proposal flow itself (`ProposalAction::SetThreshold`), so a threshold change
requires the current threshold to approve it.

Guidance for choosing a threshold:

- **Security-first:** higher thresholds reduce the blast radius of a single
  compromised signer.
- **Availability-aware:** a threshold equal to the full signer count means any
  single signer outage stalls governance; leave headroom (e.g. 3-of-5, 4-of-6).
- **Rotation planning:** if you plan to rotate signers regularly, prefer a
  threshold that remains satisfiable mid-rotation (approvals survive signer
  changes; only new proposals are subject to the new signer set).

Changing signers or threshold is itself a proposal:

```
ProposalAction::AddSigner(Address)       — add a signer
ProposalAction::RemoveSigner(Address)    — remove a signer
ProposalAction::SetThreshold(u32)        — change the threshold
```

## 4. Proposal lifecycle

The lifecycle is identical on the on-chain contract and in the API
(`api/src/governance/proposal-service.ts`):

```
create_proposal → approve_proposal (×N until threshold) → execute_proposal
```

### 4.1 Create

Only a current signer may create a proposal. Creating counts as the first
approval, so a 3-of-5 proposal starts with one approval already recorded.

On-chain:

```rust
PriceOracleContract::create_proposal(env, proposer, action)
```

Via the API:

```text
POST /api/v1/governance/multisig/proposals
{ "action": { "variant": "AddSigner", "signer": "G..." }, "caller": "G..." }
```

The API returns the new proposal with its `id`; record this id for the
approval round.

### 4.2 Review

Before approving, each signer MUST verify:

1. **The action is correct.** Confirm the variant and payload match the intent
   (e.g. the exact signer address for `AddSigner`, the exact WASM hash for an
   upgrade, the exact asset for `SetTrustedAsset`).
2. **The proposal id matches.** Approve the id returned by the API/on-chain
   query, never an id passed in chat/email.
3. **For upgrades:** the proposal description links the exact WASM hash and a
   diff/changelog against the currently deployed contract (see
   `docs/CONTRACT_UPGRADE_GOVERNANCE.md`).

### 4.3 Approve

On-chain:

```rust
PriceOracleContract::approve_proposal(env, signer, proposal_id)
```

Via the API:

```text
POST /api/v1/governance/multisig/proposals/:id/approve
{ "caller": "G..." }
```

Each approval is auth-gated (`signer.require_auth()`), so approvals are only
accepted from a signer's own account.

### 4.4 Execute

Execution is only possible once `approvals.len() >= threshold`.

On-chain:

```rust
PriceOracleContract::execute_proposal(env, signer, proposal_id)
```

Via the API:

```text
POST /api/v1/governance/multisig/proposals/:id/execute
{ "caller": "G..." }
```

`execute_proposal` validates the threshold, applies the action
(`apply_proposal_action`), marks the proposal executed, and emits an event
`("governance_executed", signer)` with the proposal id. The event is visible
in the contract's event stream (`docs/EVENT_SCHEMA.md`).

### 4.5 Verify

After execution:

- Query the proposal: `GET /api/v1/governance/multisig/proposals/:id` — expect
  `executed: 1`.
- Query the config: `GET /api/v1/governance/multisig/config` — confirm the
  signer set / threshold matches the executed proposal.
- For source/asset actions, query the affected contract state (e.g. source
  list, trusted asset flag) to confirm the change is live.

## 5. Emergency guardian procedures

The governance contract supports a guardian address empowered to bypass the
timelock for emergency executions (`ProposalAction` executed via
`emergencyExecute` in `api/src/governance/proposal-service.ts`).

Use the emergency path ONLY for genuinely urgent, security-relevant changes:

- Pausing source ingestion during a live incident
- Removing a compromised signer immediately
- Unpausing after a region quarantine

### 5.1 Emergency execution

```text
POST /api/v1/governance/proposals/:id/emergency-execute
```

The guardian must still create/reference a proposal for the action — the
emergency path bypasses the timelock delay, not the need for a recorded,
auditable action. Every emergency execution is written to the audit log
(`auditLog('governance.emergency_execute', ...)`).

### 5.2 Compromised signer response

1. **Declare** the incident and inform all signers immediately.
2. **Quarantine:** do not approve any pending proposals that could be
   influenced by the compromised key.
3. **Propose removal:** `ProposalAction::RemoveSigner(<compromised>)` and —
   in the same review cycle — `ProposalAction::AddSigner(<replacement>)`.
4. **Rotate** the underlying key material per `docs/KEY_MANAGEMENT.md`.
5. **Document** the timeline, proposal IDs, and approving signers in
   `docs/runbooks/`.

## 6. Operations hygiene

- **Admin key retirement:** after bootstrap, transfer admin authority to the
  multi-sig (or a KMS signing proxy) so no single key retains admin powers.
  Admin transfer itself is a proposal (`ProposalAction::TransferAdmin` /
  `SetAdmin`) — it is never performed via a direct, unproposed transaction.
- **Quarterly signer review:** re-confirm every signer's identity, custody,
  and that their key can still sign (testnet practice run). Log results in
  `docs/runbooks/`.
- **Backup & restoration test:** restore signer keys from backup in a
  non-production environment at least once per quarter (see
  `docs/KEY_MANAGEMENT.md`).
- **Monitor proposal activity:** alert on new proposals, approvals, and
  executions via the governance event stream; a proposal that appears without
  an accompanying ops ticket should be investigated.
- **Keep the signer list minimal and stable:** prefer a small, well-audited
  set over a large one — each signer is an attack surface and an availability
  dependency.

## 7. Troubleshooting

| Symptom | Likely cause | Resolution |
|---|---|---|
| `NotASigner` on create/approve/execute | Caller address is not in `MultiSigConfig.signers` | Confirm the exact signer address; check the config via `GET /governance/multisig/config` |
| `MultiSigNotInitialized` | `init_multisig` was never called or config was cleared | Re-run the bootstrap ceremony (§2.1) |
| `ThresholdNotMet` on execute | Fewer approvals than the configured threshold | Collect more approvals; check `GET /proposals/:id` for `approvals` |
| `AlreadyApproved` | Signer approved the same proposal twice | No action needed; count only distinct signers |
| `ProposalNotFound` | Wrong proposal id | Re-verify the id from the create response |
| `ProposalAlreadyExecuted` | Action already applied | Verify on-chain state; the change is live |
| `InvalidThreshold` on init | Threshold 0 or larger than signer count | Fix threshold/signers and re-init |

## 8. Reference: error codes

| Code | Name | Meaning |
|---|---|---|
| 9 | `NotASigner` | Address is not a signer |
| 10 | `ProposalNotFound` | Proposal id does not exist |
| 11 | `ProposalAlreadyExecuted` | Proposal was already executed |
| 12 | `AlreadyApproved` | Signer already approved this proposal |
| 13 | `InvalidThreshold` | Threshold is 0 or exceeds signer count |
| 14 | `ThresholdNotMet` | Not enough approvals to execute |
| 15 | `MultiSigNotInitialized` | Multi-sig config has not been initialized |

See `contracts/price-oracle/src/errors.rs` for the full list and
`api/src/infrastructure/catalog.ts` for HTTP status mappings.
