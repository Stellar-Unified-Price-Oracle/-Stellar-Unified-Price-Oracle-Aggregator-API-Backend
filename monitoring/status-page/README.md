# Dependency Status Page

Static, real-time view of runtime service dependencies, color-coded by
health. Discovery is static (`scripts/discover-dependencies.ts` parses
`docker-compose.yml` plus known external oracle sources into
`monitoring/dependency-graph.json` / `.mmd`); this page polls each node's
health endpoint client-side to color the same graph live.

## Running

Serve this directory alongside the running stack, e.g.:

```bash
npx serve monitoring/status-page
```

Then open the served URL. Green = healthy, yellow = degraded, red =
unhealthy, gray = unknown/unreachable. Refreshes every 10 seconds.

## Regenerating the graph

```bash
tsx scripts/discover-dependencies.ts
```

Re-run after adding/removing a service in `docker-compose.yml` or a new
oracle source in `services/aggregator/src/config.ts`.
