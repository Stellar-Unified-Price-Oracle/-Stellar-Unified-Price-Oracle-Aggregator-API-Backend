# Release Gating on SLO Error-Budget Burn Rate (#552)

## 1. Overview and Problem Statement

Reliability objectives (SLOs) and monthly error budgets exist in `monitoring/slo.yml`, `docs/GOLDEN_SIGNALS.md`, and `docs/MONITORING_AND_ALERTING.md`. Previously, however, release automation (`deploy.yml`, `blue-green-deploy.yml`, and `deploy-canary.js`) evaluated only automated unit tests and immediate canary health checks without consulting error budget burn rates.

Releasing changes while a service is actively consuming or exhausting its error budget compounds outages. This document defines the operational policy and implementation that connects error-budget consumption directly to deployment gating.

---

## 2. Burn-Rate Thresholds and Evaluation Windows

Rather than relying on a coarse "budget exhausted" binary flag, the gate enforces multi-window, multi-burn-rate conditions (based on Google SRE best practices).

A 30-day budget has a baseline burn rate of $1.0\times$ (draining 100% of the budget over 30 days).

| Condition | Window | Burn Rate Threshold | 30d Budget Consumed in Window | Gate Severity | Gate Action |
|---|---|---|---|---|---|
| **Fast Burn (Critical)** | 1 hour | $\ge 14.4\times$ | 2.0% in 1 hour | `CRITICAL` | **BLOCK** release immediately |
| **Fast Burn (High)** | 6 hours | $\ge 6.0\times$ | 5.0% in 6 hours | `CRITICAL` | **BLOCK** release immediately |
| **Slow Burn (Warning)** | 24 hours | $\ge 3.0\times$ | 10.0% in 24 hours | `WARNING` | **DEGRADED_PERMIT**: Permit canary only; cap traffic share at $\le 500\text{ bps}$ (5%); require manual promotion |
| **Budget Exhaustion** | 30 days | Remaining budget $\le 0\%$ | 100% consumed | `CRITICAL` | **BLOCK** release; feature freeze enforced |
| **Healthy** | 1h, 6h, 24h | $< 3.0\times$ & budget $> 20\%$ | Normal variance | `OK` | **PERMIT**: Normal deployment and promotion |

### Reasoning
- Fast-burn thresholds ($14.4\times$ over 1h, $6.0\times$ over 6h) identify acute ongoing incidents where shipping new software risks catastrophic cascading failure.
- Slow-burn thresholds ($3.0\times$ over 24h) identify chronic reliability degradation. Outright blocking every minor fluctuation would paralyze delivery, so the gate instead restricts traffic and halts automatic promotion (`DEGRADED_PERMIT`).

---

## 3. Budget Attribution: Canary vs. Canonical Workloads

### 3.1 Attribution Mechanism
When evaluating a release gate for a new release or canary:
- **Baseline / Canonical Traffic:** Errors originating from production traffic running on the canonical implementation (`release != "canary"` or `is_canary = false`).
- **Canary Traffic:** Errors originating from the canary deployment itself (`release = "canary"`, or contract submissions routed to canary via `canary_submissions_total`).

### 3.2 Attribution Policy
1. **Canary Burn Isolation:** Errors caused by the canary implementation are tracked separately. If the canary generates errors, the canary automation aborts and triggers rollback (`scripts/deploy-canary.js rollback`), but it **does not** count against the canonical production error budget for subsequent hotfixes.
2. **Canonical Burn Block:** If canonical production is burning error budget ($> 14.4\times$ or remaining $\le 0\%$), new releases are blocked to avoid destabilizing the environment. Hotfix releases addressing the incident must use the audited override protocol.

### 3.3 Limitations
In distributed HTTP queries where client requests lack version headers at the ingress boundary, attribution relies on Kubernetes pod labels (`app.kubernetes.io/version`) and Prometheus metric labels (`job`, `release`).

---

## 4. Emergency Override Protocol

When a release is required to resolve the very incident causing the error budget burn (a hotfix):
1. **Command Syntax:**
   ```bash
   node scripts/slo-release-gate.js --environment=production \
     --override-reason="HOTFIX: Resolve memory leak in price cache (Incident INC-402)" \
     --override-approver="platform-lead@stellar.org"
   ```
2. **Audit Logging:**
   Every override is logged in structured JSONL format to `logs/slo-gate-overrides.jsonl` and emitted as a GitHub Actions `::warning` notice with the approver, timestamp, reason, and active burn rates.
3. **Visibility:**
   The release gate prints a prominent warning banner and includes the override details in GitHub Step Summary (`$GITHUB_STEP_SUMMARY`).

---

## 5. Behavior When Metrics Are Unavailable

If the Prometheus backend is unreachable, times out, or returns invalid SLI data:
- **Production (`--strict` mode):** Defaults to `FAIL_CLOSED` (blocks release) unless an emergency override (`--allow-metrics-unavailable` with `--override-reason`) is provided.
- **Staging / Dev:** Emits a warning, records an audit entry, and permits the release to prevent developer pipeline deadlocks during observability maintenance.
