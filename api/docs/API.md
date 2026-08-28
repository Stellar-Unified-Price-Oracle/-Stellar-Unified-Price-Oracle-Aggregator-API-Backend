# API Reference

Comprehensive reference for the Stellar Unified Price Oracle REST and WebSocket
API. For the interactive, always-in-sync version, see the Swagger UI at
`/api/v1/docs` (generated from [`api/openapi.json`](../openapi.json)).

## Base URL

```
http://localhost:3000/api/v1   # REST (local dev)
ws://localhost:3001            # WebSocket (local dev)
```

## Authentication

Protected endpoints (all `/api/v1/prices*` routes, WebSocket connections, and
admin routes) require an API key, supplied either as a bearer token or a
dedicated header:

```
Authorization: Bearer <api-key>
```

or

```
X-Api-Key: <api-key>
```

Requests without a valid key receive `401 Unauthorized`:

```json
{
  "success": false,
  "error": {
    "code": "MISSING_API_KEY",
    "message": "API key required. Use Authorization: Bearer <key> or X-Api-Key header."
  }
}
```

WebSocket clients authenticate the same way, via headers sent during the
connection upgrade; an invalid or missing key closes the socket with code
`1008` and an `{"type": "error", "code": "UNAUTHORIZED", ...}` message.

## Rate Limiting

Requests are rate limited per API key (tenant), per IP, and globally, with a
lower per-endpoint budget for expensive routes. Defaults (overridable via
env vars):

| Layer | Limit | Env var |
|-------|-------|---------|
| Tenant (per API key) | 100 req / 60s | `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS` |
| IP | 100 req / 60s | `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS` |
| Global | 1000 req / 60s | derived (`RATE_LIMIT_MAX` × 10) |
| Per-endpoint | 50 req / 60s | derived (`RATE_LIMIT_MAX` / 2) |
| WebSocket messages | 20 / 60s | `WS_RATE_LIMIT_MAX`, `WS_RATE_LIMIT_WINDOW_MS` |

Every response includes standard rate-limit headers:

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 97
X-RateLimit-Reset: 1719000060
```

Exceeding a limit returns `429 Too Many Requests` with `error.code: RATE_LIMITED`.
The `/metrics` endpoint is exempt from rate limiting.

## Error Format

All errors share one JSON shape:

```json
{
  "success": false,
  "error": {
    "code": "PRICE_NOT_FOUND",
    "message": "No price data is available for the requested asset",
    "type": "https://api.stellar-oracle.com/errors/price-not-found",
    "instance": "/api/v1/prices/DOGE"
  }
}
```

| Code | HTTP Status | Meaning |
|------|-------------|---------|
| `BAD_REQUEST` | 400 | Request is invalid or malformed |
| `UNAUTHORIZED` | 401 | Authentication is required but not provided |
| `FORBIDDEN` | 403 | Insufficient permissions |
| `NOT_FOUND` | 404 | Resource does not exist |
| `CONFLICT` | 409 | Request conflicts with existing data |
| `UNPROCESSABLE_ENTITY` | 422 | Well-formed request with semantic errors |
| `RATE_LIMITED` | 429 | Rate limit exceeded |
| `INTERNAL_ERROR` | 500 | Unexpected server error |
| `SERVICE_UNAVAILABLE` | 503 | Service temporarily unavailable |
| `GATEWAY_TIMEOUT` | 504 | Upstream service did not respond in time |
| `INVALID_ASSET` | 400 | Asset code is invalid or unsupported |
| `PRICE_NOT_FOUND` | 404 | No price data available for the asset |
| `PRICE_STALE` | 503 | Price data older than the staleness threshold |
| `SOURCE_UNHEALTHY` | 503 | One or more oracle sources are unhealthy |
| `AGGREGATION_FAILED` | 503 | Failed to aggregate price data |
| `CONTRACT_ERROR` | 503 | Error interacting with the Soroban contract |
| `INVALID_DECIMALS` | 400 | Invalid price decimals value |
| `INVALID_TIMESTAMP` | 400 | Timestamp invalid or in the future |
| `WEBSOCKET_ERROR` | 400 | Error in the WebSocket connection |
| `VALIDATION_ERROR` | 422 | One or more field validation errors |

## REST Endpoints

### `GET /api/v1`

API root with a listing of available endpoints. No auth required.

### `GET /api/v1/prices`

All current prices. Optional `?asset=XLM` to filter to one asset. Requires auth.

```bash
curl -H "X-Api-Key: $API_KEY" \
  "http://localhost:3000/api/v1/prices?asset=XLM"
