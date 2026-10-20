# Provider evidence archive (issue #686)

**Owner:** provider ecosystem workstream · **Scope:** aggregator persistence
**Evidence:** `npm test` — `services/aggregator/tests/provider-evidence-archive.test.ts`

`src/persistence/provider-evidence-archive.ts` archives selected raw provider
responses with timestamps and correlation IDs for reproducible incident
analysis. Each adapter records the raw response (after transport, before
parsing — so malformed payloads are captured too).

## Privacy controls

- **Opt-in, off by default:** enable with
  `PROVIDER_EVIDENCE_ARCHIVE_ENABLED=true`.
- Sensitive response fields and URL credentials/query params matching
  `redactKeys` are replaced with `***REDACTED***` before write; the touched
  field paths are recorded in `redactedFields` for audit transparency.
- Store the archive under `./data/provider-evidence` (default) or set
  `PROVIDER_EVIDENCE_ARCHIVE_DIR` to a private volume.

## Retention controls

- `PROVIDER_EVIDENCE_ARCHIVE_MAX_ENTRIES` (default 10000) caps the archive —
  oldest `archivedAt` first.
- `PROVIDER_EVIDENCE_ARCHIVE_RETENTION_DAYS` (default 30) expires records past
  `ttlExpiresAt`; `prune()` removes them on every write and on demand.

## Monitoring / operations

- Each file is one self-contained JSON record
  (`{archivedAt}-{correlationId}-{source}-{asset}.json`) — pull a single file
  for an incident, never the whole archive.
- Alert on write failures (`[ProviderEvidenceArchive]` error lines) and on
  prune counts in high-volume environments.

## Rollout / rollback

- **Rollout:** merge (archive is disabled by default — zero impact), then enable
  per environment with the three env vars and confirm redaction with a
  `--check-config`-style spot check of one written file.
- **Rollback:** set `PROVIDER_EVIDENCE_ARCHIVE_ENABLED=false` (or unset) to
  stop writes immediately; delete the archive directory to purge retained
  evidence. Reverting the code is safe — adapters call `record()` which is a
  no-op when disabled.
