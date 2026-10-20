# Verifying deletion across derived consumer data

Owner: privacy/compliance maintainers (owners of `api/src/governance/compliance.ts` and `dsar-store.ts`). Tooling: `scripts/verify-consumer-deletion.mjs`.

## Trace of where consumer data can live

The erasure flow records a DSAR (`dsar-store.ts`) and, on fulfilment, a certificate listing the stores in `retentionPolicies` (see `compliance.ts`). Deletion must be verified across these classes of location:

| Class | Examples to list in the manifest | Expected end state |
| --- | --- | --- |
| primary | API key store, DSAR store, usage records | Subject identifiers removed, or retained only as a documented legal record |
| cache | Redis L2 / in-process LRU entries keyed by key or subject | Absent after TTL or explicit invalidation |
| export | Usage exports, reports, audit extracts | Absent, or covered by a documented exception |
| replica | Read replicas, standby regions | Absent after replication lag |
| backup | Database and file backups | Residue allowed only as a bounded exception (see below) |

The audit log is append-only and HMAC-chained; rewriting it would break integrity. Treat it as a documented exception that must carry a retention bound (`docs/audit-log-retention.md`). This document does not state the actual retention values; read them from the configured policies.

## Procedure

1. Write a manifest (see header of the script) listing every location above for the environment, with `kind`, `paths`, and for exceptions an `exception` reason and `boundedDays`.
2. After fulfilment, run `node scripts/verify-consumer-deletion.mjs --subject <id> --manifest <manifest.json>`.
3. Exit 0 means every store is clean or has a bounded, documented exception. Exit 1 means residue in a store without an exception; open an incident against the store owner. Exit 2 is an input error.
4. Attach the output (it prints only a hash prefix of the subject, not the id) to the DSAR record.

The scanner matches the raw subject id, its SHA-256, and a 16-hex prefix of that hash, over file contents. It cannot inspect live database rows or Redis directly: export or dump those to files and list the dump paths in the manifest.

## Bounded completion

A deletion request is complete when: primary, cache, export and replica stores are clean, and backups either are clean or have an exception with `boundedDays` after which they age out. The bound is a property of the backup schedule, which is unspecified in this repository snapshot and must be filled in by the operator.

## Compatibility, monitoring, rollout, rollback

- The script is read-only and standalone; no service change.
- Run after each erasure fulfilment and on a periodic sample; alert on exit 1.
- Rollback: delete the script and this document.
