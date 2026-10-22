# WebSocket message contract

This is the contract between the API's WebSocket server (`WS_PORT`, default
3001) and its clients. It is normative: anything not listed here is not part
of the contract and may change without a version bump.

## Connecting

```json
{ "type": "connected", "clientCount": 3, "sequenceId": 1287, "sequenceModel": "global",
  "replaySupported": true, "bufferSize": 200, "replayMaxMessages": 200, "replayMaxBytes": 262144 }
```

Authentication happens on the HTTP upgrade; an unauthenticated socket is closed
with `1008` after an `UNAUTHORIZED` error message.

## Sequence model

- `sequenceId` is a **single monotonically increasing counter for the whole
  server**, not per asset.
- Buffers are **per asset** but numbered by the global counter, so a filtered
  view (a replay restricted to `assets: ["BTC"]`) contains a sparse subset of
  the global sequence. Gaps in a filtered view are expected and are **not** data
  loss.
- A client therefore tracks exactly one cursor: the highest `sequenceId` it has
  processed. To resume, it sends `replay` with that cursor.
- The server may drop buffered messages (see buffer retention). When it does,
  a replay starting from an older cursor reports `truncated: true`, which means
  "messages you did not receive are no longer available" — the client must
  resync (refetch the current snapshot over REST and restart its cursor) rather
  than assume it is caught up.

## Messages

### `subscribe` / `unsubscribe` (client → server)

```json
{ "type": "subscribe", "assets": ["BTC", "XLM"] }
```

Up to 50 asset symbols per message. The server answers `subscribed` /
`unsubscribed` with the same array.

### `replay` (client → server)

```json
{ "type": "replay", "lastSequenceId": 1200, "assets": ["BTC"] }
```

- `lastSequenceId` — required, integer ≥ 0; the cursor (exclusive lower bound).
- `assets` — optional; when omitted the server replays from every buffered
  asset.

Bounds applied to **every** replay request:

| Bound | Default | Meaning |
| --- | --- | --- |
| `WS_REPLAY_MAX_MESSAGES` | 200 | messages delivered per request |
| `WS_REPLAY_MAX_BYTES` | 262144 | total serialized bytes per request |
| `WS_REPLAY_RATE_LIMIT` | 10 | requests per connection per window |
| `WS_REPLAY_RATE_WINDOW_MS` | 60000 | rate limit window |

Messages are delivered in ascending `sequenceId` order as
`{"type":"price_update","replayed":true,"sequenceId":N,"data":{...}}`, followed
by exactly one `replay_complete`:

```json
{ "type": "replay_complete", "replayed": 42, "sequenceId": 1287,
  "lastSequenceId": 1241, "truncated": false, "remaining": 0,
  "gapDetected": false, "oldestReplayableSequence": 1088 }
```

- `lastSequenceId` — the cursor the client should use next (the highest
  delivered sequence, or the requested cursor when nothing was delivered).
- `truncated` — `true` when the message or byte bound cut the window short.
  `remaining` is how many matching messages were withheld.
- `gapDetected` — `true` when the cursor predates the oldest retained sequence;
  refetch a REST snapshot before resuming. `oldestReplayableSequence` is null
  when the ring has no messages.
- Caught up = `truncated: false`. Window exhausted = `truncated: true`; resync.

Exceeding the per-connection rate limit returns an error instead of replaying:

```json
{ "type": "error", "code": "REPLAY_RATE_LIMITED", "message": "..." }
```

### `ping` (client → server)

Answers `{"type":"pong","timestamp":...,"sequenceId":...}`.

## Buffer retention

Buffers are bounded twice: within an asset (`WS_BUFFER_SIZE`, 200 messages) and
across assets (`WS_BUFFER_MAX_ASSETS`, 64 assets, `WS_BUFFER_MAX_BYTES`,
8388608 bytes total). Reaching a cap evicts the oldest buffered message first,
so memory is a known ceiling rather than a function of traffic.

Measured by:

- `ws_api_buffered_assets` — assets currently buffered;
- `ws_api_buffer_bytes` — approximate retained bytes;
- `ws_api_replay_requests_total{result="complete|truncated|rate_limited"}` —
  replay outcomes (a `truncated` rate that is not zero is a signal that
  clients are losing history).

The global counter is atomically checkpointed after each update to
`WS_SEQUENCE_FILE` (default `./data/ws-sequence.json`). A restart advances from
the stored counter, preventing sequence reuse. The checkpoint does not persist
payloads: replay uses the bounded in-memory ring and reports a gap when older
payloads have fallen out. The default checkpoint is local to one API instance;
replicas require a shared checkpoint location to expose a common sequence.
