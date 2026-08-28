# Secret Rotation & Emergency Revocation

Goal: every secret in this system can be rotated with zero downtime, and
revoked immediately if it is compromised.

## Rotating a secret

Use `scripts/rotate-secrets.sh <category>` (add `--dry-run` to preview
without making changes):

| Category | Command | Covers |
|---|---|---|
| Encryption key | `scripts/rotate-secrets.sh encryption-key` | `ENCRYPTION_KEY` |
| API keys | `scripts/rotate-secrets.sh api-keys` | Admin/API keys via `/admin/keys/:hash/rotate` |
| WS secrets | `scripts/rotate-secrets.sh ws-secrets` | WS HMAC + CSRF secrets |
| DB credentials | `scripts/rotate-secrets.sh db-credentials` | Database username/password |
| Signer key | `scripts/rotate-secrets.sh signer-key` | Soroban contract signer keypair |
| Everything | `scripts/rotate-secrets.sh all` | All of the above, in order |

Each category rotates without downtime because the previous credential stays
valid until the new one is confirmed in place (e.g. `ENCRYPTION_KEY_PREVIOUS`
keeps decrypting old values; the old signer key is only revoked after the new
one is authorized on-chain).

## Quarterly drill

`.github/workflows/secret-rotation-drill.yml` runs a dry-run of every
rotation category on the 1st of January, April, July, and October (and can be
triggered manually via `workflow_dispatch`). Results are uploaded as a
`secret-rotation-drill-<run-id>` artifact and kept for 400 days so drill
history is auditable. Review each run's summary and confirm no category's
procedure has drifted from what's documented here.

## Emergency kill-switch

If a secret is suspected compromised, revoke it immediately — don't wait for
a scheduled rotation:

1. **API/admin key** — `POST /admin/keys/:keyHash/revoke` takes effect
   immediately (see `api/src/governance/admin.ts`); the key manager marks it
   revoked and every subsequent request with that key is rejected.
2. **Encryption key** — generate a new key, deploy it as `ENCRYPTION_KEY`
   immediately, and do not carry the compromised key forward as
   `ENCRYPTION_KEY_PREVIOUS`; re-encrypt any secrets it protected as a
   priority.
3. **WS HMAC/CSRF secret** — rotate via `scripts/rotate-secrets.sh
   ws-secrets` and roll the deployment; existing sessions using the old
   secret are invalidated as soon as the new value is live.
4. **DB credentials** — revoke the compromised DB user at the provider
   immediately (don't wait for the new one to be created), then run
   `scripts/rotate-secrets.sh db-credentials`.
5. **Signer key** — revoke the compromised signer as a contract admin signer
   on-chain immediately; only authorize a replacement once the compromise is
   contained.

**SLA:** revocation for any category must complete within **1 hour** of
confirming compromise. Record the incident in a post-mortem using
`docs/runbooks/post-mortem-template.md`.