```

```json
{
  "success": true,
  "data": [
    {
      "asset": "XLM",
      "price": "10000000000",
      "decimals": 7,
      "source": "chainlink",
      "timestamp": 1719000000
    }
  ]
}
```

### `GET /api/v1/prices/:asset`

Current price for one asset (e.g. `XLM`, `BTC`, `ETH`, `USDC`, `USDT`). Requires auth.

```bash
curl -H "X-Api-Key: $API_KEY" http://localhost:3000/api/v1/prices/BTC
```

```json
{
  "success": true,
  "data": {
    "asset": "BTC",
    "price": "650000000000",
    "decimals": 7,
    "source": "chainlink",
    "timestamp": 1719000000
  }
}
```

`404 PRICE_NOT_FOUND` if the asset has no data; `400 INVALID_ASSET` if the
symbol isn't recognized.

### `GET /api/v1/history/:asset`

Historical prices for an asset. Query params: `from`, `to` (unix timestamps),
`limit`. Requires auth.

```bash
curl -H "X-Api-Key: $API_KEY" \
  "http://localhost:3000/api/v1/history/XLM?limit=50"
```

### `GET /api/v1/sources`

Oracle source metadata (name, health status, last successful poll). No auth
required.

### `GET /api/v1/health`, `/api/v1/health/live`, `/api/v1/health/ready`

Liveness/readiness/aggregate health status. No auth required.

### `GET /api/v1/docs`

Swagger UI, rendered from `api/openapi.json`.

### `GET /metrics`

Prometheus metrics in text exposition format. Exempt from rate limiting.

### Usage & webhooks

`GET /api/v1/usage/reports`, `/api/v1/usage/dashboard`, `/api/v1/usage/anomalies`,
and the `/api/v1/webhooks` CRUD + `/api/v1/webhooks/:id/deliveries` routes are
documented with full request/response schemas in the Swagger UI — see
`api/openapi.json` for the authoritative machine-readable spec.

## WebSocket Protocol

Connect to `ws://localhost:3001` with an API key header (same as REST). On a
successful connection the server sends:

```json
{"type": "connected", "clientCount": 3, "sequenceId": 0, "replaySupported": true, "bufferSize": 200}
```

### Client → Server messages

| `type` | Payload | Effect |
|--------|---------|--------|
| `subscribe` | `{"type": "subscribe", "assets": ["XLM", "BTC"]}` | Subscribe to price updates for up to 50 assets |
| `unsubscribe` | `{"type": "unsubscribe", "assets": ["BTC"]}` | Unsubscribe from assets |
| `replay` | `{"type": "replay", "lastSequenceId": 42, "assets": ["XLM"]}` | Replay buffered messages since a sequence id |
| `ping` | `{"type": "ping"}` | Heartbeat |

### Server → Client messages

| `type` | Example | Meaning |
|--------|---------|---------|
| `connected` | `{"type": "connected", "clientCount": 3, "sequenceId": 0}` | Sent once on connect |
| `subscribed` | `{"type": "subscribed", "assets": ["XLM"], "sequenceId": 12}` | Ack for `subscribe` |
| `unsubscribed` | `{"type": "unsubscribed", "assets": ["BTC"]}` | Ack for `unsubscribe` |
| `price_update` | `{"type": "price_update", "sequenceId": 13, "data": {"asset": "XLM", "price": "10000000000", ...}}` | Pushed on every new price for a subscribed asset |
| `replay_complete` | `{"type": "replay_complete", "replayed": 5, "sequenceId": 13}` | Sent after a `replay` request finishes |
| `pong` | `{"type": "pong", "timestamp": 1719000000, "sequenceId": 13}` | Reply to `ping` |
| `error` | `{"type": "error", "message": "Invalid JSON"}` | Malformed message, invalid assets, or unknown type |

Each server message carries a monotonically increasing `sequenceId`; clients
that reconnect can request a `replay` from their last-seen `sequenceId` to
recover missed updates (bounded by the server's circular buffer, default 200
messages per asset, configurable via `WS_BUFFER_SIZE`).

WebSocket messages are rate limited separately from REST (default 20
messages / 60s per connection, see `WS_RATE_LIMIT_MAX`).
