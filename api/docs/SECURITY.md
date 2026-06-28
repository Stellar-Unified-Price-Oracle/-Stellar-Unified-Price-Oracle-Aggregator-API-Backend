# Security Hardening

This document covers the security controls added across the aggregator and API
services: SSRF protection (#39), WebSocket upgrade hardening (#40), and
encryption at rest (#41).

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
```

Client flow with CSRF enabled:

```js
const { data } = await fetch('/api/v1/ws-token').then((r) => r.json());
const ws = new WebSocket(`wss://host:3001/?token=${data.token}`);
```

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

4. Store the `enc:` payload in `.env` (works for `ADMIN_SECRET_KEY`,
   `CHAINLINK_API_KEY`, `DATABASE_URL`). The services decrypt it automatically at
   startup. Plaintext values still work, so migration can be incremental.

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
