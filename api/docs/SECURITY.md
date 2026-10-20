# Security Hardening

This document covers the security controls added across the aggregator and API
services: SSRF protection (#39), WebSocket upgrade hardening (#40), encryption
at rest (#41), single-publisher fencing (#745), consistency objectives (#746),
and policy-scoped consumer credentials (#748).

---

## Single-Publisher Fencing (#745)

**Owner:** Global operations and resilience. **Scope:** aggregator publisher
authority and every write path that accepts publisher submissions.

Exactly one region holds publisher authority at a time. Authority is expressed
as a monotonically increasing **fence token** (epoch) that is issued on
failover and attached to every accepted submission.

- **Authority source** — the active region's fence token is stored in the
  shared coordination store and mirrored to the aggregator's local state.
- **Submission check** — every publish request carries the region's fence
  token; the aggregator rejects a submission whose token is lower than the
  currently observed token (`stale-fence`) or whose region is not the current
  authority (`not-authority`).
- **Isolation** — a region that loses contact with the coordination store stops
  accepting submissions after `FENCE_LEASE_MS` (lease expiry) rather than
  continuing to publish on stale authority.
- **Restart safety** — on restart a region re-reads the fence token before
  accepting writes; it never resumes publishing from cached authority.
- **Unambiguous authority** — fence tokens are strictly increasing, so two
  regions can never hold the same token; ties are impossible by construction.

Configuration:

```
FENCE_LEASE_MS=15000            # isolated region stops publishing after this
FENCE_TOKEN_KEY=fence:authority # coordination-store key holding the token
```

Monitoring signals:

- `publisher_fence_token` (gauge) — current observed token per region.
- `publisher_rejected_total{reason="stale-fence"|"not-authority"}` — rejected
  submissions; a sustained non-zero rate after failover indicates a stale
  region still attempting to publish.
- `publisher_lease_expired_total` — regions that lost authority by lease
  expiry.

Verification: automated failover tests assert that a stale or isolated region
cannot submit after failover and that authority is unambiguous across
partitions and restarts.

Rollout / rollback: enable fencing in observe-only mode first (rejections are
logged but not enforced), confirm `publisher_fence_token` agrees across regions,
then enforce. Rollback is to observe-only mode; no data migration is required.

---

## Consistency Objectives by Data Product (#746)

**Owner:** Global operations and resilience. **Scope:** live prices, history,
catalog, and analytics.

Each data product has its own measurable consistency and freshness objective
with consumer-visible semantics:

| Data product | Consistency objective | Freshness objective | Consumer semantics |
| --- | --- | --- | --- |
| Live prices | Read-your-writes within a region; monotonic timestamps | p99 staleness ≤ `LIVE_PRICE_MAX_STALENESS_MS` | A returned price is never older than the freshness bound; stale reads are flagged |
| History | Eventually consistent; append-only, no gaps | p99 propagation ≤ `HISTORY_MAX_LAG_MS` | Recently written points may be briefly absent but never reordered |
| Catalog | Read-your-writes; bounded staleness | p99 staleness ≤ `CATALOG_MAX_STALENESS_MS` | Metadata changes become visible within the bound |
| Analytics | Eventually consistent | p99 lag ≤ `ANALYTICS_MAX_LAG_MS` | Aggregates are best-effort and may trail live data |

Configuration:

```
LIVE_PRICE_MAX_STALENESS_MS=2000
HISTORY_MAX_LAG_MS=60000
CATALOG_MAX_STALENESS_MS=30000
ANALYTICS_MAX_LAG_MS=300000
```

Monitoring signals: per-product staleness/lag gauges
(`data_freshness_ms{product=...}`) and objective-breach counters
(`consistency_objective_breach_total{product=...}`). Responses that exceed the
freshness bound are marked stale so consumers can react.

Verification: automated tests cover normal operation, boundary (exactly at the
objective) and failure (replica lag, partition) cases.

Rollout / rollback: objectives are observability-first — publish the gauges and
breach counters, tune thresholds against observed baselines, then enforce
stale-flagging. Rollback is to disable enforcement; thresholds are config-only.

---

## Policy-Scoped Consumer Credentials (#748)

**Owner:** Security and privacy assurance. **Scope:** every API surface
(REST, WebSocket, and admin endpoints).

Consumer credentials carry a **policy scope** that restricts what they may
access. Scopes are enforced consistently at every API surface before the
request reaches business logic.

Scope dimensions:

- **Feeds** — the set of feeds/data products the credential may read.
- **Operations** — the allowed operations (e.g. `read`, `subscribe`, `write`).
- **Environments** — the environments the credential is valid in
  (`production`, `staging`, …).
- **Expiry** — an absolute expiry after which the credential is rejected.

Enforcement:

- **REST** — scope is checked in the auth middleware; out-of-scope requests
  return `403` with a `scope` reason.
- **WebSocket** — scope is checked during the upgrade guard, so an out-of-scope
  subscription is rejected before the socket is accepted.
- **Admin** — admin credentials are scoped the same way; there is no implicit
  superuser bypass.

Configuration:

```
CREDENTIAL_SCOPE_ENFORCED=true   # false = log-only (compatibility mode)
CREDENTIAL_MAX_TTL_MS=7776000000 # 90 days
```

Monitoring signals: `credential_scope_rejected_total{surface,reason}` and
`credential_expired_total`. In log-only mode the same counters record would-be
rejections so impact can be measured before enforcement.

Verification: automated tests cover normal access, boundary (expiry instant,
empty feed set) and failure (wrong environment, out-of-scope feed) cases across
REST, WebSocket, and admin surfaces.

Rollout / rollback: issue scoped credentials alongside existing keys, run in
log-only mode to measure would-be rejections, then enforce. Rollback is to
log-only mode; existing unscoped keys remain valid until enforcement is enabled.

---

## SSRF Protection for Outbound Oracle Requests (#39)

All outbound HTTP requests to oracle sources (Chainlink/CryptoCompare, Redstone,
Band, Reflector) go through a hardened HTTP client
(`services/aggregator/src/utils/http-client.ts`) backed by an SSRF guard
(`services/aggregator/src/utils/ssrf.ts`).

Controls:

- **Host allowlist** — requests may only reach the hostnames of the configured
  source URLs, plus any extra hosts in `ORACLE_ALLOWED_HOSTS`.
- **Protocol enforcement** — only `http`/`https` are permitted.
- **Internal IP blocking** — loopback, private, link-local (incl. the
  `169.254.169.254` cloud metadata endpoint), CGNAT, and reserved ranges are
  rejected for both IPv4 and IPv6 (including IPv4-mapped IPv6).
- **DNS rebinding mitigation** — a custom DNS lookup re-validates *every*
  resolved address at socket-connect time, so a hostname that passes the
  allowlist but later resolves to an internal IP is still blocked.
- **No redirects** — `maxRedirects: 0` prevents redirect-based allowlist bypass.
- **Logging** — every blocked attempt is logged with the offending URL and the
  reason (`allowlist`, `protocol`, `private-ip`, `dns-rebinding`, …).

Configuration:

```
ORACLE_ALLOWED_HOSTS=          # extra comma-separated allowed hosts
SSRF_PROTECTION_ENABLED=true
SSRF_ALLOW_PRIVATE_IPS=false   # testing only
OUTBOUND_REQUEST_TIMEOUT_MS=10000
```

> Network-level egress controls (firewall/security-group egress rules limiting
> the services to the oracle hosts) are recommended as defense in depth.

### Deployment egress policy verification (#750)

The API exposes a read-only view of the effective outbound egress policy so
operators can prove that provider and integration destinations are constrained
by the deployment's environment policy.

- Policy source: `api/src/services/egress-policy.ts` builds the policy from
  `EGRESS_ALLOWED_HOSTS` (comma-separated hostnames, optional `:port`),
  `EGRESS_ALLOWED_PORTS`, and `EGRESS_POLICY_MODE` (`enforce` | `report`).
- Endpoint: `GET /api/v1/admin/egress-policy` (admin auth required) returns the
  allowed hosts/ports, the mode, and the resolved policy fingerprint.
- Verification: `POST /api/v1/admin/egress-policy/verify` with
  `{ "url": "https://..." }` returns `allowed: true|false` plus the reason
  (`allowlist`, `protocol`, `private-ip`, `dns-rebinding`, `port`). The check
  reuses the same SSRF guard as the aggregator, so redirects (`maxRedirects: 0`)
  and DNS re-resolution at connect time cannot bypass the policy.
- Monitoring: every blocked egress attempt is logged with the destination and
  reason; alert on sustained `egress_blocked` events after a deployment.

Configuration:

```
EGRESS_POLICY_MODE=enforce        # report = log-only, enforce = block
EGRESS_ALLOWED_HOSTS=api.chain.link,api.redstone.finance
EGRESS_ALLOWED_PORTS=443
```

Rollout: deploy with `EGRESS_POLICY_MODE=report`, compare logged destinations
against `EGRESS_ALLOWED_HOSTS`, then flip to `enforce`. Rollback: set
`EGRESS_POLICY_MODE=report` (no restart of the aggregator required) or remove
the variable to fall back to the SSRF allowlist derived from source URLs.

---

## WebSocket Upgrade Hardening (#40)

Both WebSocket servers validate the upgrade request before accepting a
connection:

- **API** — `api/src/websocket/upgrade-guard.ts`
- **Aggregator** — `services/aggregator/src/utils/ws-guard.ts`

Controls:

- **Origin validation** — the `Origin` header is checked against
  `WS_ALLOWED_ORIGINS`. With `WS_REQUIRE_ORIGIN=true`, clients with no Origin
  header are rejected.
- **Per-IP rate limiting** — connection attempts are limited per IP within a
  sliding window (`WS_RATE_LIMIT_MAX` / `WS_RATE_LIMIT_WINDOW_MS`).
- **CSRF tokens (API)** — when `WS_CSRF_SECRET` is set, clients must obtain a
  short-lived token from `GET /api/v1/ws-token` and present it as `?token=<token>`
  on the WebSocket URL. Tokens are HMAC-signed and time-bound.
- **HMAC signing (API)** — when `WS_HMAC_SECRET` is set, clients must sign the
  upgrade URL with `?ts=<epoch_ms>&nonce=<unique-id>&sig=<hex-hmac>`.
  Verification runs before the WebSocket upgrade is accepted.
- **Logging** — every rejected upgrade is logged with the client IP, origin, and
  reason.

Configuration:

```
WS_ALLOWED_ORIGINS=https://app.example.com,https://admin.example.com
WS_REQUIRE_ORIGIN=true
WS_RATE_LIMIT_MAX=20
WS_RATE_LIMIT_WINDOW_MS=60000
WS_CSRF_SECRET=<random-secret>     # enables CSRF tokens when set
WS_CSRF_TTL_MS=300000
WS_HMAC_SECRET=<random-secret>     # enables signed WS upgrades when set
```

Client flow with CSRF enabled:

```js
const { data } = await fetch('/api/v1/ws-token').then((r) => r.json());
const ws = new WebSocket(`wss://host:3001/?token=${data.token}`);
```

Client flow with HMAC enabled:

```js
import crypto from 'node:crypto';

const ts = Date.now();
const nonce = crypto.randomUUID();
const sig = crypto
  .createHmac('sha256', process.env.WS_HMAC_SECRET)
  .update(`${ts}.${nonce}.`)
  .digest('hex');

const ws = new WebSocket(`wss://host:3001/?ts=${ts}&nonce=${nonce}&sig=${sig}`);
```

The timestamp must be within 30 seconds of server time. Nonces are single-use
inside that window to reject replayed upgrade URLs. If CSRF and HMAC are both
enabled, include `token`, `ts`, `nonce`, and `sig` in the same query string.

---

## Encryption at Rest (#41)

Sensitive configuration values and historical price data can be encrypted at
rest using AES-256-GCM authenticated encryption.

- API util: `api/src/services/crypto.ts`
- Aggregator util: `services/aggregator/src/utils/crypto.ts`

Both services share the same on-disk format and the same `ENCRYPTION_KEY`, so
data encrypted by one decrypts in the other.

### Setup

1. Generate a key:

   ```bash
   tsx scripts/encrypt-secret.ts genkey
   ```

2. Add it to your environment:

   ```
   ENCRYPTION_KEY=<64-hex-chars>
   ```

3. Encrypt a sensitive value:

   ```bash
   tsx scripts/encrypt-secret.ts encrypt "S...ADMIN_SECRET..."
   # -> enc:v1:<keyId>:<iv>:<tag>:<ciphertext>
   ```

4. Store the `enc:` payload in `.env`. Sensitive values such as
   `ADMIN_SECRET_KEY`, `ADMIN_API_KEY`, `API_KEYS`, `DATABASE_URL`,
   `DATABASE_REPLICA_URLS`, `REDIS_URL`, WebSocket secrets, audit secrets,
   backup encryption keys, oracle API keys, and alert/webhook secrets are
   decrypted automatically at startup. Plaintext values still work, so migration
   can be incremental.

### Encrypting historical data

Set `ENCRYPT_HISTORY=true` (with `ENCRYPTION_KEY` set) so the aggregator writes
encrypted history files. The API reads and decrypts them transparently.

### Key rotation

Encrypted payloads carry a key id, so multiple keys can decrypt concurrently:

1. Move the current key to `ENCRYPTION_KEY_PREVIOUS`.
2. Set a new `ENCRYPTION_KEY`.
3. Re-encrypt secrets/data with the new key (old payloads keep decrypting via the
   previous key).
4. Once everything is re-encrypted, drop `ENCRYPTION_KEY_PREVIOUS`.

### Key management & performance

- Store keys in a secrets manager (AWS KMS / GCP Secret Manager / Vault) and
  inject them as environment variables; never commit keys.
- Enable disk-level/volume encryption on hosts as defense in depth.
- AES-256-GCM is hardware-accelerated (AES-NI); the per-record overhead on
  history writes is negligible (low microseconds per value).

---

## Cryptographic Key Inventory & Lifecycle (#751)

Every signing, encryption, and verification key has an owner, a purpose, and a
rotation/retirement plan. The inventory is defined in
`api/src/services/key-inventory.ts` and exposed read-only at
`GET /api/v1/admin/key-inventory` (admin auth required).

Each entry records:

- `id` — stable key identifier (matches the `keyId` embedded in `enc:v1:` payloads)
- `owner` — team or role accountable for rotation
- `purpose` — `encryption` | `signing` | `verification`
- `algorithm` — e.g. `aes-256-gcm`, `hmac-sha256`
- `rotationDays` — maximum age before rotation is required
- `retireBy` — date after which the key must no longer be used
- `transitionTo` — algorithm/key id that replaces this key, if any

The endpoint reports `status` per key (`active`, `due`, `overdue`, `retired`)
computed from `rotationDays` and `retireBy`, so monitoring can alert on `due`
and `overdue` entries.

### Lifecycle procedure

1. **Add** — register the new key in the inventory with owner and rotation
   window before it is used.
2. **Rotate** — for encryption keys follow the `ENCRYPTION_KEY_PREVIOUS`
   procedure above; for signing keys publish the new key id and keep the old
   verification key until all consumers have migrated.
3. **Retire** — once no payloads or tokens reference the old key id, remove it
   from the environment and mark it `retired` in the inventory.
4. **Algorithm transition** — set `transitionTo` on the old entry and keep both
   keys decryptable/verifiable until the transition completes.

Rollout: deploy the inventory with existing keys marked `active`; review the
`due`/`overdue` report weekly. Rollback: the endpoint is read-only and has no
runtime effect, so reverting the code change does not affect key material.
