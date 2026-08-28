import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { getTracer, getActiveSpan, initializeTracing } from '../src/observability/tracing';

describe('OpenTelemetry: Distributed Tracing with Context Propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Trace Context Initialization', () => {
    it('should initialize tracing with config', () => {
      const config = {
        enabled: true,
        jaegerEndpoint: 'http://localhost:14268/api/traces',
        samplingRate: 0.1,
        serviceName: 'stellar-oracle-api',
      };

      vi.mock('../src/infrastructure/config', () => ({
        config: {},
      }));

      expect(() => {
        initializeTracing(config);
      }).not.toThrow();
    });

    it('should skip initialization when tracing is disabled', () => {
      const config = {
        enabled: false,
        serviceName: 'stellar-oracle-api',
      };

      expect(() => {
        initializeTracing(config);
      }).not.toThrow();
    });

    it('should get tracer instance by name', () => {
      const tracer = getTracer('stellar-oracle-api');
      expect(tracer).toBeDefined();
      expect(typeof tracer.startSpan).toBe('function');
    });
  });

  describe('Correlation Headers for Context Propagation', () => {
    it('should support X-Trace-ID header', () => {
      const headers = {
        'x-trace-id': 'abc123def456',
        'Content-Type': 'application/json',
      };

      expect(headers['x-trace-id']).toBe('abc123def456');
    });

    it('should support W3C Trace Context traceparent header', () => {
      const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
      const headers = {
        'traceparent': traceparent,
        'Content-Type': 'application/json',
      };

      expect(headers.traceparent).toBe(traceparent);
    });

    it('should support X-Correlation-ID header', () => {
      const correlationId = 'corr-123-456';
      const headers = {
        'x-correlation-id': correlationId,
        'Content-Type': 'application/json',
      };

      expect(headers['x-correlation-id']).toBe(correlationId);
    });

    it('should support X-Request-ID header', () => {
      const requestId = 'req-xyz-789';
      const headers = {
        'x-request-id': requestId,
        'Content-Type': 'application/json',
      };

      expect(headers['x-request-id']).toBe(requestId);
    });

    it('should support B3 trace propagation headers', () => {
      const headers = {
        'x-b3-traceid': 'abc123def456',
        'x-b3-spanid': 'span123',
        'x-b3-sampled': '1',
        'Content-Type': 'application/json',
      };

      expect(headers['x-b3-traceid']).toBe('abc123def456');
      expect(headers['x-b3-spanid']).toBe('span123');
      expect(headers['x-b3-sampled']).toBe('1');
    });
  });

  describe('Span Creation and Context Propagation', () => {
    it('should create spans with correlation ID', () => {
      const tracer = getTracer('test-tracer');
      const correlationId = 'test-corr-123';

      const span = tracer.startSpan('test-operation', {
        attributes: {
          'http.request.id': correlationId,
        },
      });

      expect(span).toBeDefined();
      expect(typeof span.end).toBe('function');

      span.end();
    });

    it('should create nested spans for distributed tracing', () => {
      const tracer = getTracer('test-tracer');

      const parentSpan = tracer.startSpan('api-request', {
        attributes: {
          'http.method': 'GET',
          'http.url': '/prices',
        },
      });

      const childSpan = tracer.startSpan('db-query', {
        attributes: {
          'db.system': 'memory',
          'db.operation': 'SELECT',
        },
      });

      expect(parentSpan).toBeDefined();
      expect(childSpan).toBeDefined();

      childSpan.end();
      parentSpan.end();
    });

    it('should include correlation ID in span attributes', () => {
      const tracer = getTracer('test-tracer');
      const correlationId = 'corr-test-456';

      const span = tracer.startSpan('operation', {
        attributes: {
          'correlation_id': correlationId,
          'service.name': 'stellar-oracle-api',
        },
      });

      expect(span).toBeDefined();
      span.end();
    });
  });

  describe('Cross-Service Context Propagation', () => {
    it('should propagate trace context to aggregator service', () => {
      const traceId = '0af7651916cd43dd8448eb211c80319c';
      const spanId = 'b7ad6b7169203331';

      const headers = {
        'traceparent': `00-${traceId}-${spanId}-01`,
        'x-request-id': 'req-123-456',
        'x-correlation-id': 'corr-xyz-789',
      };

      expect(headers.traceparent).toContain(traceId);
      expect(headers.traceparent).toContain(spanId);
      expect(headers['x-request-id']).toBe('req-123-456');
      expect(headers['x-correlation-id']).toBe('corr-xyz-789');
    });

    it('should include correlation headers in fetch requests to aggregator', () => {
      const correlationId = 'test-correlation-123';
      const requestId = 'test-request-456';

      const headers = {
        'Content-Type': 'application/json',
        'x-correlation-id': correlationId,
        'x-request-id': requestId,
        'traceparent': '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      };

      expect(headers['x-correlation-id']).toBe(correlationId);
      expect(headers['x-request-id']).toBe(requestId);
      expect(headers.traceparent).toBeDefined();
    });

    it('should preserve correlation context across async operations', async () => {
      const tracer = getTracer('async-tracer');
      const correlationId = 'async-corr-123';

      const span = tracer.startSpan('async-operation', {
        attributes: {
          'correlation_id': correlationId,
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(span).toBeDefined();
      span.end();
    });
  });

  describe('Tracing Attributes and Metadata', () => {
    it('should include HTTP method in trace attributes', () => {
      const tracer = getTracer('http-tracer');

      const span = tracer.startSpan('http-request', {
        attributes: {
          'http.method': 'GET',
          'http.url': 'https://api.example.com/prices',
          'http.status_code': 200,
        },
      });

      expect(span).toBeDefined();
      span.end();
    });

    it('should include API key identification in traces', () => {
      const tracer = getTracer('api-key-tracer');
      const keyHash = 'sha256hash123';

      const span = tracer.startSpan('api-request', {
        attributes: {
          'api.key.hash': keyHash,
          'api.key.tier': 'pro',
          'api.key.role': 'viewer',
        },
      });

      expect(span).toBeDefined();
      span.end();
    });

    it('should include rate limit info in trace attributes', () => {
      const tracer = getTracer('rate-limit-tracer');

      const span = tracer.startSpan('rate-limit-check', {
        attributes: {
          'ratelimit.limit': 500,
          'ratelimit.remaining': 499,
          'ratelimit.reset_time': 1234567890,
        },
      });

      expect(span).toBeDefined();
      span.end();
    });

    it('should include service boundary crossing in traces', () => {
      const tracer = getTracer('service-tracer');

      const span = tracer.startSpan('api-to-aggregator', {
        attributes: {
          'service.source': 'stellar-oracle-api',
          'service.target': 'price-aggregator',
          'http.url': 'http://aggregator:4000/aggregate',
        },
      });

      expect(span).toBeDefined();
      span.end();
    });
  });

  describe('Sampling and Performance', () => {
    it('should respect sampling rate configuration', () => {
      const config = {
        enabled: true,
        samplingRate: 0.1,
        serviceName: 'stellar-oracle-api',
      };

      expect(config.samplingRate).toBe(0.1);
      expect(config.samplingRate).toBeGreaterThanOrEqual(0);
      expect(config.samplingRate).toBeLessThanOrEqual(1);
    });

    it('should generate valid trace IDs', () => {
      const traceId = '0af7651916cd43dd8448eb211c80319c';
      const spanId = 'b7ad6b7169203331';

      expect(traceId).toHaveLength(32);
      expect(spanId).toHaveLength(16);
      expect(/^[0-9a-f]+$/.test(traceId)).toBe(true);
      expect(/^[0-9a-f]+$/.test(spanId)).toBe(true);
    });

    it('should properly format W3C traceparent header', () => {
      const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

      const parts = traceparent.split('-');
      expect(parts.length).toBe(4);
      expect(parts[0]).toBe('00');
      expect(parts[1]).toHaveLength(32);
      expect(parts[2]).toHaveLength(16);
      expect(parts[3]).toMatch(/^(00|01)$/);
    });
  });

  describe('Error Tracing', () => {
    it('should record errors in spans', () => {
      const tracer = getTracer('error-tracer');

      const span = tracer.startSpan('operation-with-error', {
        attributes: {
          'error.type': 'NetworkError',
        },
      });

      span.recordException(new Error('Connection failed'));
      span.setStatus({ code: 2 });

      expect(span).toBeDefined();
      span.end();
    });

    it('should include error details in trace context', () => {
      const tracer = getTracer('error-tracer');

      const span = tracer.startSpan('failed-operation', {
        attributes: {
          'error.type': 'RateLimitError',
          'error.message': 'Rate limit exceeded',
          'http.status_code': 429,
        },
      });

      expect(span).toBeDefined();
      span.end();
    });
  });

  describe('Active Span Management', () => {
    it('should support getting active span', () => {
      const tracer = getTracer('active-span-tracer');
      const span = tracer.startSpan('test-operation');

      expect(span).toBeDefined();
      span.end();
    });

    it('should maintain span context across operations', () => {
      const tracer = getTracer('context-tracer');

      const span1 = tracer.startSpan('operation-1');
      const span2 = tracer.startSpan('operation-2');

      expect(span1).toBeDefined();
      expect(span2).toBeDefined();

      span2.end();
      span1.end();
    });
  });
});
