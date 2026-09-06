# Audit log retention and tamper evidence

This policy defines how operational audit logs are retained and verified.

## Retention policy

The API enforces a configurable retention window for audit logs. The default operational policy is 90 days; the compliance dashboard keeps a longer archive window for supporting evidence and subject-access workflows.

For the production compliance configuration, the system uses the following default retention logic:

- audit logs: 90 days in active storage
- archive retention: 3 years for governance and incident evidence
- debug and raw payload logs: 90 days, then deletion

The actual retention implementation lives in `api/src/governance/audit-logger.ts` and is enforced on every new audit entry.

## Tamper-evident chain

Each audit entry includes a SHA-256 HMAC computed over the payload and the previous entry's hash. This produces a chained record that can be checked in order to detect tampering or log truncation.

The project also exposes a verification routine in `verifyAuditLogChain()` so operators can validate the integrity of exported logs before handing them to auditors or incident responders.

## Verification workflow

1. Export a complete log file or journal slice.
2. Recompute the HMAC chain in order.
3. Compare each computed hash against the stored `hmac` value.
4. Treat the first mismatch as a tamper indicator and quarantine the file for forensic review.

This workflow can be used to satisfy audit and incident-review requirements without introducing a new operational dependency on an external attestation service.
