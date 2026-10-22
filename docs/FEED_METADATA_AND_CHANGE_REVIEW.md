# Feed freshness, quote units, and pre-release review

The catalog policy in `api/src/governance/catalog-policy.ts` owns each feed's
named freshness profile, warning boundary, stale boundary, source quorum, and
quote unit. The shared defaults and feed-to-profile assignments live in
`packages/types/src/feed-metadata.ts`; aggregator staleness checks, API
health/degradation responses, and v2 price freshness use those shared defaults.
Policy values are bounded at proposal validation: warning age must be positive
and below the stale age, stale age remains within the existing 10–3600 second
guardrail, storage scale is 0–18 decimals, display scale is at most 12 and no
greater than storage scale, and quote denomination must match a supported
currency (USD, EUR, GBP, JPY, CHF, CAD, AUD) per asset unit.

Feed owners propose policy changes through the governed catalog proposal API.
Before review, `POST /api/v1/governance/catalog/proposals/:id/impact` records a
deterministic report with affected catalog consumers, source quorum before and
after, API compatibility effects, cost and safety margins, and a rollback target
with operational steps. Quote currency, denomination, and storage-scale changes
are breaking and move the proposal into the high-impact review lane. Display
rounding changes are behavioral. Historical entries retain the scale at which
they were written.

Completion evidence is the catalog governance test suite, including boundary
rejection for freshness and quote settings and a preview assertion for consumer
exposure, quorum, API compatibility, and rollback. After activation, operators
should compare the active catalog version with the aggregator and API release,
then review quorum and stale-price monitoring. Roll back by proposing the
recorded prior catalog version through the same approval and timelock process;
after activation, clear price caches and verify freshness/quorum coverage.
