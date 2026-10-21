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

## API key bootstrap

The REST API authenticates requests with API keys (issue #592). On startup the
API reports where its keys came from and, in production, refuses to start when
no key source is configured:

```
API key bootstrap: source=env count=3 health=env-seeded
```

| Field | Values | Meaning |
|---|---|---|
| `source` | `env` \| `vault` \| `generated` \| `none` | Where the loaded keys came from |
| `count` | integer | Keys currently in the in-memory store |
| `health` | `empty` \| `env-seeded` \| `store-backed` | Durability of the configured key store; also exposed as `keyStore` on `GET /api/v1/health/ready` |
| `ephemeral` | boolean | Whether a non-durable fallback key exists |

### Bootstrap procedure

1. **Production (required).** Set `API_KEYS` before starting the API. Format is
   comma-separated `key:rateLimit:description:tier:role`, e.g.
   `API_KEYS=<generated>:100000:platform-admin:admin:admin`. The process exits
   with `MissingKeySourceError` (`MISSING_KEY_SOURCE`) when `NODE_ENV=production`
   and neither `API_KEYS` nor the Vault key store supplies a key. Keys can also
   live in Vault (`store-backed`); `API_KEYS` seeds Vault when the store is empty.
2. **Local development and tests (opt-in).** Set
   `ALLOW_EPHEMERAL_ADMIN_KEY=true` to let the API boot without `API_KEYS`. It
   generates one throwaway admin key in memory, prefixed with
   `ADMIN_KEY_PREFIX` (default `admin_`).
3. **Retrieval.** Key material is never written to logs, metrics, or any other
   log sink. The ephemeral key is available exactly once in-process through
   `apiKeyManager.takeBootstrapKey()`; `GET /api/v1/health/ready` only exposes
   the non-secret `keyStore` state. Treat any log line containing a full key as
   an incident and rotate it.

Generated admin keys use `ADMIN_KEY_PREFIX`, so operational tooling that
matches on the documented prefix recognizes them.

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

## API key store (admin/oracle API keys)

API keys are a separate tier from the signer keys above: they authorize REST
and admin API calls, not on-chain writes, and they are managed by
`api/src/governance/api-key-manager.ts`.

- **What is stored.** The key store is Vault KV at `secret/data/api/keys`, a
  map of SHA-256 hash → metadata (display prefix, tier, role, scopes, rate
  limit, active flag, created-at). The plaintext key is never written;
  `exportKeysForVault()` emits a blank `key` field by contract. On restore,
  validation hashes the presented key and matches it against `keyHash`, so a
  restored key validates while the plaintext remains unrecoverable.
- **Write-through persistence.** Every mutation (create, rotate, tier, rate
  limit, revoke, reactivate, delete) runs inside a transaction that re-reads
  the store, applies the mutation, and persists before the response is sent.
  A failed store write rolls the mutation back and the request fails with
  `KEY_STORE_WRITE_FAILED` — no key ever exists only in memory.
- **Replica consistency.** Replicas re-read the store every 30 seconds, so a
  rotation or revoke propagates cluster-wide within that window and survives
  restart immediately. Rotation is proven end-to-end by the drill test in
  `api/tests/key-store-persistence.test.ts` (rotate → restart → old key
  rejected, new key accepted).
- **Startup conflicts.** At boot the store is compared against keys seeded
  from `API_KEYS`; a same-prefix/different-hash conflict is logged and both
  keys are retained rather than silently preferring one.
- **Procedure alignment.** The rotation procedure for API keys is
  `scripts/rotate-secrets.sh api-keys` (a `POST /admin/keys/:hash/rotate`
  call), documented in `docs/security/secret-rotation.md` and exercised by
  the quarterly drill in `.github/workflows/secret-rotation-drill.yml` — the
  drill's dry-run output and this document describe the same code path.

## Managed runtime secrets

Kubernetes runtime secrets are synchronized from AWS Secrets Manager by External Secrets Operator. The `aws-secrets-manager` `ClusterSecretStore` must use workload identity and be restricted to the environment's `stellar-oracle/runtime` secret; cluster roles may read that secret but may not write it. Store JSON properties `API_KEYS`, `ADMIN_SECRET_KEY`, `ORACLE_API_KEY`, `DATABASE_URL`, and `POSTGRES_PASSWORD` there. The ExternalSecret manifests create the Kubernetes Secret objects consumed by the API, aggregator and database. Never commit values or copy a filled secret manifest into this repository.

Before a release, run `scripts/validate-deployed-secrets.sh <namespace>`: it waits for External Secrets synchronization and rejects missing or placeholder values. To bootstrap, install External Secrets Operator, provision the `aws-secrets-manager` ClusterSecretStore and workload identity, then create the versioned secret in AWS Secrets Manager using the listed property names. Rotation updates the provider secret; the operator refreshes it within one hour. Restart affected workloads after synchronization and verify readiness. AWS CloudTrail records writes and actor identity. For recovery, restore the previous Secrets Manager version, wait for ExternalSecret Ready, then roll back the affected workload. The quarterly rotation drill validates the rotation scripts; operators must also verify provider version change and synchronization in the target environment.

**Owners:** Security Engineering owns AWS secret policies and recovery; Platform Operations owns External Secrets and workload rollout. Break-glass access requires incident commander approval, a time-limited audited AWS role, and a post-incident CloudTrail review. Revoke the role immediately after recovery.
