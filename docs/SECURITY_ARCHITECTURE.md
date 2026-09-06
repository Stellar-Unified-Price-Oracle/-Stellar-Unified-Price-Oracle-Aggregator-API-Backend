# Security Architecture & Threat Model

> Issue #309 — document the security architecture: SSRF protection,
> encryption at rest, API authentication, WebSocket signing, input
> sanitization, and secrets management, with a threat model and mitigation
> strategies.

This document is the **controls-level** companion to
[`THREAT_MODEL.md`](./THREAT_MODEL.md) (which describes the mainnet trust
boundaries and attacker profiles).  Here we describe, for each security
control area, *what* is implemented, *where* it lives in the code, *how* it
is verified, and *which threats it mitigates*.  All code references are to
`main` at the time of writing; follow the linked files for the current state.

## Control areas at a glance

| # | Control area | Implementation | Tests |
|---|---|---|---|
| 1 | SSRF protection | `services/aggregator/src/infrastructure/ssrf.ts` | `tests/ssrf-private-ip.test.ts`, `tests/ssrf-circuit-breaker.test.ts` |
| 2 | Encryption at rest | `api/src/governance/crypto.ts`, aggregator crypto util, `scripts/encrypt-secret.ts`, `packages/vault-client` | `tests/encryption-at-rest.test.ts`, `tests/history-encryption.test.ts` |
| 3 | API authentication | `api/src/governance/auth.ts`, `api/src/governance/api-key-manager.ts`, `api/src/governance/rbac.ts` | `api/tests/*` (auth, api-key, rate-limit suites) |
| 4 | WebSocket signing & upgrade protection | `api/src/governance/ws-signing.ts`, `api/src/infrastructure/csrf.ts`, `api/src/infrastructure/upgrade-guard.ts`, `api/src/infrastructure/server.ts` | WS auth/CSRF/signing suites |
| 5 | Input sanitization | `api/src/governance/sanitization.ts` | sanitization suites |
| 6 | Secrets management | `scripts/encrypt-secret.ts`, `scripts/rotate-secrets.sh`, `api/src/infrastructure/config.ts` (`decryptSecret`), `packages/vault-client` | `tests/encryption-at-rest.test.ts`, `docs/security/secret-rotation.md` |

```
                          ┌─────────────────────────────┐
                          │        Public clients        │
                          └──────────────┬──────────────┘
                                         │ HTTPS (Bearer / X-API-Key)
                                         ▼
        ┌───────────────────────────────────────────────────────────┐
        │  API service (api/)                                       │
        │  • rate limiting      • authMiddleware (RBAC, key tiers)  │
        │  • sanitizeInputs     • CSRF+signing on WS upgrade        │
        │  • AES-256-GCM at rest for history & secrets (enc: v1:)   │
        └──────────────┬────────────────────────────┬───────────────┘
                       │ RPC (submit prices)        │ outbound HTTP
                       ▼                            ▼
        ┌────────────────────────────┐   ┌──────────────────────────────┐
        │  Soroban contract (proxy)  │   │ Aggregator (services/…)      │
        │  — source of truth         │   │ • SSRF guard on all fetches  │
        │  — canary/upgrade guards   │   │ • deviation/staleness guards │
        └────────────────────────────┘   └──────────────────────────────┘
```

## 1. SSRF protection

**Where:** `services/aggregator/src/infrastructure/ssrf.ts`, wired into
`src/infrastructure/http-client.ts` (all outbound oracle-source requests).

The guard, applied before and during every outbound request, enforces:

1. **Protocol enforcement** — only `http:` / `https:` schemes are accepted.
2. **Host allowlisting** — only hosts derived from the configured source URLs
   (`config.ts::deriveSourceHosts`) may be contacted; anything else is
   rejected before a socket is opened.
3. **Private/internal IP blocking** — a CIDR blocklist covering
   `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`,
   `169.254.0.0/16` (cloud metadata, e.g. `169.254.169.254`),
   `172.16.0.0/12`, `192.168.0.0/16`, link-local, multicast, reserved and
   documentation ranges.  IPv6 loopback/link-local equivalents are blocked
   as well.
4. **DNS rebinding mitigation** — every resolved address used for the actual
   socket connection is re-validated against the blocklist via a custom
   lookup, so a resolver that returns a public IP on first query and a
   private IP on the connection attempt cannot smuggle traffic to internal
   services.
5. **Structured logging** — every blocked attempt is logged with the URL and
   the reason (`SsrfError`), feeding the circuit breaker.

**Threats mitigated:** internal-metadata theft (`169.254.169.254`), internal
service scanning/exploitation, port scanning of the VPC, and DNS-rebinding
based bypasses.  A compromised or malicious oracle source URL cannot be used
to reach the cluster's internal network.

**Verification:** `tests/ssrf-private-ip.test.ts` (private range rejection,
metadata endpoint blocking) and `tests/ssrf-circuit-breaker.test.ts`
(consecutive failures trip the outbound circuit breaker, preventing
repeated exploitation attempts).

## 2. Encryption at rest

