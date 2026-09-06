/**
 * #295 — Unit tests for the error-handling infrastructure:
 * `AppError`, the error catalog (`ERROR_CATALOG` / `getErrorDetails`),
 * the `errorHandler` middleware, and `notFoundHandler`.
 *
 * These assert the RFC7807-style error response format and the HTTP status
 * mapping for every registered error code.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import {
  AppError,
  createError,
  isAppError,
  type ErrorContext,
} from '../src/infrastructure/app-error';
import {
  ErrorCode,
  ERROR_CATALOG,
  getErrorDetails,
  type ErrorDetails,
} from '../src/infrastructure/catalog';
import { errorHandler, notFoundHandler, type ApiError } from '../src/infrastructure/error';
import { logger } from '../src/observability/logger';

vi.mock('../src/observability/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

interface MockRes {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
}

function makeRes(): MockRes {
  const res: Partial<MockRes> = {};
  res.json = vi.fn().mockReturnThis();
  res.status = vi.fn().mockReturnValue(res);
  res.setHeader = vi.fn();
  return res as MockRes;
}

function makeReq(overrides: Partial<Request> = {}): Request {
  const req = {
    path: '/api/v1/prices',
    method: 'GET',
    ...overrides,
  };
  return req as Request;
}

describe('AppError', () => {
  it('uses the catalog defaults for message and metadata', () => {
    const err = new AppError(ErrorCode.NOT_FOUND);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.status).toBe(404);
    expect(err.title).toBe('Not Found');
    expect(err.message).toBe('The requested resource does not exist');
    expect(err.type).toBe('https://api.stellar-oracle.com/errors/not-found');
  });

  it('overrides the message, context, and instance', () => {
    const context: ErrorContext = { asset: 'USDCABC' };
    const err = new AppError(ErrorCode.INVALID_ASSET, 'custom msg', context, '/prices/XLM');
    expect(err.message).toBe('custom msg');
    expect(err.context).toBe(context);
    expect(err.instance).toBe('/prices/XLM');
    expect(err.code).toBe('INVALID_ASSET');
  });

  it('is an instanceof Error and AppError', () => {
    const err = new AppError(ErrorCode.BAD_REQUEST);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AppError);
  });

  it('serializes to RFC7807 via toJSON()', () => {
    const err = new AppError(ErrorCode.RATE_LIMITED, 'slow down', undefined, '/x');
    const json = err.toJSON();
    expect(json.type).toBe('https://api.stellar-oracle.com/errors/rate-limited');
    expect(json.title).toBe('Too Many Requests');
    expect(json.status).toBe(429);
    expect(json.detail).toBe('slow down');
    expect(json.instance).toBe('/x');
  });

  it('toResponseObject() returns a discriminated failure envelope (success: false)', () => {
    const err = new AppError(ErrorCode.VALIDATION_ERROR);
    const body = err.toResponseObject();
    expect(body.success).toBe(false);
    expect(body.data).toBeUndefined();
    expect(body.error).toBeDefined();
    expect(body.error.code).toBeUndefined(); // AppError uses RFC7807 fields, not `code`
    expect(body.error.type).toContain('/errors/validation-error');
    expect(body.error.status).toBe(422);
    expect(typeof body.timestamp).toBe('string');
  });

  it('createError() produces an AppError', () => {
    const err = createError(ErrorCode.SERVICE_UNAVAILABLE, 'down');
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('SERVICE_UNAVAILABLE');
    expect(err.status).toBe(503);
  });

  it('isAppError() narrows correctly', () => {
    expect(isAppError(new AppError(ErrorCode.CONFLICT))).toBe(true);
    expect(isAppError(new Error('plain'))).toBe(false);
    expect(isAppError(null)).toBe(false);
  });
});

describe('Error catalog', () => {
  it('covers every ErrorCode with valid details', () => {
    const codes = Object.values(ErrorCode);
    expect(codes.length).toBeGreaterThanOrEqual(19);
    for (const code of codes) {
      const details = ERROR_CATALOG[code];
      expect(details).toBeDefined();
      expect(details.title).toBeTruthy();
      expect(details.description).toBeTruthy();
      expect(details.type).toMatch(/^https:\/\/api\.stellar-oracle\.com\/errors\//);
      // Status must be a real 4xx/5xx HTTP code.
      expect(details.status).toBeGreaterThanOrEqual(400);
      expect(details.status).toBeLessThan(600);
    }
  });

  it('maps client errors to 4xx and server errors to 5xx', () => {
    expect(getErrorDetails(ErrorCode.BAD_REQUEST).status).toBe(400);
    expect(getErrorDetails(ErrorCode.UNAUTHORIZED).status).toBe(401);
    expect(getErrorDetails(ErrorCode.FORBIDDEN).status).toBe(403);
    expect(getErrorDetails(ErrorCode.CONFLICT).status).toBe(409);
    expect(getErrorDetails(ErrorCode.UNPROCESSABLE_ENTITY).status).toBe(422);
    expect(getErrorDetails(ErrorCode.INTERNAL_ERROR).status).toBe(500);
    expect(getErrorDetails(ErrorCode.GATEWAY_TIMEOUT).status).toBe(504);
  });

  it('getErrorDetails() attaches the instance when provided', () => {
    const details = getErrorDetails(ErrorCode.NOT_FOUND, '/prices/XYZ') as ErrorDetails & {
      instance?: string;
    };
    expect(details.instance).toBe('/prices/XYZ');
  });
});

describe('errorHandler', () => {
  let res: MockRes;
  let next: NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();
    res = makeRes();
    next = vi.fn();
  });

  it('responds with the AppError status and discriminated error body', () => {
    const appErr = new AppError(ErrorCode.PRICE_NOT_FOUND, 'no data', undefined, '/prices/X');
    errorHandler(appErr, makeReq(), res as unknown as Response, next);

    expect(res.status).toHaveBeenCalledWith(404);
    const body = res.json.mock.calls[0][0];
    expect(body.success).toBe(false);
    expect(body.data).toBeUndefined();
    expect(body.error.type).toContain('price-not-found');
    expect(body.error.detail).toBe('no data');
    expect(next).not.toHaveBeenCalled();
  });

  it('maps an ApiError-shaped object to its AppError status', () => {
    const apiErr: ApiError = { status: 429, code: 'RATE_LIMITED', message: 'slow' };
    errorHandler(apiErr, makeReq(), res as unknown as Response, next);

    expect(res.status).toHaveBeenCalledWith(429);
    const body = res.json.mock.calls[0][0];
    expect(body.success).toBe(false);
    expect(body.error.type).toContain('rate-limited');
    expect(body.error.detail).toBe('slow');
  });

  it('falls back to 500 INTERNAL_ERROR for unknown errors and logs them', () => {
    errorHandler(new Error('boom'), makeReq(), res as unknown as Response, next);

    expect(res.status).toHaveBeenCalledWith(500);
    const body = res.json.mock.calls[0][0];
    expect(body.success).toBe(false);
    expect(body.error.type).toContain('internal-error');
    expect(body.error.detail).toBe('boom');
  });

  it('emits a structured log in all cases', () => {
    errorHandler(new AppError(ErrorCode.CONFLICT), makeReq(), res as unknown as Response, next);
    expect(logger.error).toHaveBeenCalled();
    expect((logger.error as ReturnType<typeof vi.fn>).mock.calls[0][1].code).toBe('CONFLICT');
  });
});

describe('notFoundHandler', () => {
  it('responds 404 with a NOT_FOUND discriminated error body', () => {
    const res = makeRes();
    notFoundHandler(makeReq({ path: '/api/v1/nope', method: 'POST' }), res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(404);
    const body = res.json.mock.calls[0][0];
    expect(body.success).toBe(false);
    expect(body.data).toBeUndefined();
    expect(body.error.type).toContain('not-found');
    expect(body.error.detail).toContain('not found');
    expect(body.error.instance).toBe('/api/v1/nope');
  });
});