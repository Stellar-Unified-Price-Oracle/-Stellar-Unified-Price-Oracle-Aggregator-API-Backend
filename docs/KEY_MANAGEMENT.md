# Key Management: Admin and Oracle-Source Signers

This document defines the key hierarchy, backup, and emergency-rotation
procedure for the keys that authorize on-chain writes: the contract
`ADMIN_SECRET_KEY` and per-source oracle signer keys. Compromise of any of
these keys is a critical incident — treat rotation as urgent, not routine.

## Key hierarchy

| Tier | Key | Authorizes | Custody target |
|---|---|---|---|
| 1 | Mainnet admin key (`ADMIN_SECRET_KEY`) | Admin-gated contract calls (config changes, source management, admin transfer) | HSM or KMS-backed signing proxy — never plaintext on a service host |
| 2 | Multi-sig / governance signer keys | Proposal approval and execution (see `docs/CONTRACT_UPGRADE_GOVERNANCE.md`) | One key per signer, each independently custodied (HSM, hardware wallet, or KMS) |
| 3 | Oracle-source signer keys | Submitting price updates from a given source | KMS-backed signing per source; scoped so a single source key cannot perform admin actions |
| 4 | Fee-source key | Paying Soroban transaction fees | KMS-backed; kept separate from tier 1–3 keys so fee spend is isolated and rate-limitable |

No tier-1 or tier-3 key should ever exist as a plaintext value in an `.env`
file, deploy artifact, container image, or log line. At rest today, secrets
configured via `.env` (including `ADMIN_SECRET_KEY`) can be stored using the
`enc:v1:` envelope produced by `scripts/encrypt-secret.ts` (issue #41); this
is an interim mitigation for values that must still pass through process
environment variables and does not replace HSM/KMS custody as the target
state — the encrypted envelope is decrypted into process memory at startup,
whereas HSM/KMS signing keeps the private key material outside the process
entirely and signs via a remote call.

## Target signing architecture

- Mainnet admin and source-signer keys are generated and held inside an
  HSM or a cloud KMS (e.g. a KMS signing proxy exposing a `sign(payload)`
  RPC, or a Soroban CLI hardware-wallet integration for interactive admin
  actions).
- Services never read the private key; they call the signing proxy with the
  transaction payload and receive back a signature, matching the existing
  `services/aggregator/src/infrastructure/crypto.ts` signing call sites.
- Access to invoke the signing proxy is itself access-controlled and logged,
  so every signature is attributable to the caller and request that produced
  it.

## Backup

- Each HSM/KMS key must have its recovery material (KMS key policy backup,
  or HSM key-ceremony shares) stored per the provider's standard
  multi-party backup procedure — no single operator holds a full recovery
  set.
- Recovery material is stored offline and geographically separated from the
  primary signing environment.
- Backup restoration is tested at least once per quarter in a non-production
  environment, with results logged in `docs/runbooks/`.

## Emergency rotation

1. **Detect/declare** — any suspected compromise of a tier 1–4 key is treated
   as a security incident immediately, regardless of confidence level.
2. **Contain** — for a signer key, propose `RemoveSigner` for the compromised
   key (see `docs/CONTRACT_UPGRADE_GOVERNANCE.md`); for the admin key, halt
   any pending admin-gated proposals until rotation completes.
3. **Rotate** — generate a new key in the HSM/KMS, propose `AddSigner` (or the
   admin-transfer equivalent) for the replacement, and get it approved and
   executed on-chain.
4. **Revoke** — disable/delete the compromised key material in the HSM/KMS
   once the replacement is live and confirmed on-chain.
5. **Record** — document the incident timeline, proposal IDs, and approving
   signers in `docs/runbooks/`.

## Verifying no plaintext key exposure

- Deploy artifacts and container images: confirm no `.env` file or baked-in
  secret is present in the built image (`docker history`, layer inspection).
- Logs: confirm signer/admin keys are never logged; grep production log
  output for the key prefix pattern as a spot check after any change to the
  signing path.
- Environment: confirm `ADMIN_SECRET_KEY` and source signer keys are supplied
  either via the `enc:v1:` envelope (interim) or, once migrated, are absent
  from the environment entirely in favor of the KMS/HSM signing-proxy
  endpoint.
