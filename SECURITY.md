# Security Policy & Bug Bounty Program

We welcome reports from external security researchers. This document defines
scope, how to report, and what to expect in return.

## Scope

In scope:

- `api/` — REST + WebSocket gateway, authentication, rate limiting,
  governance/multi-sig routes.
- `services/aggregator/` — price aggregation, oracle-source ingestion,
  outbound request handling (SSRF surface).
- `services/vault_manager/` — Stellar vault/treasury management.
- Deployed Soroban contracts (oracle, governance, multi-sig, proxy) at their
  published mainnet/testnet addresses (see `DEPLOY.md`).
- Infrastructure-as-code in this repository (CI/CD workflows, deploy scripts)
  where a finding demonstrates a concrete exploit path.

Out of scope:

- Denial-of-service via brute-force volume (rate-limit bypass logic itself is
  in scope; simply flooding an endpoint is not).
- Findings that require physical access to a maintainer's device or social
  engineering of maintainers/users.
- Third-party services we depend on but don't operate (e.g. upstream oracle
  data providers, cloud provider infrastructure) — report those upstream.
- Issues already tracked in open GitHub issues or previously reported.

## Safe harbor

We will not pursue legal action against, or refer to law enforcement,
researchers who:

- Make a good-faith effort to avoid privacy violations, data destruction, and
  service disruption during testing.
- Only interact with accounts, data, and contract state they own or are
  explicitly authorized to test (use testnet for any exploratory testing that
  could affect on-chain state).
- Report findings promptly through the channel below and give us reasonable
  time to remediate before any public disclosure.

Testing that stays within this policy is authorized; we consider it
compliant with the Computer Fraud and Abuse Act (and equivalent regional
laws) and exempt from DMCA anti-circumvention claims where applicable.

## Reporting a vulnerability

Email **security@stellar-unified-oracle.example** with:

- Affected component/contract address and a description of the issue.
- Steps to reproduce (proof-of-concept preferred; testnet transaction hash if
  applicable).
- Impact assessment (what an attacker gains).

Do not open a public GitHub issue for a security vulnerability. Reports are
triaged within 3 business days; you'll receive an acknowledgment and a
tracking reference.

> Replace the intake address above with the team's managed triage inbox or
> bounty-platform-provided address before this policy goes live.

## Severity and reward tiers

| Severity | Example | Reward range |
|---|---|---|
| Critical | Admin key compromise, unauthorized fund movement from a vault, arbitrary contract admin takeover | $5,000 – $25,000+ |
| High | Price manipulation bypassing deviation/reputation checks, auth bypass on admin-gated API routes | $1,000 – $5,000 |
| Medium | SSRF/allowlist bypass, rate-limit bypass with material impact, sensitive data exposure | $250 – $1,000 |
| Low | Best-practice gaps, non-exploitable information disclosure | $50 – $250 |

Final severity and reward are determined by the security team based on
actual impact and exploitability; the table above is a starting guide, not a
guarantee.

## Published Response Targets (SLA & SLO)

We commit to the following response targets for valid vulnerability disclosures:

| Severity | Initial Acknowledgment | Triage & Confirmation | Remediation Target |
|---|---|---|---|
| **Critical** | **≤ 24 hours** | **≤ 48 hours** | **≤ 72 hours** (hotfix) / **7 days** (permanent patch) |
| **High** | **≤ 48 hours** | **≤ 5 business days** | **≤ 14 calendar days** |
| **Medium** | **≤ 72 hours** (3 business days) | **≤ 10 business days** | **≤ 30 calendar days** |
| **Low** | **≤ 72 hours** (3 business days) | **≤ 10 business days** | **≤ 60 calendar days** |

- **Coordinated public disclosure:** 90 calendar days after the report is confirmed, or sooner by mutual agreement once a fix is verified and deployed.
- **Full Policy & Procedures:** For comprehensive details on intake, PGP encryption, remediation verification, and publication rules, see [`docs/security/vulnerability-disclosure-policy.md`](docs/security/vulnerability-disclosure-policy.md).
- **RFC 9116 Metadata:** Published at [`/.well-known/security.txt`](.well-known/security.txt) and via API at `/api/v1/security/disclosure-policy`.

## Reproducible builds

Release artifacts must be independently reproducible from their tagged
source revision so that anyone can verify a published artifact was built
from the source it claims. This section defines the procedure, how to
investigate a mismatch, and the operational guidance for rolling the
capability out (and back out) safely.

**Owner:** Release engineering (primary), security team (verification
review). **Scope:** all release artifacts published from this repository
(container images, contract WASM, and packaged binaries) for tagged
revisions.

### Verifying a release artifact against its source revision

1. Check out the exact tagged revision the artifact claims to be built from:
   `git fetch --tags && git checkout <tag>` and confirm
   `git rev-parse HEAD` matches the revision recorded in the release notes
   and the artifact's build metadata.
