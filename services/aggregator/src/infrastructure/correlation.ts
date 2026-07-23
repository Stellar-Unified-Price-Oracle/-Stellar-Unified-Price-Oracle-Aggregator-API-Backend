import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';

export interface CorrelationContext {
  requestId: string;
  traceId: string;
}

const storage = new AsyncLocalStorage<CorrelationContext>();

/**
 * Runs `fn` with a correlation context derived from inbound `x-request-id` /
 * `x-trace-id` headers (falling back to freshly generated ids), matching the
 * convention set by the API's requestIdMiddleware so a single request can be
 * followed across the API -> aggregator boundary in logs.
 */
export function withCorrelation<T>(
  headers: { 'x-request-id'?: string; 'x-trace-id'?: string } | Record<string, string | string[] | undefined>,
  fn: () => T,
): T {
  const requestId = (headers['x-request-id'] as string) || randomUUID();
  const traceId = (headers['x-trace-id'] as string) || randomUUID();
  return storage.run({ requestId, traceId }, fn);
}

export function getCorrelation(): CorrelationContext | undefined {
  return storage.getStore();
}

/** Headers to attach to outbound calls so downstream services can continue the chain. */
export function correlationHeaders(): Record<string, string> {
  const ctx = storage.getStore();
  if (!ctx) return {};
  return { 'x-request-id': ctx.requestId, 'x-trace-id': ctx.traceId };
}
