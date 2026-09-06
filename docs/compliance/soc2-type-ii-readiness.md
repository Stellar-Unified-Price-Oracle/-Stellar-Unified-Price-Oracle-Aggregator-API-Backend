# SOC 2 Type II readiness and control mapping

This document maps the current oracle service controls to the relevant SOC 2 trust criteria and calls out the near-term gaps we should treat as tracked work items.

## Current control map

| Trust criteria | Current control | Status | Evidence |
| --- | --- | --- | --- |
| CC1.1 | Governance and risk oversight | Partial | repository governance, ADRs, change pipeline |
| CC2.1 | Control environment | Partial | CI workflow, review process, deployment docs |
| CC6.1 | Logical access | Partial | API key manager, RBAC, least-privilege reviews |
| CC6.6 | Transmission security | Partial | TLS enforcement, HSTS headers, secure secret handling |
| CC7.2 | Monitoring | Implemented | Prometheus metrics, uptime tracking, structured logs |
| CC7.4 | Incident response | Partial | runbooks and alerting, but response playbooks need sign-off |
| CC8.1 | Change management | Partial | CI and versioned deployment assets |
| A1.2 | Capacity management | Partial | metrics and scaling docs |
| A1.3 | Backup and recovery | Partial | encrypted backup service and restore procedures |

## Evidence automation

The API already records compliance audit events and writes them to a tamper-linked JSONL log. We should continue to expose this through the compliance reporting endpoints and export them into the evidence repository with a fixed retention window.

Required follow-up actions:
- keep the audit trail append-only and hash-linked
- retain backup evidence and restore-test output
- merge access review and key rotation records into the same evidence feed
- automate quarterly reporting into the security evidence bucket

## Gaps to track

- finalise a formal incident response playbook with escalation ownership
- confirm backup restore testing cadence and evidence retention
- complete formal access review approvals for production roles
- document a production change approval gate and emergency rollback evidence

This is the current posture only; the control set should be treated as the minimum evidence baseline for a SOC 2 Type II audit readiness review.
