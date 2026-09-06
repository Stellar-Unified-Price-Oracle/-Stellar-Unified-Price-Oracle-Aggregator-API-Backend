import { describe, it, expect } from 'vitest';
import {
  parseTraceparent,
  formatTraceparent,
  propagateForHop,
  newTraceContext,
} from '../src/replication/trace-context';

const TP = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

describe('replication bus trace context (issue #419)', () => {
  it('parses a valid W3C traceparent', () => {
    const ctx = parseTraceparent({ traceparent: TP });
    expect(ctx).not.toBeNull();
    expect(ctx!.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(ctx!.parentId).toBe('b7ad6b7169203331');
    expect(ctx!.sampled).toBe(true);
  });

  it('rejects malformed or all-zero ids', () => {
    expect(parseTraceparent({ traceparent: 'garbage' })).toBeNull();
    expect(parseTraceparent({ traceparent: '00-' + '0'.repeat(32) + '-b7ad6b7169203331-01' })).toBeNull();
    expect(parseTraceparent(undefined)).toBeNull();
  });

  it('round-trips through format', () => {
    const ctx = parseTraceparent({ traceparent: TP })!;
    expect(formatTraceparent(ctx).traceparent).toBe(TP);
  });

  it('keeps the trace id across a hop but changes the span id', () => {
    const next = propagateForHop({ traceparent: TP }, 'eu-west');
    const parsed = parseTraceparent(next)!;
    expect(parsed.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(parsed.parentId).not.toBe('b7ad6b7169203331');
    expect(next.tracestate).toContain('stellar-eu-west=1');
  });

  it('starts a fresh trace when no context is carried', () => {
    const next = propagateForHop(undefined, 'us-east');
    const parsed = parseTraceparent(next)!;
    expect(parsed.traceId).toHaveLength(32);
    expect(/^[0-9a-f]{32}$/.test(parsed.traceId)).toBe(true);
  });

  it('newTraceContext produces valid ids', () => {
    const ctx = newTraceContext();
    expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(ctx.parentId).toMatch(/^[0-9a-f]{16}$/);
  });
});
