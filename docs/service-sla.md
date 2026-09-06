# Service Level Agreement

This SLA defines the minimum service commitments for the Stellar Unified Price Oracle & Aggregator API.

## 1. SLO-aligned commitments

The Service targets the following operational objectives, aligned with the repository's current SLO definitions:

- API availability: 99.9% monthly uptime
- API latency: 99.0% of requests served under 1 second (p95 target)
- Price freshness: 99.5% of tracked assets remain within the configured staleness threshold

These objectives are measured over rolling 30-day windows and are tracked through Prometheus and the project operational dashboards.

## 2. Service credits and remediation

If service performance materially breaches the above targets, the operator will:

- document the incident in the issue queue and operational trace;
- prioritize recovery and mitigations under the incident runbook;
- communicate status updates through the project channel or release notes.

The SLA is an operational target for reliability and response quality, not a guarantee of zero downtime or zero latency variance.

## 3. Maintenance windows

Routine maintenance under the service manager may temporarily reduce availability. Planned maintenance windows should be communicated in advance when feasible. Unplanned outages caused by upstream or network conditions are handled under the incident runbook and the platform's outage response process.

## 4. Customer responsibilities

Consumers are expected to:

- use supported API versions and endpoints;
- keep their API keys secure;
- monitor integrations for stale or degraded responses;
- use the published retry and fallback logic when handling temporary service degradation.

## 5. Related documents

- [Terms of Service](./terms-of-service.md)
- [Acceptable Use Policy](./acceptable-use-policy.md)
- [Runbooks](./runbooks/README.md)
