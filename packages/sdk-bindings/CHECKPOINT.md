# Checkpoint recovery

Owner: Developer ecosystem and integration. Scope: TypeScript SDK stream consumers (`src/checkpoint.ts`); the Python SDK should mirror the same contract.

## Behaviour
- Tracks the last processed `seq` per stream in a pluggable `CheckpointStore` (in-memory default; supply a durable store for restart recovery).
- On disconnect it reconnects with `connect(lastSeq)` using exponential backoff (250ms to 10s) and gives up after `maxRetries` consecutive failures without progress (error is rethrown).
- **Bounded replay:** `maxReplay` (default 1000). If the first message after reconnect is further ahead than that, the gap is reported with `truncatedByReplayLimit: true`.
- **Duplicates:** messages with `seq <= last` are dropped and counted.
- **Observable gaps:** `onGap` fires with the missing range; `stats` exposes `delivered`, `duplicatesDropped`, `gapsDetected`, `missedMessages`, `reconnects` for export to metrics. Alert on `missedMessages > 0`.
- Malformed sequence numbers are ignored.

## Tests
`node --test --experimental-strip-types packages/sdk-bindings/tests/checkpoint.test.ts` covers reconnect+dedupe, gap and truncation reporting, and retry exhaustion.

## Rollout / rollback
Opt-in: existing consumers are unaffected until they construct a `CheckpointResumer`. Roll back by reverting to the plain stream client; checkpoints are stored separately and can be deleted safely (consumer then starts from `seq 0`, relying on the server replay bound).
