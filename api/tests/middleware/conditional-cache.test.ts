import { describe, it, expect, beforeEach } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import { conditionalCache } from '../../src/price-serving/conditional-cache';

describe('conditionalCache middleware', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: NextFunction;
  let nextCalled = false;
  let responseBody: unknown;
  let statusCode = 200;

  beforeEach(() => {
    nextCalled = false;
    statusCode = 200;
    responseBody = undefined;

    const responseHeaders: { [key: string]: string } = {};

    req = {
      method: 'GET',
      headers: {},
    };

    res = {
      status: function (code: number) {
        statusCode = code;
        return this;
      },
      setHeader: (name: string, value: string) => {
        responseHeaders[name.toLowerCase()] = value;
      },
      getHeader: (name: string) => responseHeaders[name.toLowerCase()],
      headers: responseHeaders,
      json: function (body: unknown) {
        responseBody = body;
        return this;
      },
      end: function () {
        return this;
      },
    };

    next = () => {
      nextCalled = true;
    };
  });

  it('should call next for non-GET requests', () => {
    req.method = 'POST';

    conditionalCache(req as Request, res as Response, next);

    expect(nextCalled).toBe(true);
  });

  it('should call next for DELETE requests', () => {
    req.method = 'DELETE';

    conditionalCache(req as Request, res as Response, next);

    expect(nextCalled).toBe(true);
  });

  it('should call next for PUT requests', () => {
    req.method = 'PUT';

    conditionalCache(req as Request, res as Response, next);

    expect(nextCalled).toBe(true);
  });

  it('should override res.json method', () => {
    const originalJson = res.json;

    conditionalCache(req as Request, res as Response, next);

    expect(res.json).not.toBe(originalJson);
    expect(nextCalled).toBe(true);
  });

  it('should set ETag header on response', () => {
    const headers: { [key: string]: string } = {};
    res.setHeader = (name: string, value: string) => {
      headers[name.toLowerCase()] = value;
    };
    res.getHeader = (name: string) => headers[name.toLowerCase()];

    conditionalCache(req as Request, res as Response, next);

    const testData = { price: 100 };
    res.json!(testData);

    expect(headers['etag']).toBeDefined();
    expect(headers['etag']).toMatch(/^"[a-f0-9]{40}"$/);
  });

  it('should set Last-Modified header on response', () => {
    const headers: { [key: string]: string } = {};
    res.setHeader = (name: string, value: string) => {
      headers[name.toLowerCase()] = value;
    };
    res.getHeader = (name: string) => headers[name.toLowerCase()];

    conditionalCache(req as Request, res as Response, next);

    const testData = { price: 100 };
    res.json!(testData);

    expect(headers['last-modified']).toBeDefined();
  });

  it('should set Cache-Control header to no-cache', () => {
    const headers: { [key: string]: string } = {};
    res.setHeader = (name: string, value: string) => {
      headers[name.toLowerCase()] = value;
    };
    res.getHeader = (name: string) => headers[name.toLowerCase()];

    conditionalCache(req as Request, res as Response, next);

    const testData = { price: 100 };
    res.json!(testData);

    expect(headers['cache-control']).toBe('no-cache');
  });

  it('should return 304 when ETag matches If-None-Match', () => {
    const headers: { [key: string]: string } = {};
    let status = 200;
    res.setHeader = (name: string, value: string) => {
      headers[name.toLowerCase()] = value;
    };
    res.getHeader = (name: string) => headers[name.toLowerCase()];
    res.status = function (code: number) {
      status = code;
      return this;
    };

    conditionalCache(req as Request, res as Response, next);

    const testData = { price: 100 };
    res.json!(testData);

    const etag = headers['etag'];

    // Second request with If-None-Match
    req.headers = { 'if-none-match': etag };
    res.json!(testData);

    expect(status).toBe(304);
  });

  it('should return 304 when If-Modified-Since is not before Last-Modified', () => {
    const headers: { [key: string]: string } = {};
    let status = 200;
    let ended = false;
    res.setHeader = (name: string, value: string) => {
      headers[name.toLowerCase()] = value;
    };
    res.getHeader = (name: string) => headers[name.toLowerCase()];
    res.status = function (code: number) {
      status = code;
      return this;
    };
    res.end = function () {
      ended = true;
      return this;
    };

    conditionalCache(req as Request, res as Response, next);

    const testData = { price: 100 };
    res.json!(testData);

    const lastModified = headers['last-modified'];

    // Create a new response object for second call with old If-Modified-Since
    const headers2: { [key: string]: string } = {};
    let status2 = 200;
    let ended2 = false;
    res.setHeader = (name: string, value: string) => {
      headers2[name.toLowerCase()] = value;
    };
    res.getHeader = (name: string) => headers2[name.toLowerCase()];
    res.status = function (code: number) {
      status2 = code;
      return this;
    };
    res.end = function () {
      ended2 = true;
      return this;
    };

    req.headers = { 'if-modified-since': new Date(Date.now() + 10000).toUTCString() };
    conditionalCache(req as Request, res as Response, next);
    res.json!(testData);

    expect(status2).toBe(304);
    expect(ended2).toBe(true);
  });

  it('should generate different ETags for different content', () => {
    const headers1: { [key: string]: string } = {};
    const headers2: { [key: string]: string } = {};

    res.setHeader = (name: string, value: string) => {
      headers1[name.toLowerCase()] = value;
    };
    res.getHeader = (name: string) => headers1[name.toLowerCase()];

    conditionalCache(req as Request, res as Response, next);

    const data1 = { price: 100 };
    res.json!(data1);

    const etag1 = headers1['etag'];

    // Create new middleware instance for second response
    res.setHeader = (name: string, value: string) => {
      headers2[name.toLowerCase()] = value;
    };
    res.getHeader = (name: string) => headers2[name.toLowerCase()];

    conditionalCache(req as Request, res as Response, next);

    const data2 = { price: 200 };
    res.json!(data2);

    const etag2 = headers2['etag'];

    expect(etag1).not.toBe(etag2);
  });

  it('should generate same ETag for identical content', () => {
    const data = { price: 100 };

    const headers1: { [key: string]: string } = {};
    res.setHeader = (name: string, value: string) => {
      headers1[name.toLowerCase()] = value;
    };
    res.getHeader = (name: string) => headers1[name.toLowerCase()];

    conditionalCache(req as Request, res as Response, next);
    res.json!(data);

    const etag1 = headers1['etag'];

    const headers2: { [key: string]: string } = {};
    res.setHeader = (name: string, value: string) => {
      headers2[name.toLowerCase()] = value;
    };
    res.getHeader = (name: string) => headers2[name.toLowerCase()];

    conditionalCache(req as Request, res as Response, next);
    res.json!(data);

    const etag2 = headers2['etag'];

    expect(etag1).toBe(etag2);
  });

  it('should not apply conditional cache to non-GET requests', () => {
    const headers: { [key: string]: string } = {};
    req.method = 'POST';
    res.setHeader = (name: string, value: string) => {
      headers[name.toLowerCase()] = value;
    };

    conditionalCache(req as Request, res as Response, next);

    expect(nextCalled).toBe(true);
    expect(headers['etag']).toBeUndefined();
  });
});
