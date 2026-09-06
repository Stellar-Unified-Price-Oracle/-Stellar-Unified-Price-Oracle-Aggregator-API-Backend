/**
 * W3C trace-context helpers for the cross-region replication bus (issue #419).
 *
 * The aggregator service does not depend on the OpenTelemetry SDK, so this is a
 * dependency-free implementation of the `traceparent` / `tracestate` format
 * (https://www.w3.org/TR/trace-context/). It lets replication messages carry the
 * trace that started at source fetch through to the API read on the far side.
 */

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export interface TraceContext {
  traceId: string;
  parentId: string;
  sampled: boolean;
  traceState?: string;
}

export type TraceHeaders = { traceparent?: string; tracestate?: string };

function randomHex(bytes: number): string {
  let out = '';
  for (let i = 0; i < bytes; i += 1) {
    out += Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
  }
  return out;
}

/** Parse an inbound `traceparent` (+ optional `tracestate`). Returns null if malformed. */
export function parseTraceparent(headers: TraceHeaders | undefined): TraceContext | null {
  const match = headers?.traceparent?.match(TRACEPARENT_RE);
  if (!match) return null;
  const [, traceId, parentId, flags] = match;
  if (/^0+$/.test(traceId) || /^0+$/.test(parentId)) return null;
  return {
    traceId,
    parentId,
    sampled: (parseInt(flags, 16) & 0x01) === 1,
    traceState: headers?.tracestate,
  };
}

/** Serialize a context back to headers for the next hop. */
export function formatTraceparent(ctx: TraceContext): TraceHeaders {
  const headers: TraceHeaders = {
    traceparent: `00-${ctx.traceId}-${ctx.parentId}-${ctx.sampled ? '01' : '00'}`,
  };
  if (ctx.traceState) headers.tracestate = ctx.traceState;
  return headers;
}

/** Start a fresh trace when a replication message arrives without one. */
export function newTraceContext(sampled = true): TraceContext {
  return { traceId: randomHex(16), parentId: randomHex(8), sampled };
}

/**
 * Continue an inbound trace for an outbound replication message: keep the
 * trace id, mint a new span/parent id for this hop, and prepend this region to
 * `tracestate` so the cross-region path is visible.
 */
export function propagateForHop(
  inbound: TraceHeaders | undefined,
  regionId: string,
): TraceHeaders {
  const ctx = parseTraceparent(inbound) ?? newTraceContext();
  const vendorEntry = `stellar-${regionId}=1`;
  const priorState = ctx.traceState
    ? ctx.traceState
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith(`stellar-${regionId}=`))
        .join(',')
    : '';
  return formatTraceparent({
    traceId: ctx.traceId,
    parentId: randomHex(8),
    sampled: ctx.sampled,
    traceState: [vendorEntry, priorState].filter(Boolean).join(','),
  });
}
