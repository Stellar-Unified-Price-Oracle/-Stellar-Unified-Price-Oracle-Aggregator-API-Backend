# Public integration support expectations

**Owner:** Integrations triage rotation (CODEOWNERS); escalation to the on-call engineer for Sev1.
**Scope:** questions and defects reported by external integrators of the API, SDKs, and contracts.
**Status:** Adopted

## How to ask for help
Open an issue with the **Integration support** template (`.github/ISSUE_TEMPLATE/integration-support.md`). Security vulnerabilities must not use public issues: follow `SECURITY.md`.

## Never include secrets
Do not post API keys, private keys, seed phrases, JWTs, or full authorization headers. Redact them (`sk_...REDACTED`). Maintainers will never ask for secrets; if asked, do not comply and report it. Key ID or the last 4 characters are enough.

## Required diagnostic data
- Environment (sandbox/production), region, and approximate UTC time window.
- SDK name and version, or raw HTTP client.
- API version and endpoint or WebSocket channel.
- Request ID (`x-request-id`) from the failing response, status code, and error body.
- Asset/feed identifier and the expected versus actual value.
- Minimal reproduction and what you already tried.
- For contract consumers: network, contract ID, and ledger sequence.

## Response expectations (business days, best effort)
| Severity | Definition | First response | Target update cadence |
| --- | --- | --- | --- |
| Sev1 | Production outage or incorrect prices affecting funds | 1 hour | every 2 hours |
| Sev2 | Degraded production or blocked go-live | 1 business day | every 2 business days |
| Sev3 | Questions, minor defects, sandbox issues | 3 business days | weekly |
| Docs/feature | Requests and suggestions | 5 business days | on triage |

These are targets, not contractual SLAs. Issues missing the required data get a `needs-info` label and one request; they close after 14 days without reply.

## Triage ownership
1. Rotation member applies a severity label and `needs-info` if needed within the first-response window.
2. Sev1 is paged to on-call (`docs/runbooks`); others are assigned to the owning component maintainer.
3. Resolution comment links the fix, release, or doc; reporter confirms.

## Operations and rollback
Process and template only; no runtime changes. To roll back, delete the template and revert this document. Review response-time performance quarterly using issue timestamps.
