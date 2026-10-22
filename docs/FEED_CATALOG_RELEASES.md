# Signed Feed-Catalog Releases

Issues: #670. Pipeline: `scripts/feed-catalog-release.mjs`; library:
`scripts/lib/feed-catalog-release.mjs`; input `config/feed-catalog.json`;
artifacts `releases/feed-catalog/v<N>.json`.

## Pipeline

1. **Validate.** Parse `config/feed-catalog.json` and run the catalog
   invariants: schema major 2, known network, unique kebab-case `feedId`, base
   and quote units, precision 0–18, 1–16 unique eligible sources, freshness
   window (`maxStalenessSeconds >= heartbeatSeconds`), ownership, and lifecycle
   with a successor for deprecated/retired feeds. Invalid input exits non-zero
   and nothing is signed.
2. **Version.** Read the existing artifacts, take the highest version, and
   allocate `version + 1`. Releases are immutable: an existing `v<N>.json` is
   never overwritten, the first release is `v1`, and every later release records
   the previous catalog hash.
3. **Sign.** Serialize `payload` canonically (sorted keys), hash it with SHA-256,
   and sign the digest with Ed25519. The artifact stores the signature, digest,
   key id, algorithm, public key, builder identity, and signature scope.
4. **Verify.** Recompute the catalog hash, re-verify the signature, check the
   version is sequential, the previous hash matches, and `publishedAt` increases.
5. **Publish/expose.** Write `releases/feed-catalog/v<N>.json` (mode 0644,
   exclusive create). Provenance is available with `--provenance`, in the
   artifact itself, and to any consumer that reads the immutable file.

## Commands

```bash
# Validate the catalog and every existing release (no key required)
npm run catalog:release -- --check

# Sign and write the next immutable release
FEED_CATALOG_SIGNING_KEY=/run/secrets/feed-catalog-signing-key.pem \
  npm run catalog:release -- --publish --key-id feed-catalog-prod-2026 --channel production

# Verify the chain, optionally pinning the expected public key
npm run catalog:release -- --verify --public-key ./feed-catalog-signing-key.pub --channel production

# Print the latest provenance record
npm run catalog:release -- --provenance
```

`--catalog` and `--releases-dir` override the default paths. `--channel` is
`sandbox`, `staging`, or `production`.

## Artifact

```json
{
  "schemaVersion": 1,
  "payload": {
    "schemaVersion": 1,
    "version": 4,
    "channel": "production",
    "publishedAt": "2026-10-20T00:00:00.000Z",
    "catalogHash": "<sha256 of canonical catalog>",
    "previousCatalogHash": "<sha256 of v3 catalog>",
    "catalog": { "schemaVersion": 2, "network": "stellar:pubnet", "feeds": [] }
  },
  "provenance": {
    "generator": "scripts/feed-catalog-release.mjs",
    "builder": "org/repo:<commit>:<run-id>:<actor>",
    "keyId": "feed-catalog-prod-2026",
    "algorithm": "ed25519",
    "publicKey": "-----BEGIN PUBLIC KEY-----...",
    "digest": "<sha256 of canonical payload>",
    "signature": "<base64 signature over digest>",
    "signatureScope": "sha256(canonical-json(payload))"
  }
}
```

## Key handling

- The private key is never committed. `FEED_CATALOG_SIGNING_KEY` may contain a
  PEM or a path to a mounted file; `--key` is the explicit form.
- Production uses a KMS-backed or HSM-backed Ed25519 key held by the release
  manager; the public key is pinned in `--verify` and published with the
  artifact.
- Rotate by publishing a new key id. Existing artifacts keep verifying with the
  embedded public key; pinning accepts the old or new key during the overlap.

## Monitoring and ownership

- Owner: release manager (publication, key custody), catalog owner (content),
  security reviewer (key rotation). See [Catalog Governance](./CATALOG_GOVERNANCE.md).
- Alert when `catalog:release -- --check` fails in CI, when a verify run reports
  a chain or signature error, or when the latest release is older than the
  catalog change window.
- Provenance is the audit record: the artifact names the commit/run that built
  it and the key that signed it. Keep releases in version control or an
  immutable artifact store with write-once retention.

## Rollout and rollback

**Rollout.** Run `--check` on the PR, merge, then publish from the protected
release job with the production key. Consumers read the new artifact by version;
old versions remain available.

**Rollback.** Publish a new release that restores the previous catalog content
(forward-only history) or point consumers at the previous immutable version.
Never delete or edit a signed artifact; a rollback release is a new version with
its own provenance.

Tests: `node --test scripts/tests/feed-catalog-release.test.mjs` covers valid
sign/verify, tampered catalogs, wrong keys, chain continuity, immutability, and
invalid-catalog rejection.
