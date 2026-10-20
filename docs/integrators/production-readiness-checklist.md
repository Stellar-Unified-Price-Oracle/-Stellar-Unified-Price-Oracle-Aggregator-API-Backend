# Integrator production-readiness checklist

**Owner:** Developer-relations / integrations team
**Scope:** consumers of the REST and WebSocket API (and SDKs). On-chain consumers: see `docs/CONTRACT_VERSIONING.md`.
**Status:** Adopted

Complete every item before going live. Items marked (probe) are checked by `scripts/integrator-readiness-probe.mjs`.

## 1. Key handling
- [ ] API key is read from a secret store or environment, never committed, logged, or shipped to browsers.
- [ ] Keys are scoped per environment (sandbox vs production) and rotated on a schedule; rotation tested without downtime.
- [ ] Key is sent only in a header over HTTPS, never in a URL query string.
- [ ] A 401/403 triggers an alert and stops retries (no retry storms with a revoked key). (probe)

## 2. Freshness checks
- [ ] Every price read compares the response timestamp with local time and rejects values older than your max staleness (recommended: 3x the feed update interval).
- [ ] Stale or missing data falls back to a documented safe behavior (pause, last-known-good with a flag, or circuit-open), never a silent default. (probe)
- [ ] Clock skew between your host and the API is monitored (NTP) and tolerated up to a few seconds.

## 3. Reconnect behavior (WebSocket)
- [ ] Reconnect uses exponential backoff with jitter (start 1s, cap 30–60s).
- [ ] After reconnect the client resubscribes and refetches via REST to cover the gap.
- [ ] Heartbeat/ping timeout detection closes dead connections. (probe)
- [ ] Reconnect attempts are capped per minute to respect rate limits (`docs/rate-limit-tiers.md`).

## 4. Failure-safe reads
- [ ] Request timeouts are set (recommended 2–5s) with a bounded retry count on 5xx/429, honoring `Retry-After`. (probe)
- [ ] Response shape is validated before use (finite positive number, expected decimals, expected asset).
- [ ] Deviation guard: reject price moves beyond a sane bound versus the previous value.
- [ ] Circuit breaker around the oracle dependency; downstream actions (liquidations, mints) fail closed.

## 5. Observability
- [ ] Metrics: request latency, error rate, price age, reconnect count. Alert on price age above threshold.
- [ ] Support-ready diagnostics captured (see `docs/integrators/support-expectations.md`).

## Rollout and rollback
Roll out behind a flag against the sandbox first, then a small production percentage. Roll back by disabling the flag and falling back to your previous price source; the checklist and probe are documentation/tooling only and change no server behavior.

## Evidence of completion
Attach the probe output (JSON) and the ticked checklist to your go-live review.
