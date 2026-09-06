/**
 * #302 — Discriminated unions for all API response types.
 *
 * The helpers in src/infrastructure/response.ts return objects whose
 * `success` field (top-level for v1, `meta.success` for v2) acts as a proper
 * discriminant: a success response always carries `data` and never `error`,
 * and a failure response always carries `error` and never `data`. These tests
 * pin that contract at runtime.
 */

import { describe, it, expect } from 'vitest';
import {
  ok,
  okCached,
  fail,
  v2Ok,
  v2Fail,
  type Envelope,
  type V2Envelope,
  type OkEnvelope,
  type FailEnvelope,
} from '../src/infrastructure/response';
import { AppError, createError } from '../src/infrastructure/app-error';
import { ErrorCode } from '../src/infrastructure/catalog';

describe('v1 discriminated envelope builders', () => {
  it('ok() narrows to success with data and no error', () => {
    const response: Envelope<{ price: string }> = ok({ price: '1.25' });
    expect(response.success).toBe(true);
    // Discriminant narrowing: success => data present, error absent.
    if (response.success) {
      expect(response.data).toEqual({ price: '1.25' });
      expect(response.error).toBeUndefined();
    }
  });

  it('okCached() marks cached:true', () => {
    const response = okCached({ price: '1.25' }) as OkEnvelope<{ price: string }>;
    expect(response.success).toBe(true);
    expect(response.cached).toBe(true);
    expect(response.error).toBeUndefined();
  });

  it('fail() narrows to error and never data', () => {
    const response: Envelope<never> = fail({ code: 'NOT_FOUND', message: 'nope' });
    expect(response.success).toBe(false);
    if (!response.success) {
      expect(response.error).toEqual({ code: 'NOT_FOUND', message: 'nope' });
      expect(response.data).toBeUndefined();
    }
  });

  it('success and failure envelopes are mutually discriminable', () => {
    const okR: Envelope<number> = ok(7);
    const failR: Envelope<number> = fail({ code: 'X' });
    expect(okR.success).toBe(true);
    expect(failR.success).toBe(false);
  });

  it('AppError.toResponseObject() satisfies the failure envelope type', () => {
    const err = createError(ErrorCode.FORBIDDEN, 'denied');
    const body = err.toResponseObject();
    const asUnion: Envelope<unknown> = body;
    expect(asUnion.success).toBe(false);
    if (!asUnion.success) {
      expect(asUnion.error.type).toContain('forbidden');
    }
  });
});

describe('v2 discriminated envelope builders', () => {
  it('v2Ok() sets meta.success=true with data and no error', () => {
    const response: V2Envelope<{ count: number }> = v2Ok({ count: 2 });
    expect(response.meta.success).toBe(true);
    if (response.meta.success) {
      expect(response.data).toEqual({ count: 2 });
      expect(response.error).toBeUndefined();
    }
  });

  it('v2Ok(data, true) marks the meta as cached', () => {
    const response = v2Ok({ count: 2 }, true);
    expect(response.meta.cached).toBe(true);
  });

  it('v2Fail() sets meta.success=false with error and no data', () => {
    const response: V2Envelope<unknown> = v2Fail({
      code: 'INVALID_INPUT',
      message: 'bad',
    });
    expect(response.meta.success).toBe(false);
    if (!response.meta.success) {
      expect(response.error.code).toBe('INVALID_INPUT');
      expect(response.data).toBeUndefined();
    }
  });

  it('keeps the versioned meta shape', () => {
    expect(v2Ok({}).meta.version).toBe('2');
    expect(v2Fail({ code: 'X' }).meta.version).toBe('2');
  });
});