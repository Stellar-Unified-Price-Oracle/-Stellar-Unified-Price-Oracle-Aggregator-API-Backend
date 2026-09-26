# Post-Quantum Readiness — Plan vs Implementation

## Status (as of this revision)

**Nothing is implemented on-chain.** The three PQ types (`PostQuantumScheme`,
`PostQuantumAdminKey`, `HybridSignature`) that previously existed in
`contracts/price-oracle/src/types.rs` have been **removed** (issue #573).
The three reserved `DataKey` variants (`PostQuantumAdminKey(String)`,
`PostQuantumKeyLog(u32)`, `PostQuantumKeyLogCount`) remain as comments so the
storage layout migration log has an audit trail, but no entrypoint reads or
writes them.

## Migration note for reserved keys

The keys `PostQuantumAdminKey(String)`, `PostQuantumKeyLog(u32)`, and
`PostQuantumKeyLogCount` were reserved in the `DataKey` enum but were never
populated by any entrypoint. Consequently:

- No deployed contract instance contains data under these keys.
- A future contract upgrade that removes them from `DataKey` is safe with no
  data-migration step.
- If a future upgrade does populate them, the schema must be described here
  before the upgrade is executed.

## Planned feature scope

The following describes the **intended** PQ feature — none of it is
implemented or tested. This section must be updated to reflect the
implementation status of each item before any mainnet deployment.

| Feature | Status |
|---|---|
| `PostQuantumScheme` / `PostQuantumAdminKey` / `HybridSignature` types | **Removed** — re-add when implementation begins |
| `register_pq_admin_key(admin, scheme, public_key)` entrypoint | **Not implemented** |
| Activation delay (configurable cooldown, default 7 days) | **Not implemented** |
| `activate_pq_admin_key(fingerprint)` entrypoint | **Not implemented** |
| `revoke_pq_admin_key(fingerprint)` entrypoint | **Not implemented** |
| `PostQuantumKeyLog` / `PostQuantumKeyLogCount` storage population | **Not implemented** |
| `HybridSignature` verification alongside `ed25519 require_auth` | **Not implemented** |
| `PQ_CRYPTO_ENABLED` feature gate | **Not implemented** |

## What "implemented" must mean before this document can claim readiness

1. Entrypoints for registration, activation, and revocation exist and are
   tested with the Soroban test framework.
2. `HybridSignature` verification is wired into at least one admin-guarded
   entrypoint and tested for the allowed and denied cases.
3. The activation delay is enforced on-chain (ledger timestamp comparison).
4. Revocation is irreversible and covered by a test.
5. All new storage keys are described in `docs/SCHEMA_MIGRATIONS.md` with
   their type, TTL tier, and pruning strategy.
6. `docs/THREAT_MODEL.md` is updated to reflect what the PQ path protects
   against and what it does not.

## Hybrid TLS (off-chain)

Hybrid TLS is an API policy concern and does not depend on the contract.
`PQ_TLS_ENABLED=true` requires TLS 1.3, X25519+ML-KEM, and a Node binary
linked against OpenSSL 3.x with PQ provider support (or BoringSSL). This
is independent of the on-chain PQ admin key lifecycle above.

## Threat monitoring

`PQ_THREAT_FEED_URL` and `PQ_THREAT_ALERT_THRESHOLD` control the off-chain
threat-level monitor. When the observed level meets or exceeds the threshold,
the migration documented above becomes **mandatory**.
