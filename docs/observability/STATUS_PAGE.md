# Public Status Page with Uptime & Incident History (#416)

**Goal:** communicate service status and incident history transparently.

Downstream DeFi protocols integrate the oracle into on-chain and off-chain
systems. When they see stale prices or failed requests they need a **canonical,
first-party source** to tell them whether it is the oracle or their own
integration — not a scramble through a support channel.

## What the status page shows

| Section | Backed by | Detail |
|---------|-----------|--------|
| **Component status** | Synthetic probes (#415) | Per public endpoint (`/prices`, `/history`, `/health`, WebSocket): `Operational` / `Degraded` / `Partial Outage` / `Major Outage`, derived from `probe_success` across vantage points over the last 5 minutes |
| **Uptime** | `probe_success` + SLO recording rules | 90-day rolling uptime % per component, plus the current month against the 99.9% SLO and remaining error budget |
| **Latency** | `probe_duration_seconds` | p50 / p95 over 24h per endpoint |
| **On-chain freshness** | `onchain_price_staleness_seconds` (#417) | Seconds since last on-chain price update for the headline pairs |
| **Active incidents** | Incident store | Live incidents with severity, affected components, and a running update log |
| **Incident history** | Incident store | Past 12 months: timeline, duration, affected components, link to post-mortem |
| **Scheduled maintenance** | Incident store | Upcoming maintenance windows |

## Architecture

```
 synthetic probes ─┐
 SLO recording   ──┼─► Prometheus ──► status-aggregator ──► status API ──► status page (static SPA on CDN)
 rules            ─┘                        │
 on-chain metrics ─┘                        └─► incident store (Postgres table `status_incidents`)
```

- **`status-aggregator`** — a small job (runs every 30s) that reads the probe /
  SLO / staleness series from Prometheus, rolls them into a component-status JSON
  document, and writes it to object storage behind the CDN. The page itself is
  static and served from the CDN, so it **stays up when the main API is down**
  (different provider / account than the serving cluster).
- **Incident store** — `status_incidents` table (id, created_at, resolved_at,
  severity, title, affected_components[], updates[] `{ts, body}`,
  postmortem_url). Managed by on-call via a CLI / small admin UI; every write
  also appends to the public JSON feed.
- **Post-mortems** — written from `docs/runbooks/post-mortem-template.md`,
  published under `docs/incidents/` in this repo, and linked from the history
  entry. Summaries (blameless, root cause, remediation, timeline) are mirrored
  onto the status page so consumers do not need repo access.

## Status API for consumers

Stable, unauthenticated, CDN-cached (30s), CORS-open. Versioned under
`https://status.<domain>/api/v1`.

| Endpoint | Returns |
|----------|---------|
| `GET /summary.json` | `{ status: "operational" \| "degraded" \| "partial_outage" \| "major_outage", updated_at, components: [{ name, status, uptime_90d, latency_p95_ms }] }` |
| `GET /incidents.json?window=90d` | array of incidents `{ id, title, severity, status, started_at, resolved_at, affected_components, updates[], postmortem_url }` |
| `GET /incidents/{id}.json` | single incident with full update log |
| `GET /uptime.json?component=prices&window=90d` | daily uptime buckets `[{ date, uptime, incidents }]` |
| `GET /history.rss` / `/history.atom` | incident feed for consumers who want push |

Response shape is frozen within a major version; new fields are additive. A
`Cache-Control: public, max-age=30` header is always set so a traffic spike
against the status API (which happens precisely during an incident) is absorbed
by the CDN.

## Incident lifecycle

1. `SyntheticProbeMultiRegionDown` (or an on-call judgement call) opens an
   incident → `status_incidents` row, status `investigating`, page turns
   yellow/red automatically via the aggregator.
2. On-call posts updates (`identified` → `monitoring` → `resolved`); each update
   is public within seconds.
3. On resolve, `resolved_at` is set; the incident moves to history.
4. Within 5 business days a post-mortem is published and linked; the history
   entry and `postmortem_url` are updated.