**Where:** `api/src/governance/crypto.ts` (+ its aggregator counterpart),
`scripts/encrypt-secret.ts`, `packages/vault-client`.

- **Algorithm:** AES-256-GCM (authenticated encryption).  Every payload is
  versioned and tagged with a key id: `enc:v1:<keyId>:<iv_b64>:<tag_b64>:<ciphertext_b64>`.
- **Key derivation:** a raw 64-hex / 32-byte key is used directly; any other
  passphrase is stretched via scrypt with a fixed salt.  The active key is
  `ENCRYPTION_KEY`; `ENCRYPTION_KEY_PREVIOUS` is honored so data encrypted
  under a retired key keeps decrypting during rotation.
- **What is encrypted at rest:** price history entries (see
  `api/src/price-serving/price-store.ts`, `tests/history-encryption.test.ts`),
  and every sensitive `.env` value — secrets are stored as `enc:v1:…`
  strings and decrypted transparently at startup via `decryptSecret` in
  `api/src/infrastructure/config.ts` (and the aggregator equivalent).
- **Operator helper:** `scripts/encrypt-secret.ts` (`genkey`, `encrypt`,
  `decrypt`) produces the `enc:v1:…` strings operators paste into `.env`.
- **Vault integration:** API keys and webhook secrets are persisted to Vault
  through `packages/vault-client` (see `api-key-manager.ts` /
  `webhook-service.ts`), with at-rest encryption on the Vault side and
  in-memory decryption on first use.

**Threats mitigated:** database/file theft exposing historical prices or
credentials; secrets leaking via misconfigured backups; key-compromise blast
radius limited by per-key tagging and rotation.

**Verification:** `tests/encryption-at-rest.test.ts` (round-trip, tamper
detection, rotation with `ENCRYPTION_KEY_PREVIOUS`) and
`tests/history-encryption.test.ts`.

## 3. API authentication

**Where:** `api/src/governance/auth.ts`, `api/src/governance/api-key-manager.ts`,
`api/src/governance/rbac.ts`, wired in `api/src/index.ts`.

- **Credentials:** API keys presented as `Authorization: Bearer <key>` or
  `X-Api-Key: <key>` (`extractApiKey`).  Only the **SHA-256 hash** of a key
  is stored (`ApiKeyMetadata.keyHash`); the plaintext key is shown once at
  issuance.
- **Key tiers & rate limits:** `free` (60/min), `pro` (500/min),
  `enterprise` (10 000/min), `admin` (100 000/min) — enforced by
  `express-rate-limit` plus per-key limits in `api-key-manager.ts`.
- **RBAC:** keys carry a `Role`; `authMiddleware` / `optionalAuthMiddleware`
  gate admin and governance endpoints (`/api/v1/governance/*`), price
  endpoints (`/api/v1/prices`, `/api/v1/history`, `/api/v2/*`), and
  feature-flag/webhook routes.
- **Rotation:** keys can be marked for rotation with a grace window
  (`rotationExpiresAt`); old keys keep working until the window closes, then
  are rejected.  `scripts/rotate-secrets.sh api-keys` orchestrates a full
  rotation with `--dry-run` support.
- **Key storage:** key metadata is synced to/from Vault
  (`loadKeysFromVault` / `exportKeysForVault`).

**Threats mitigated:** unauthenticated access to priced data and admin
surfaces, credential stuffing (rate limits + hashed-at-rest keys), key
exfiltration (plaintext never stored), abuse of administrative endpoints
(RBAC), and prolonged exposure after a key leak (grace-windowed rotation).

## 4. WebSocket signing & upgrade protection

**Where:** `api/src/governance/ws-signing.ts`, `api/src/infrastructure/csrf.ts`,
`api/src/infrastructure/upgrade-guard.ts`, `api/src/infrastructure/server.ts`.

The WebSocket endpoint (`PriceWebSocketServer`) enforces, in order:

1. **API-key authentication on upgrade** — `validateWebSocketApiKey(req)`
   rejects connections without a valid key before the socket is accepted
   (`1008` + `UNAUTHORIZED`).
