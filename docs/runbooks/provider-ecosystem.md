# Provider ecosystem operations

**Accountable owner:** Provider Integrations owner (the engineer assigned in the on-call rotation). The owner maintains provider contacts, adapter contracts, feed mappings, objectives, and the change register. The Aggregator on-call engineer owns incident response and may disable a provider immediately; the integration owner reviews the change on the next business day.

## Upstream change intake and review (#687)

Review upstream provider release notes, API status/deprecation notices, and SDK advisories weekly. Record every breaking or dated change in `docs/provider-changes.yml` before changing an adapter. The record must include provider, notice URL, date discovered, effective/deprecation date, affected feeds, adapter/configuration, owner, compatibility decision, evidence link, and status (`monitoring`, `scheduled`, `mitigated`, or `closed`). Unknown affected feeds block activation until the owner maps the provider's capability profile to configured feeds.

The integration owner opens or updates an issue for a notice that requires code or operator action, adds a regression fixture for payload/schema changes, and records the review outcome. The repeatable completion check is: every active provider has a reviewed entry in the last 7 days; every future deprecation has a named mitigation and due date; and every affected feed appears in the provider capability profile. Review the register in the weekly provider on-call handoff. A missing review or overdue mitigation is a release blocker.

## Provider delivery objectives (#688)

These objectives are per provider and feed, over rolling 30-day windows, and are independent of aggregate API or price SLOs:

| Measure | Objective | Metric / measurement |
|---|---:|---|
| Usable availability | At least 99.5% of attempted fetches return a validated price | `oracle_provider_fetches_total`; `no_price` and `error` are bad outcomes |
| Latency | At least 99% of successful fetches complete within 1 second | `oracle_source_request_duration_seconds_bucket` |
| Freshness | At least 99% of returned observations are no older than provider cadence + 5 seconds | `oracle_source_freshness_seconds`; compare against `provider_cadence_seconds` inventory |
| Errors | At most 0.5% of attempted fetches end in transport or payload error | `oracle_provider_fetches_total{outcome=~"error|invalid_payload"}` |

Example PromQL for availability over 30 days:

```promql
sum by (source, asset) (increase(oracle_provider_fetches_total{outcome="available"}[30d]))
/ clamp_min(sum by (source, asset) (increase(oracle_provider_fetches_total[30d])), 1)
```

Error ratio is the corresponding `outcome="error"` increase divided by all outcomes. Latency compliance is the `le="1"` bucket increase divided by the `_count` increase. Freshness compliance is measured from the freshness gauge with a recording rule using each provider's declared cadence; do not combine providers into one aggregate. Windows with fewer than 100 attempts are reported as insufficient evidence, not as a pass. Check outcomes weekly and retain the query output or dashboard snapshot with the monthly provider review.

## Feed concentration policy (#689)

The aggregator treats capability `dependencyGroup` as the unit of independent exposure. The current adapters declare one group each; deployments must change that mapping when providers share an upstream, operator, or data dependency. For each feed, the service exports the count of contributing groups and HHI (`sum(share²)`, from 0 to 1). Policy requires at least 2 independent groups, maximum group share 0.75, and HHI at most 0.60. Any failed condition increments `oracle_feed_concentration_alerts_total` and raises the `OracleFeedProviderConcentrationHigh` Prometheus alert. This is an actionable signal to restore an independent source or formally accept the risk in the feed decision record. A single source is therefore always flagged.

## Shadow reads and activation (#690)

Set `SHADOW_PROVIDER_SOURCES` to a comma-separated list of registered adapter names. A listed adapter is polled normally, but its observations are excluded from price aggregation, history, and publication. Each observation is compared to the active providers' median after decimal normalization. `/metrics` exposes `oracle_shadow_observations_total` and `oracle_shadow_deviation_percent`; no active reference and invalid comparisons are separate outcomes. Start with one staging feed and at least 7 days of observations. Activation requires at least 1,000 valid comparisons, 99% of observations within the tolerance recorded in the feed decision record (5% by default), no unresolved schema/availability issue, and a reviewed capability/dependency mapping. Add a new adapter to the adapter registry and `pollSources`; the shadow setting keeps it non-contributing during evaluation.

To roll back, remove the source name from `SHADOW_PROVIDER_SOURCES` to resume its already-reviewed active behavior, or remove the adapter from `pollSources` to stop calls completely. Configuration changes require a normal deployment/restart. Shadow traffic consumes provider quota and cost, so watch the existing budget metrics and use the provider's sandbox endpoint where available. Never enable a shadow source whose credentials or endpoint are not approved for the deployment environment.

## Monitoring and owner handoff

Scrape the aggregator `/metrics` endpoint on port 4002. Alert on concentration counter increases and on provider availability, latency, freshness, or error objectives breaching over the 30-day window. During an incident, the Aggregator on-call engineer may remove a provider from aggregation or place it in shadow mode; preserve the provider-change register entry and affected-feed mapping, then notify the Provider Integrations owner in the handoff. Rollback is removal of the relevant shadow/configuration change and redeployment; no persisted price format or consumer API changes are involved.
