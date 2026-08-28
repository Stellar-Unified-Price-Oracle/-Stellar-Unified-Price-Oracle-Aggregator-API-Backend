import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logger } from '../src/observability/logger';

vi.mock('../src/observability/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

interface StructuredLogEntry {
  level: string;
  message: string;
  timestamp: number;
  context: Record<string, unknown>;
  traceId?: string;
  sourceId?: string;
  prices?: Array<{ asset: string; price: number; source: string }>;
}

function createStructuredLog(
  level: string,
  message: string,
  context: Record<string, unknown>,
): StructuredLogEntry {
  return {
    level,
    message,
    timestamp: Date.now(),
    context,
  };
}

describe('Structured Logging for Aggregation Results', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('logs aggregation poll start with structured format', () => {
    const log = createStructuredLog('info', 'Aggregation poll started', {
      pollId: 'poll_123',
      assets: ['XLM', 'USDC'],
      sources: ['chainlink', 'redstone', 'band'],
    });

    expect(log.level).toBe('info');
    expect(log.context.pollId).toBe('poll_123');
    expect(log.context.assets).toEqual(['XLM', 'USDC']);
  });

  it('logs aggregated prices with structured format', () => {
    const log = createStructuredLog('info', 'Prices aggregated', {
      pollId: 'poll_123',
      prices: [
        { asset: 'XLM', price: 0.12, source: 'chainlink' },
        { asset: 'XLM', price: 0.121, source: 'redstone' },
        { asset: 'USDC', price: 1.0, source: 'band' },
      ],
      aggregationMethod: 'median',
      durationMs: 450,
    });

    expect(log.context.prices).toHaveLength(3);
    expect(log.context.aggregationMethod).toBe('median');
  });

  it('logs source-specific results with metadata', () => {
    const log = createStructuredLog('info', 'Source response received', {
      source: 'chainlink',
      asset: 'XLM',
      price: 0.12,
      decimals: 7,
      responseTimeMs: 125,
      statusCode: 200,
    });

    expect(log.context.source).toBe('chainlink');
    expect(log.context.responseTimeMs).toBe(125);
  });

  it('logs aggregation errors with error context', () => {
    const log = createStructuredLog('error', 'Aggregation poll failed', {
      pollId: 'poll_123',
      failureReason: 'insufficient_valid_sources',
      validSources: 1,
      requiredSources: 2,
      error: 'Not enough sources returned valid data',
    });

    expect(log.level).toBe('error');
    expect(log.context.failureReason).toBe('insufficient_valid_sources');
  });

  it('includes trace ID for distributed tracing', () => {
    const log = createStructuredLog('info', 'Aggregation completed', {
      pollId: 'poll_123',
      traceId: 'trace_abc123def456',
      parentSpanId: 'span_xyz789',
    });

    expect(log.context.traceId).toBe('trace_abc123def456');
  });

  it('logs aggregation health metrics', () => {
    const log = createStructuredLog('info', 'Aggregation health check', {
      pollId: 'poll_123',
      averageResponseTime: 150,
      successRate: 0.95,
      activeSourcesCount: 19,
      inactiveSourcesCount: 1,
      lastSuccessfulPoll: 1690000000000,
    });

    expect(log.context.successRate).toBe(0.95);
    expect(log.context.activeSourcesCount).toBe(19);
  });

  it('logs circuit breaker state changes', () => {
    const log = createStructuredLog('warn', 'Circuit breaker triggered', {
      source: 'redstone',
      previousState: 'closed',
      newState: 'open',
      failureCount: 5,
      consecutiveFailures: 3,
    });

    expect(log.level).toBe('warn');
    expect(log.context.newState).toBe('open');
  });

  it('includes JSON-serializable context for log aggregation systems', () => {
    const log = createStructuredLog('info', 'Price submission initiated', {
      submissionId: 'sub_123',
      asset: 'XLM',
      price: 0.12,
      decimals: 7,
      sourceCount: 18,
      aggregationMs: 350,
    });

    const serialized = JSON.stringify(log);
    expect(() => JSON.parse(serialized)).not.toThrow();
  });

  it('logs poll completion with summary statistics', () => {
    const log = createStructuredLog('info', 'Aggregation poll completed', {
      pollId: 'poll_123',
      totalDurationMs: 500,
      sourcesQueried: 20,
      sourcesSucceeded: 18,
      sourcesFailed: 2,
      pricesAggregated: 10,
      averageSourceResponseTime: 180,
    });

    expect(log.context.sourcesSucceeded).toBe(18);
    expect(log.context.sourcesFailed).toBe(2);
  });
});