2. **CSRF tokens** (`csrf.ts`, issue #40) — a stateless HMAC-SHA256 token over
   the issue timestamp (`issueWsCsrfToken`) must be presented as the `token`
   query parameter; it carries an expiry and cannot be forged by a cross-site
   attacker who never sees `WS_CSRF_SECRET`.  The upgrade guard verifies it
   in `verifyClient` before any connection is opened.
3. **Signed query parameters** (`ws-signing.ts`) — for high-integrity
   integrations, clients sign their upgrade request:
   `sig = HMAC-SHA256(secret, ts.nonce.body)` with:
   - `ts` accepted only within **±30 s** of server time;
   - `nonce` recorded to **reject replays** (a used nonce is refused);
   - **constant-time** signature comparison (`timingSafeEqual`).
4. **Per-IP upgrade rate limiting & origin checks** — `WsUpgradeGuard`
   buckets connection attempts per client IP and rejects excessive
   handshakes; every rejected attempt is logged with the client IP.

**Threats mitigated:** cross-site WebSocket hijacking (CSRF tokens), replay
of captured upgrade requests (nonce + TTL), unauthorized access to the price
stream (API key), handshake flooding (per-IP rate limits), and forged
upgrade signatures (HMAC + timing-safe compare).

## 5. Input sanitization

**Where:** `api/src/governance/sanitization.ts`, mounted as
`sanitizeInputs` middleware on the API (`api/src/index.ts`).

- **Prototype-pollution defense** — keys named `__proto__`, `constructor`
  and `prototype` are stripped recursively from request bodies before any
  handler sees them.
- **HTML/script neutralization** — string values have tag syntax
  (`<…>`) and dangerous punctuation (`< > " ' ` ; \`) removed, so
  stored/reflected values cannot carry markup into admin UIs or logs.
- **Control-character removal** — `[\u0000-\u001F\u007F]` are stripped.
- **Recursive traversal** — arrays and nested objects are sanitized
  depth-first; the sanitized tree replaces `req.body`.

**Threats mitigated:** prototype pollution (affecting JSON-parsing
middleware, template/log sinks), stored and reflected XSS through
governance/admin endpoints, and log/console injection via control
characters.

## 6. Secrets management

**Where:** `scripts/encrypt-secret.ts`, `scripts/rotate-secrets.sh`,
`.github/workflows/secret-rotation-drill.yml`,
`docs/security/secret-rotation.md`, `api/src/infrastructure/config.ts`
(`decryptSecret`), `packages/vault-client`.

- **At-rest encryption of `.env` secrets** — sensitive values are stored as
  `enc:v1:<keyId>:…` payloads (AES-256-GCM) and decrypted at startup; a
  plaintext secret never needs to live in the repo or the deploy artifact.
- **Rotation orchestration** — `scripts/rotate-secrets.sh` drives rotation
  for every secret category: `encryption-key`, `api-keys`, `ws-secrets`,
  `db-credentials`, `signer-key` (and `all`), with `--dry-run` for the
  quarterly drill workflow.  Encryption-key rotation keeps decrypting old
  data via `ENCRYPTION_KEY_PREVIOUS`.
- **Vault-backed storage** — API keys and webhook secrets are pushed to Vault
  (`vault-client`) and loaded at startup, so rotation is a single Vault write
  rather than a redeploy.
- **No secrets in code** — CI only sees secrets via GitHub Actions secrets /
  Vault; the audit runbooks (`docs/security/audit-findings.md`,
  `docs/security/pentest-scope.md`) track the remaining gaps.

**Threats mitigated:** credential exfiltration from source control or logs,
long-lived-key compromise, DB/dump leaks (see §2), and unrotated credentials
after an incident.

## Consolidated threat model & mitigations

| Threat | Affected control | Mitigation (implemented) | Verification |
|---|---|---|---|
| SSRF — internal metadata/service access via oracle-source URLs | §1 | Protocol allowlist, host allowlist, private-IP CIDR block, DNS-rebinding revalidation, circuit breaker | ssrf-private-ip / ssrf-circuit-breaker tests |
| Data-at-rest theft (DB/backups/history) | §2 | AES-256-GCM `enc:v1:` payloads, per-key tagging, rotation with previous-key grace | encryption-at-rest / history-encryption tests |
| Unauthenticated/unauthorized API access | §3 | Bearer/X-API-Key auth, SHA-256 hashed keys, RBAC roles, tiered rate limits | API auth + rate-limit suites |
| Key exfiltration | §2, §3, §6 | Plaintext never stored; Vault-backed keys; startup decryption | encryption-at-rest, api-key tests |
| Credential rotation failure after a leak | §3, §6 | Grace-windowed key rotation; `rotate-secrets.sh` + quarterly drill | secret-rotation drill workflow |
| WebSocket CSRF / hijack | §4 | HMAC CSRF token with expiry on upgrade | WS CSRF tests |
| WebSocket request replay | §4 | `ts` ±30 s TTL + nonce dedup + timing-safe HMAC verify | WS signing tests |
| WebSocket handshake flood | §4 | Per-IP upgrade buckets + connection caps | upgrade-guard tests |
| Prototype pollution / XSS / log injection | §5 | Recursive sanitization: dangerous keys stripped, markup + control chars removed | sanitization suites |

## Review cadence

This document must be reviewed:

- before mainnet launch;
- after any change to the trust boundaries in `THREAT_MODEL.md` (new region,
  new source integration, plugin execution host);
- after each security audit cycle — fold findings into
  `docs/security/audit-findings.md` and update the tables above.

## Related documents

- [`THREAT_MODEL.md`](./THREAT_MODEL.md) — trust boundaries & attacker profiles
- [`docs/security/secret-rotation.md`](./security/secret-rotation.md) — rotation runbook
- [`docs/security/audit-findings.md`](./security/audit-findings.md) & [`docs/security/pentest-scope.md`](./security/pentest-scope.md)
- [`SANDBOX_SECURITY_REVIEW.md`](./SANDBOX_SECURITY_REVIEW.md) — programmable feed / plugin sandbox
- [`GOVERNANCE.md`](./GOVERNANCE.md) — branch protection, signed commits, CODEOWNERS
