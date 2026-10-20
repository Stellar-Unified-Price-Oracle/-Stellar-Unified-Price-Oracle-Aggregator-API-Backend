# Recurring security control evidence

Owner: security maintainers (issue #759). Selected controls are defined in
`scripts/security-evidence/controls.json`; the initial set is deliberately small and
repository-verifiable (policy file present, lockfiles committed, audit-logger module present with history).
Owners are listed as unspecified and must be assigned by maintainers.

## What each evidence file contains

- `provenance`: generation time, generator path, git commit, SHA-256 of the controls definition.
- `collectionPeriod`: `start` / `end` supplied by the operator (or the last 3 months in the scheduled run).
- `controls[]`: per-control status (`pass`, `fail`, `excepted`) with per-check detail and file hashes.
- exceptions: supplied via `--exceptions file.json` as `[{ "controlId", "reason", "approvedBy" }]`; a failing control with an exception is `excepted`.
- `signOff`: left empty by the collector. A human reviewer fills `reviewer`, `reviewedAt`, `decision` (`approved`/`rejected`), `notes`.

## Procedure

1. Run `node scripts/security-evidence/collect.mjs --start 2024-01-01 --end 2024-03-31 --out evidence.json` (dates are examples) or trigger the `Security control evidence` workflow (also scheduled quarterly; artifact `security-control-evidence`).
2. Reviewer inspects results, edits `signOff`, and stores the file in the team's evidence location (location: unspecified, TODO for maintainers).
3. Run `node scripts/security-evidence/collect.mjs --verify evidence.json`; exit 0 means signed off and consistent (approval is refused while unexcepted failures exist).

Exit codes for collection: 0 no unexcepted failures, 1 failures, 2 usage error.

## Tests

`cd scripts/security-evidence && node --test` covers pass/fail/exception, invalid period, path traversal, unknown check types and sign-off validation.

## Compatibility, monitoring, operational impact

Read-only, no dependencies, no secrets read (only existence/hash of repo files). The workflow has `contents: read` only and uploads an artifact; failures are visible as failed workflow runs.
Limitation: checks prove presence/history, not operating effectiveness; add controls to `controls.json` as they become automatable.

## Rollout / rollback

Rollout: merge; optionally run once via workflow_dispatch. Rollback: delete the workflow file, `scripts/security-evidence/`, and this doc.
