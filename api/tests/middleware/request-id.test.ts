import { describe, it, expect, beforeEach } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import { requestIdMiddleware } from '../../src/observability/request-id';

describe('requestIdMiddleware', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: NextFunction;
  let nextCalled = false;

  beforeEach(() => {
    nextCalled = false;
    req = {
      get: (header: string) => {
        const headers: { [key: string]: string | undefined } = {
          'x-request-id': undefined,
          'x-trace-id': undefined,
          'x-span-id': undefined,
          'user-agent': undefined,
        };
        return headers[header.toLowerCase()];
      },
      method: 'GET',
      path: '/api/v1/prices',
      url: '/api/v1/prices',
      hostname: 'localhost',
      protocol: 'http',
      ip: '127.0.0.1',
    };

    const headers: { [key: string]: string } = {};
    res = {
      setHeader: (name: string, value: string | number) => {
        headers[name.toLowerCase()] = String(value);
      },
      getHeader: (name: string) => headers[name.toLowerCase()],
      send: function (data: unknown) {
        return this;
      },
    };

    next = () => {
      nextCalled = true;
    };
  });

  it('should generate request ID if not provided', () => {
    requestIdMiddleware(req as Request, res as Response, next);

    expect(req.requestId).toBeDefined();
    expect(req.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(nextCalled).toBe(true);
  });

  it('should use provided request ID from header', () => {
    const customId = 'custom-request-123';
    req.get = (header: string) => {
      if (header === 'x-request-id') return customId;
      return undefined;
    };

    requestIdMiddleware(req as Request, res as Response, next);

    expect(req.requestId).toBe(customId);
    expect(nextCalled).toBe(true);
  });

  it('should propagate request ID in response headers', () => {
    const customId = 'custom-request-456';
    req.get = (header: string) => {
      if (header === 'x-request-id') return customId;
      return undefined;
    };

    const headerSpy: { [key: string]: string } = {};
    res.setHeader = (name: string, value: string | number) => {
      headerSpy[name.toLowerCase()] = String(value);
    };

    requestIdMiddleware(req as Request, res as Response, next);

    expect(headerSpy['x-request-id']).toBe(customId);
    expect(headerSpy['x-trace-id']).toBeDefined();
    expect(headerSpy['x-span-id']).toBeDefined();
  });

  it('should generate trace ID if not provided', () => {
    requestIdMiddleware(req as Request, res as Response, next);

    expect(req.traceId).toBeDefined();
    expect(req.traceId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('should use provided trace ID from header', () => {
    const customTraceId = 'custom-trace-789';
    req.get = (header: string) => {
      if (header === 'x-trace-id') return customTraceId;
      return undefined;
    };

    requestIdMiddleware(req as Request, res as Response, next);

    expect(req.traceId).toBe(customTraceId);
  });

  it('should generate span ID', () => {
    requestIdMiddleware(req as Request, res as Response, next);

    expect(req.spanId).toBeDefined();
    expect(req.spanId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('should capture parent span ID from header', () => {
    const parentSpanId = 'parent-span-123';
    req.get = (header: string) => {
      if (header === 'x-span-id') return parentSpanId;
      return undefined;
    };

    requestIdMiddleware(req as Request, res as Response, next);

    expect(req.parentSpanId).toBe(parentSpanId);
  });

  it('should set trace IDs in response headers', () => {
    const headerSpy: { [key: string]: string } = {};
    res.setHeader = (name: string, value: string | number) => {
      headerSpy[name.toLowerCase()] = String(value);
    };

    requestIdMiddleware(req as Request, res as Response, next);

    expect(headerSpy['x-request-id']).toBeDefined();
    expect(headerSpy['x-trace-id']).toBeDefined();
    expect(headerSpy['x-span-id']).toBeDefined();
  });

  it('should call next middleware', () => {
    requestIdMiddleware(req as Request, res as Response, next);

    expect(nextCalled).toBe(true);
  });

  it('should populate all request properties', () => {
    requestIdMiddleware(req as Request, res as Response, next);

    expect(req.requestId).toBeDefined();
    expect(req.traceId).toBeDefined();
    expect(req.spanId).toBeDefined();
  });
});
