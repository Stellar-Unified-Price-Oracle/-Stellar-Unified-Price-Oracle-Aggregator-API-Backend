# audit-chain-verifier

Standalone, zero-dependency verifier for the API audit log (`api/src/governance/audit-logger.ts`). It needs only the JSONL log and the plaintext signing secrets, not the service process.

```
node cli.mjs audit.log.jsonl --keys keys.json [--anchors anchors.json] [--export-anchors]
```

- `keys.json`: JSON array of plaintext secrets (the values behind `AUDIT_SECRET` / `AUDIT_SECRET_PREVIOUS`, after any decryption). Key ids are derived as the first 16 hex chars of SHA-256 of the secret, as the service does.
- `anchors.json`: heads (`{writerId, seq, hmac}`) previously exported with `--export-anchors` and stored outside the service (for example a ticket, a signed release note, or write-once storage). They detect tail truncation and wholesale rewrites that an in-file chain alone cannot.
- Exit codes: 0 valid, 1 invalid, 2 input error. Output is JSON with `findings[]` (`bad-hmac`, `broken-link`, `sequence-gap`, `unknown-key`, `unanchored-writer`, `anchor-missing`, `malformed-line`, ...).

Tests: `node --test verify.test.mjs` (uses the Node built-in runner).

## Scope and limits

- Mirrors the per-writer chain rules of `verifyAuditLogChain`: contiguous `seq`, predecessor link, HMAC, and anchoring of each writer's first entry. Cross-replica ordering is not claimed (see `docs/audit-log-retention.md`).
- If the canonical payload in the service changes, `canonicalPayload` in `verify.mjs` must change with it; the field order is the compatibility contract.
- Secrets are sensitive: run on a trusted host and do not commit key files.

## Rollout and rollback

Compatibility: read-only against the log; no change to the service. Operate it on a schedule against log copies, alert on non-zero exit, and record `--export-anchors` output after each run. Rollback: remove this directory; nothing else depends on it.

Owner: API governance maintainers.