2. Build in a clean, pinned environment using the documented toolchain
   (pinned compiler/container base image digests, locked dependency files,
   and `SOURCE_DATE_EPOCH` set to the tag's commit timestamp). Do not build
   from a dirty working tree.
3. Build twice from the same revision and confirm the two outputs are
   byte-identical (compare SHA-256 digests). A non-deterministic local build
   is a build-environment problem, not an artifact mismatch — fix the
   environment before comparing against the published artifact.
4. Compare the locally produced digest(s) against the published artifact
   digest(s) recorded in the release notes and the registry/attestation
   metadata. A match is the completion evidence for that release.
5. Record the result (revision, toolchain digests, local digest, published
   digest, pass/fail) in the release verification log so the check is
   repeatable and auditable.

### Investigating a mismatch

If the local digest does not match the published artifact:

1. **Do not** publish, promote, or deploy the artifact further; treat it as
   untrusted until resolved.
2. Re-run the verification from a fresh checkout and a clean build
   environment to rule out local toolchain drift, cached layers, or an
   unpinned dependency.
3. Diff the build inputs: toolchain/base-image digests, lockfiles, build
   flags, and `SOURCE_DATE_EPOCH`. Any difference explains the mismatch and
   must be reconciled against the documented build recipe.
4. If inputs are identical and the digest still differs, escalate to the
   security team as a potential supply-chain incident: preserve build logs
   and artifacts, identify who/what produced the published artifact, and
   follow the disclosure SLA above for any external communication.
5. Document the root cause and the corrective action (recipe fix, rebuild,
   re-release, or revocation) in the release verification log before the
   artifact is re-trusted.

### Monitoring and operational impact

- CI runs the reproducibility check on every release build and fails the
  release job on a digest mismatch; results are attached to the release.
- Verification results are logged and reviewed by release engineering;
  repeated or unexplained mismatches are surfaced to the security team.
- Consumers relying on published digests should pin to the verified digest;
  a re-release with a corrected artifact will publish a new digest and a
  note in the release notes.

### Rollout and rollback

- **Rollout:** enable the reproducibility check in report-only mode first
  (record results without blocking), confirm the build recipe is
  deterministic across two clean builds, then make the check blocking for
  release jobs.
- **Rollback:** if the check blocks releases due to environment
  non-determinism, revert the release job to report-only mode, keep logging
  results, and fix the build recipe before re-enabling blocking mode. Do not
  bypass the check by publishing unverified artifacts.

## Bounty platform

This program is intake-managed via the email above pending integration with
a managed bounty platform (e.g. Immunefi, HackerOne). Once integrated, this
document will be updated with the platform link and this section will note
the migration.

## Resilience and assurance controls

The controls below are owned by the security and platform teams and are
exercised in CI. Each entry lists the owner, supported scope, measurable
completion evidence, monitoring, compatibility, and rollout/rollback
guidance. Scripts live under `scripts/` and CI jobs under
`.github/workflows/`.

### Controlled brownout mode (#741)

- **Owner:** Platform on-call (primary), Security (secondary).
- **Scope:** Partial-service mode that sheds non-critical work (background
  jobs, non-essential exports, cache warming) while preserving explicit
  price-freshness and publication guarantees. Applies to `api/` and
  `services/aggregator/`; does not alter on-chain contract behavior.
- **Completion evidence:** Brownout state transitions are covered by
  automated tests (`scripts/test_brownout.*`) exercising normal, boundary
  (freshness threshold edge), and failure (shed path under load) cases; CI
  job `brownout` must pass before merge.
- **Monitoring:** Brownout activation/deactivation events, shed-work
  counters, and price-freshness gauges are emitted; alerts fire if freshness
  guarantees are violated while brownout is active.
- **Compatibility:** Brownout is opt-in via configuration and defaults off;
  API response shapes are unchanged, only non-critical work is deferred.
- **Rollout/rollback:** Enable per-region behind a flag, observe freshness
  and shed counters, then widen. Roll back by disabling the flag; deferred
  work resumes on the next scheduling cycle.

### Regional maintenance windows (#742)

- **Owner:** Platform on-call.
- **Scope:** Guarded workflow for planned regional maintenance with
  prechecks, traffic drain, publisher fencing, and post-maintenance
  validation. Applies to regional cells of `api/` and
  `services/aggregator/`.
- **Completion evidence:** The workflow script (`scripts/maintenance_window.*`)
  is tested for normal, boundary (drain timeout), and failure (precheck
  abort, fencing failure) cases; CI job `maintenance-window` must pass.
- **Monitoring:** Precheck results, drain progress, fencing state, and
  post-maintenance validation outcomes are logged and alerted on failure.
- **Compatibility:** Maintenance is region-scoped; other regions continue
  serving. Publisher fencing prevents split-brain publication during the
  window.
- **Rollout/rollback:** Run prechecks in dry-run first, then execute the
  window. Abort/rollback re-enables traffic and releases fencing; a failed
  post-check blocks re-enable until resolved.

### Tenant-isolation fuzzing (#747)

- **Owner:** Security.
- **Scope:** Adversarial tests for tenant separation across caches, REST,
  GraphQL, WebSockets, exports, and background jobs.
- **Completion evidence:** Fuzz harness (`scripts/fuzz_tenant_isolation.*`)
  runs in CI job `tenant-isolation-fuzz` with a fixed seed corpus plus
  randomized iterations; any cross-tenant leak fails the job.
- **Monitoring:** Failures surface as CI alerts; production cross-tenant
  access attempts are logged and alerted.
- **Compatibility:** Test-only; no runtime behavior change.
- **Rollout/rollback:** Corpus and seeds are versioned; revert the harness
  change to roll back. New data paths must add fuzz coverage before merge.

### Authorization regression corpus (#749)

- **Owner:** Security.
- **Scope:** Versioned matrix of allowed and denied actions across roles,
  scopes, lifecycle states, and API versions, run in CI.
- **Completion evidence:** Corpus (`scripts/authz_corpus.*`) is executed by
  CI job `authz-regression`; every matrix entry must match expected
  allow/deny outcomes for the job to pass.
- **Monitoring:** CI failures block merge; drift between corpus and
  implementation is reported in the job summary.
- **Compatibility:** Corpus is versioned alongside API versions; entries are
  added for new roles/scopes/versions without removing historical coverage.
- **Rollout/rollback:** Add entries incrementally and review diffs; revert
  the corpus change to roll back. Removing an entry requires security review.
