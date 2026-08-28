# Audit Findings Tracker

Tracks every finding from the Soroban contract audit (and, once complete, the API/aggregator penetration test — see [pentest-scope.md](pentest-scope.md)) through to a merged fix.

A CI check (`scripts/check-audit-findings.js`, wired into `.github/workflows/security.yml`) parses this table and fails the build if any row has `Severity: Critical` and `Status` other than `Resolved`. This blocks mainnet GA on unresolved Critical findings.

## Findings table

| ID | Severity | Finding | Status | Owner | PR |
|----|----------|---------|--------|-------|-----|
| _none yet_ | — | Audit not yet delivered | — | — | — |

**Severity:** Critical / High / Medium / Low / Informational
**Status:** Open / In Progress / Resolved / Won't Fix (requires justification in the row)

## Process

1. When the contract audit report is delivered, add one row per finding with a stable `ID` (e.g. `AUDIT-001`).
2. Every High/Critical finding must have a linked PR and a regression test before it can be marked `Resolved`.
3. Update `Status` and `PR` as work progresses; do not delete rows — closed findings stay in the table for history.
4. The CI check runs on every PR touching this file and on the security scan schedule; a Critical row stuck at `Open`/`In Progress` fails the build.

<!-- markdown-findings-table:start -->
<!-- Machine-readable marker for scripts/check-audit-findings.js — do not remove. -->
<!-- markdown-findings-table:end -->
