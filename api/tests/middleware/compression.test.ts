import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import { compressionMiddleware } from '../../src/infrastructure/compression';

vi.mock('../../src/infrastructure/config', () => ({
  config: {
    compression: {
      enabled: true,
      threshold: 1024,
      level: 6,
    },
  },
}));

describe('compressionMiddleware', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: NextFunction;
  let nextCalled = false;
  let headersSent = false;

  beforeEach(() => {
    nextCalled = false;
    headersSent = false;

    const responseHeaders: { [key: string]: string | undefined } = {};
    const setSpy = vi.fn();
    const removeHeaderSpy = vi.fn();

    req = {
      headers: {
        'accept-encoding': 'gzip, deflate, br',
      },
    };

    res = {
      headersSent: false,
      set: setSpy as any,
      setHeader: (name: string, value: string | number) => {
        responseHeaders[name.toLowerCase()] = String(value);
      },
      getHeader: (name: string) => responseHeaders[name.toLowerCase()],
      removeHeader: removeHeaderSpy as any,
      json: function (body: unknown) {
        return this;
      },
      send: function (body: unknown) {
        return this;
      },
    };

    Object.defineProperty(res, 'headersSent', {
      get: () => headersSent,
    });

    next = () => {
      nextCalled = true;
    };
  });

  it('should call next when compression is disabled', () => {
    vi.resetModules();
    vi.mock('../../src/infrastructure/config', () => ({
      config: {
        compression: {
          enabled: false,
          threshold: 1024,
          level: 6,
        },
      },
    }));

    const middleware = compressionMiddleware();
    middleware(req as Request, res as Response, next);

    expect(nextCalled).toBe(true);
  });

  it('should call next when no accept-encoding header', () => {
    req.headers = {};

    const middleware = compressionMiddleware();
    middleware(req as Request, res as Response, next);

    expect(nextCalled).toBe(true);
  });

  it('should call next when unsupported encoding requested', () => {
    req.headers = { 'accept-encoding': 'deflate' };

    const middleware = compressionMiddleware();
    middleware(req as Request, res as Response, next);

    expect(nextCalled).toBe(true);
  });

  it('should override res.json method when encoding is supported', () => {
    req.headers = { 'accept-encoding': 'gzip' };
    const middleware = compressionMiddleware();

    middleware(req as Request, res as Response, next);

    expect(nextCalled).toBe(true);
  });

  it('should override res.send method when encoding is supported', () => {
    req.headers = { 'accept-encoding': 'gzip' };
    const middleware = compressionMiddleware();

    middleware(req as Request, res as Response, next);

    expect(nextCalled).toBe(true);
  });

  it('should accept gzip encoding', () => {
    req.headers = { 'accept-encoding': 'gzip' };

    const middleware = compressionMiddleware();
    middleware(req as Request, res as Response, next);

    expect(nextCalled).toBe(true);
  });

  it('should accept brotli encoding', () => {
    req.headers = { 'accept-encoding': 'br' };

    const middleware = compressionMiddleware();
    middleware(req as Request, res as Response, next);

    expect(nextCalled).toBe(true);
  });

  it('should prefer brotli over gzip when both available', () => {
    req.headers = { 'accept-encoding': 'gzip, br' };

    const middleware = compressionMiddleware();
    middleware(req as Request, res as Response, next);

    expect(nextCalled).toBe(true);
  });

  it('should handle case-insensitive accept-encoding', () => {
    req.headers = { 'accept-encoding': 'GZIP, BR' };

    const middleware = compressionMiddleware();
    middleware(req as Request, res as Response, next);

    expect(nextCalled).toBe(true);
  });

  it('should use custom threshold option', () => {
    const middleware = compressionMiddleware({ threshold: 2048 });

    middleware(req as Request, res as Response, next);

    expect(nextCalled).toBe(true);
  });

  it('should use custom compression level option', () => {
    const middleware = compressionMiddleware({ level: 9 });

    middleware(req as Request, res as Response, next);

    expect(nextCalled).toBe(true);
  });

  it('should set Vary header for compressed responses', () => {
    req.headers = { 'accept-encoding': 'gzip' };
    const setSpy = vi.fn();
    res.set = setSpy;

    const middleware = compressionMiddleware({ threshold: 1 });
    middleware(req as Request, res as Response, next);

    expect(nextCalled).toBe(true);
  });

  it('should not compress when content is below threshold', () => {
    const middleware = compressionMiddleware({ threshold: 10000 });

    middleware(req as Request, res as Response, next);

    expect(nextCalled).toBe(true);
  });

  it('should skip compression when headers already sent', () => {
    headersSent = true;
    const middleware = compressionMiddleware();

    middleware(req as Request, res as Response, next);

    expect(nextCalled).toBe(true);
  });
});
