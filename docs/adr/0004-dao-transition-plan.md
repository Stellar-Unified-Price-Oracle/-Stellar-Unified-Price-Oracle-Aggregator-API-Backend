# ADR-0004: Staged transition from multisig to DAO governance

**Status:** Proposed

## Context

The platform already includes multi-sig controls and token-based governance entry points, but the governance surface should not be turned over to a fully autonomous DAO in one step. A staged transition reduces operational risk while preserving an emergency backstop for critical recovery actions.

## Decision

We will adopt a three-phase transition plan:

### Phase 1 — Multisig safety net

- Keep the multi-sig contract as the emergency backstop for pause, rollback, and recovery actions.
- Require a timelock or explicit signer quorum before escalated changes are applied.
- Keep parameter changes that affect security and liveness under the multi-sig route until the governance path has been validated.

### Phase 2 — Governance-controlled operational parameters

Move non-critical, reversible parameters to the governance contract only after a monitored pilot:

- oracle source allowlists;
- rate limits and tier thresholds;
- fee ceilings and gas-tuning policy defaults;
- non-critical deployment and feature flag policies.

Parameters remain controlled on chain only when there is a transparent voting path, quorum requirements, and a documented emergency rollback mechanism.

### Phase 3 — DAO governance and delegated oversight

- Delegate long-term direction to a token-based governance process once quorum, proposal thresholds, and vote-casting protections are validated in production.
- Preserve the multi-sig contract as a last-resort emergency override for critical incidents and major protocol breakage.
- Require a security review before any parameter is moved from emergency backstop to full DAO control.

## Rationale

This protects the network against governance capture, misconfiguration, and rushed operational changes while still allowing the system to evolve toward decentralization.

## Consequences

### Positive

- Safer incremental decentralization.
- Clear separation between operational recovery and strategic governance.
- Stronger traceability for parameter changes and security actions.

### Negative

- Governance decisions move more slowly during early phases.
- Operational teams must maintain both multi-sig and governance review processes.

## Related documents

- [Repository Governance](../GOVERNANCE.md)
- [Contract Upgrade Governance](../CONTRACT_UPGRADE_GOVERNANCE.md)
- [Service SLA](../service-sla.md)
