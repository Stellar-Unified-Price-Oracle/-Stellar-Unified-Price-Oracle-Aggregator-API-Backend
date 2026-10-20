# SDK integration test harness

Owner: SDK / developer-ecosystem maintainers (assigned via issue #761).
Scope: a local, dependency-free (Node built-ins only) fixture server for exercising
supported SDKs against deterministic HTTP and WebSocket responses with failure injection.

## Usage

```js
import { startFixtureServer } from './fixture-server.mjs';
const s = await startFixtureServer();           // random port on 127.0.0.1
// point the SDK at s.baseUrl / s.wsUrl
s.inject({ type: 'status', status: 503, times: 2 });
await s.close();
```

Run the self-tests: `cd tests/sdk-integration-harness && node --test`.

Endpoints: `GET /health`, `GET /api/v1/prices`, `GET /api/v1/prices/:asset`, WebSocket `/ws`
(sends one `{"type":"price",...}` frame per fixture asset on connect).

## Failure modes

| mode | effect |
|------|--------|
| `status` (`status`, optional `times`) | HTTP error, then recovers after `times` requests |
| `latency` (`ms`) | delays every HTTP response |
| `malformed` | 200 with invalid JSON |
| `drop` | connection destroyed |
| `ws-close` | WebSocket closed right after handshake |

Fixtures live in `fixtures.mjs` (fixed timestamps). The fixtures mirror the documented v1
price shape in a simplified form; they are not generated from `api/openapi.json`, so
update them if the API contract changes.

## Compatibility, monitoring, operational impact

- Test-only tooling; no production code path, no runtime dependency, no monitoring signals.
- Binds to loopback only by default.
- The WebSocket server is minimal (server-to-client text frames, no ping/pong, no client frame parsing).

## Rollout and rollback

Rollout: merge; wire into SDK CI jobs by invoking the harness from SDK tests.
Rollback: delete `tests/sdk-integration-harness/`; nothing else depends on it.
