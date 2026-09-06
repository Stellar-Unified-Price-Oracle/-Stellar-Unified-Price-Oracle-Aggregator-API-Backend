# Cross-region distributed tracing

Issue #419. Trace a request end-to-end across regions: **source fetch ->
aggregation -> replication bus -> API read** must appear as one trace.

## Propagation across the replication bus

HTTP hops already propagate W3C trace context via the OpenTelemetry auto
instrumentation in `api/src/observability/tracing.ts`. The gap was the
region-to-region replication bus, which is not HTTP.

- `api/src/observability/trace-propagation.ts` — `injectTraceContext(carrier)` /
  `withExtractedContext(carrier, fn)` serialize the active context into a plain
  string map that rides on any bus transport (Kafka/NATS headers, SQS message
  attributes, or a `trace` field in the JSON envelope).
- `services/aggregator/src/replication/trace-context.ts` — dependency-free
  `traceparent` / `tracestate` parse/format for the aggregator, which does not
  ship the OTel SDK. `propagateForHop(inbound, regionId)` keeps the trace id,
  mints a new span id per hop, and records the region in `tracestate`.
- `RegionPriceRecord` now carries optional `traceparent` / `tracestate`, and
  `RegionPriceReplicator.outboundTraceHeaders(asset)` produces the headers for
  the next hop from the last inbound record.

Producer side:

```ts
const headers = replicator.outboundTraceHeaders(price.asset);
bus.publish(topic, { ...payload, traceparent: headers.traceparent, tracestate: headers.tracestate });
```

Consumer side:

```ts
const ctx = parseTraceparent({ traceparent: msg.traceparent, tracestate: msg.tracestate });
replicator.mergeRemotePrice({ region, asset, price, decimals, timestamp,
  traceparent: msg.traceparent, tracestate: msg.tracestate });
```

## Verify a single trace spans all four stages

1. Enable tracing on the API and aggregator in two regions
   (`TRACING_ENABLED=true`, shared OTLP collector / Tempo).
2. Issue one read: `curl -H 'traceparent: 00-<32 hex>-<16 hex>-01' \
   https://<region-a>/api/v2/prices/BTC`.
3. In the tracing UI, open that trace id. It must contain, under one root:
   - `source.fetch` span (region A)
   - `price.aggregate` span (region A)
   - `replication.publish` -> `replication.consume` spans with
     `region.source=a`, `region.target=b`, `region.cross_region=true`
   - `GET /api/v2/prices/:asset` span served from region B's replica
4. Automated check: `api/tests/trace-propagation.test.ts` asserts an
   inject -> extract round trip preserves the trace id and that
   `propagateForHop` keeps the id while changing the span id.

## Cross-region latency breakdown

Each stage emits `regionLatencyAttributes(stage, region, elapsedMs)` on its span
(`pipeline.stage`, `pipeline.region`, `pipeline.stage_latency_ms`), and
replication spans add `replication.bus_transit_ms` (enqueue -> dequeue). Feed
those into the histograms behind `docs/dashboards/cross-region-tracing.json` for
per-stage and per-region-pair p95 breakdowns, plus an alert on
`trace_missing_replication_span_total` catching traces that never crossed the
bus.
