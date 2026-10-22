# Webhooks: registration, delivery semantics and dead letters

The API can POST price updates to subscriber URLs. Registrations, delivery
history and dead-lettered payloads are durable (issue #601): they survive a
restart and are shared by every replica through the same store.

## Store

| `REDIS_URL` | Store | Sharing |
|---|---|---|
| set | `RedisWebhookStore` (`ioredis`) | Native — every replica reads/writes the same keys |
| unset | `FileWebhookStore` | Files under `WEBHOOK_DATA_DIR` (default data directory); point every replica at the same volume |

Each replica keeps a **local mirror** of registrations for synchronous
lookups, writes through to the store on `register`/`remove`, reloads the
mirror at startup (`webhookService.load()`) and re-reads it on an interval
(`webhookService.startRefresh()`), so registration and removal converge
without a restart. Runtime-only fields (trigger state, health) are preserved
across a refresh, so it never resets delivery pacing.

**Propagation window:** a registration created or deleted on one replica is
visible on another after at most `WEBHOOK_PROPAGATION_MS` (default 5000 ms),
which is how often the mirror re-reads the shared store. Reads served by the
replica that handled the write are immediate.

Registration records include the per-webhook signing secret. The file store
writes them mode `0600`; when `ENCRYPTION_KEY` is set the secret is stored as
an `enc:v1:` envelope (see `docs/KEY_MANAGEMENT.md`), which is the same
treatment the rest of the service gives secrets that must pass through files.

## Delivery semantics

These are consumer-facing and are published in the OpenAPI contract:

- **At-least-once.** A payload is retried with exponential backoff
  (`WEBHOOK_BASE_DELAY_MS` → `WEBHOOK_MAX_DELAY_MS`, `WEBHOOK_MAX_RETRIES`
  attempts) until it succeeds or the budget is spent. A crash between a
  successful `POST` and the acknowledgement can replay an attempt, so
  consumers **must deduplicate on `webhookId` + payload `timestamp`**.
- **Ordered per webhook, unordered across webhooks.** Attempts for a single
  webhook are sequential, so two triggers for the same webhook never deliver
  out of order. Two different webhooks — or two different replicas delivering
  to the same URL — have no ordering guarantee.
- **Timeouts.** Each attempt aborts after `WEBHOOK_TIMEOUT_MS` (default 10 s)
  and counts as a failed attempt.
- **Trigger pacing.** `interval` webhooks never fire more often than
  `max(trigger.value, WEBHOOK_MIN_INTERVAL_MS)`. `threshold` webhooks fire
  when the percent change between consecutive observations for that webhook
  meets `trigger.value`.

## Dead letters and replay

When a delivery exhausts its retries it is written to the dead-letter store
with the payload, the trigger context, the attempt count and the failure
reason, and the webhook's `status` becomes `dead-letter`.

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/webhooks/dead-letters` | List dead letters owned by the calling key |
| `GET /api/v1/webhooks/dead-letters/{id}` | One entry, including the payload |
| `POST /api/v1/webhooks/dead-letters/{id}/replay` | Re-deliver; requires `idempotencyKey` (body) or `Idempotency-Key` (header) |

Replay is **exactly-once for a successful replay**: a successful replay sets
`resolvedAt` and records the key in `replayId`, and any later replay of the
same entry — with any key — returns `status: "duplicate"` without delivering
again. A replay that itself fails leaves the entry unresolved so it can be
retried. Concurrent replays of the same entry return `status: "in-flight"`.

Responses: `replayed` and `duplicate` are `200`; a replay whose delivery fails
is `502` with `DELIVERY_FAILED`; a missing or foreign entry is `404`.

## Delivery history

`GET /api/v1/webhooks/{id}/deliveries` reads the durable, per-webhook history
(not a process-local ring), filtered by the calling key. Optional query
parameters:

- `limit` — newest N entries
- `since` — epoch-ms lower bound

Retention is bounded by two knobs, both applied by a periodic sweep
(`WEBHOOK_PRUNE_INTERVAL_MS`, default 60 s) and at startup:

- `WEBHOOK_DELIVERY_RETENTION_DAYS` (default 30) — age bound, applied to
  delivery history **and** dead letters
- `WEBHOOK_DELIVERY_MAX_ENTRIES` (default 20000) — hard cap on stored
  delivery records, newest kept

When the store is unreachable the service falls back to a process-local ring
and logs a warning; that path is a degraded safety net, not the contract.

## Configuration

All variables are documented with their defaults in `.env.example`
(`=== Webhooks (Issue #601) ===`).
