# Client-side price integrity verification (issue #719)

Clients can verify that a price snapshot published by the oracle API was
authored by a trusted key and has not been tampered with. The verifier
**clearly rejects** invalid signatures, unknown keys, and unsupported schema
versions.

## Snapshot format

A signed price snapshot is a JSON object:

```json
{
  "schemaVersion": 1,
  "asset": "XLM",
  "price": "42000000",
  "decimals": 7,
  "timestamp": 1700000000,
  "sources": ["chainlink", "redstone"],
  "keyId": "oracle-v1-primary",
  "signature": "hex-encoded-hmac-sha256"
}
```

| Field | Meaning |
|---|---|
| `schemaVersion` | Snapshot schema version; only versions listed in `SUPPORTED_SCHEMA_VERSIONS` are accepted |
| `asset` | Asset symbol (e.g. `XLM`, `BTC`) |
| `price` | Price as a decimal string, scaled by `decimals` |
| `decimals` | Price decimal places |
| `timestamp` | Observation time, Unix seconds |
| `sources` | Oracle sources contributing to the price |
| `keyId` | Identifier of the trusted verification key |
| `signature` | HMAC-SHA256 of the canonical payload, hex-encoded |

## Canonical payload

The signature is computed over a fixed field order so clients and the
signer always agree on what was signed:

```ts
JSON.stringify({
  schemaVersion, asset, price, decimals, timestamp, sources,
})
```

`keyId` and `signature` are **not** part of the signed payload.

## Verification

The verifier (`api/src/price-serving/snapshot-verifier.ts`) checks, in order:

1. **Schema version** — must be in `SUPPORTED_SCHEMA_VERSIONS` (currently `[1]`).
   Unsupported versions are rejected with `UNSUPPORTED_SCHEMA`.
2. **Key id** — `keyId` must exist in `TRUSTED_KEYS`. Unknown keys are
   rejected with `UNKNOWN_KEY`.
3. **Signature** — HMAC-SHA256 of the canonical payload, compared with
   `crypto.timingSafeEqual`. Mismatches are rejected with
   `INVALID_SIGNATURE`.

Only when all three pass is the price returned as valid.

## Client example (TypeScript)

```ts
import { verifyPriceSnapshot } from './snapshot-verifier';

const snapshot = await fetch('https://api.stellar-oracle.com/api/v2/prices/XLM/snapshot')
  .then((r) => r.json());

const result = verifyPriceSnapshot(snapshot);

if (!result.valid) {
  console.error('Snapshot rejected:', result.rejection?.code, result.rejection?.message);
  return;
}

console.log('Verified price:', result.price);
```

## Rejection codes

| Code | Meaning | Client action |
|---|---|---|
| `UNSUPPORTED_SCHEMA` | `schemaVersion` not in the supported list | Do not consume; upgrade client or check for a newer verifier |
| `UNKNOWN_KEY` | `keyId` not in `TRUSTED_KEYS` | Do not consume; the key may be rotated or compromised |
| `INVALID_SIGNATURE` | Signature does not match the payload | Do not consume; the snapshot was tampered with or signed by a different key |
| `MALFORMED` | Snapshot is not a well-formed object | Do not consume; malformed input |

## Owner, scope, evidence

- **Owner:** Consumer API workstream (api team).
- **Supported scope:** HMAC-SHA256 snapshots published against `TRUSTED_KEYS`.
  Operators replace `TRUSTED_KEYS` with their own published keys; the
  verifier logic is unchanged.
- **Completion evidence:** `api/tests/snapshot-verifier.test.ts` asserts
  acceptance of valid snapshots, determinism (byte-identical repeat results),
  rejection of invalid signatures, tampered payloads, unknown keys,
  unsupported schema versions, missing signatures, and non-integer schema
  versions.

## Rollout and rollback

- **Rollout:** publish `TRUSTED_KEYS` alongside the snapshot endpoint; clients
  pin `SUPPORTED_SCHEMA_VERSIONS` until they re-read the contract.
- **Rollback:** clients that reject new schema versions continue to accept
  version 1; the verifier module is pure computation with no deployment
  surface.
