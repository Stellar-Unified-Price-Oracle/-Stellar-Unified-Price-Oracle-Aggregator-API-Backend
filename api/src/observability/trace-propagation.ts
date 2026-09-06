import { context, propagation, trace, SpanKind, Span } from '@opentelemetry/api';

/**
 * Cross-region distributed tracing propagation (issue #419).
 *
 * The replication path spans regions: source fetch -> aggregation -> replication
 * bus -> API read. For those spans to land in a single trace, W3C trace context
 * must ride along on every replication-bus message, not just HTTP requests.
 *
 * These helpers inject/extract trace context into a plain string map that can be
 * serialized onto any transport (Kafka/NATS headers, SQS attributes, a JSON
 * envelope field). They are transport-agnostic on purpose.
 */

export type TraceCarrier = Record<string, string>;

const setter = {
  set(carrier: TraceCarrier, key: string, value: string): void {
    carrier[key] = value;
  },
};

const getter = {
  keys(carrier: TraceCarrier): string[] {
    return Object.keys(carrier);
  },
  get(carrier: TraceCarrier, key: string): string | undefined {
    return carrier[key];
  },
};

/** Serialize the active trace context (traceparent/tracestate) into `carrier`. */
export function injectTraceContext(carrier: TraceCarrier = {}): TraceCarrier {
  propagation.inject(context.active(), carrier, setter);
  return carrier;
}

/**
 * Run `fn` with the trace context carried on an inbound replication message, so
 * spans created inside `fn` become children of the originating request's trace.
 */
export function withExtractedContext<T>(carrier: TraceCarrier, fn: () => T): T {
  const active = propagation.extract(context.active(), carrier, getter);
  return context.with(active, fn);
}

/**
 * Start a span for a cross-region replication hop. Records the source and target
 * region plus the enqueue->dequeue transit time so the tracing UI can show a
 * per-hop latency breakdown.
 */
export function startReplicationSpan(
  name: string,
  attrs: {
    sourceRegion: string;
    targetRegion: string;
    asset?: string;
    busTransitMs?: number;
    kind?: SpanKind;
  },
): Span {
  const tracer = trace.getTracer('stellar-oracle-replication');
  const span = tracer.startSpan(name, { kind: attrs.kind ?? SpanKind.PRODUCER });
  span.setAttribute('region.source', attrs.sourceRegion);
  span.setAttribute('region.target', attrs.targetRegion);
  span.setAttribute('region.cross_region', attrs.sourceRegion !== attrs.targetRegion);
  if (attrs.asset) span.setAttribute('oracle.asset', attrs.asset);
  if (typeof attrs.busTransitMs === 'number') {
    span.setAttribute('replication.bus_transit_ms', attrs.busTransitMs);
  }
  return span;
}

/**
 * Attributes describing a single leg of the cross-region path, for the
 * "cross-region latency breakdown" panel. Emit one per stage
 * (`source_fetch`, `aggregation`, `replication`, `api_read`).
 */
export function regionLatencyAttributes(stage: string, region: string, elapsedMs: number): Record<string, string | number> {
  return {
    'pipeline.stage': stage,
    'pipeline.region': region,
    'pipeline.stage_latency_ms': Math.round(elapsedMs),
  };
}
