# SDK Runtime Compatibility Matrix

**Owner:** Developer ecosystem and integration. **Source of truth:** [`runtime-compatibility-matrix.json`](./runtime-compatibility-matrix.json) (this page is a human view of it). **Review cadence:** quarterly.

## Supported scope

Official SDKs for the oracle REST/WebSocket API and Soroban consumer calls. Only runtimes still receiving upstream security fixes are listed as supported.

| SDK | Runtime | Version | Status | Last tested | Support ends |
|---|---|---|---|---|---|
| `@stellar-oracle/sdk` (TypeScript) | Node.js | 18 | deprecated | 2026-10-20 | 2026-12-31 |
| | Node.js | 20 | supported | 2026-10-20 | 2027-04-30 |
| | Node.js | 22 | supported | 2026-10-20 | 2028-04-30 |
| | Node.js | 24 | supported | 2026-10-20 | 2029-04-30 |
| | Bun | 1.x | best-effort | - | - |
| | Browser | evergreen | supported | 2026-10-20 | - |
| `stellar-oracle-sdk` (Python) | CPython | 3.9 | deprecated | 2026-10-20 | 2026-10-31 |
| | CPython | 3.11 | supported | 2026-10-20 | 2027-10-31 |
| | CPython | 3.12 | supported | 2026-10-20 | 2028-10-31 |
| | CPython | 3.13 | supported | 2026-10-20 | 2029-10-31 |

Server compatibility: `>=1.0.0 <2.0.0`, schema version `1`, contract ABI `1`.

## Status meanings

- **supported:** run in CI on every SDK release candidate; bugs fixed.
- **deprecated:** still tested, security fixes only; removed in the next minor after `supportEnds`.
- **best-effort:** not in CI; issues triaged but not guaranteed.
- **unsupported:** known not to work.

## Support windows

A runtime stays supported until its upstream end-of-life date or 12 months after a newer LTS ships, whichever is later; removal needs a minor-version release note at least 60 days ahead.

## Measurement procedure

1. CI matrix runs the SDK unit and API-contract suites on each supported runtime (normal path), plus the oldest and newest (boundary) and one deliberately unsupported runtime that must fail fast with a clear error (failure case).
2. After the run, update `tested` for each passing row in the JSON.
3. Run `node scripts/check-sdk-runtime-matrix.mjs`. It fails on malformed rows, supported rows missing a test date, support windows that have already ended, duplicates, and a matrix not reviewed in 120 days.

## Upgrade guidance

- Move to the newest supported runtime first, then upgrade the SDK within its `1.x` line.
- A deprecated runtime will keep working until `supportEnds`; plan the runtime upgrade before then.
- Upgrade runtime and SDK in separate deploys so a regression is attributable.

## Operations

- **Monitoring:** the check script runs in scheduled CI; a failure opens a maintenance task for the owner.
- **Rollout:** merge matrix changes together with the CI matrix change; announce runtime removals in release notes.
- **Rollback:** revert the matrix commit; no runtime or API behaviour changes.

## Note for maintainers: `sdk/compat.json`

The release compatibility gate reads an optional `sdk/compat.json` with `supportedServer`, `schemaVersions` and `contractAbi`. The top-level keys of the JSON in this directory are compatible; copy those three keys into `sdk/compat.json` once the `sdk/` directory exists.
