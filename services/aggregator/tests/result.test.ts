import { describe, it, expect } from 'vitest';
import { ok, err, isOk, isErr, unwrapOr, tryCatch, tryCatchAsync } from '../src/infrastructure/result';

describe('Result type helpers (issue #299)', () => {
  it('constructs ok and err results', () => {
    expect(ok(42)).toEqual({ ok: true, value: 42 });
    expect(err(new Error('boom'))).toEqual({ ok: false, error: expect.any(Error) });
  });

  it('narrows with isOk/isErr', () => {
    const a = ok('x');
    const b = err(new Error('y'));
    expect(isOk(a)).toBe(true);
    expect(isErr(a)).toBe(false);
    expect(isOk(b)).toBe(false);
    expect(isErr(b)).toBe(true);
  });

  it('unwrapOr falls back on failure', () => {
    expect(unwrapOr(ok(5), 0)).toBe(5);
    expect(unwrapOr(err(new Error('nope')), 0)).toBe(0);
  });

  it('tryCatch wraps throwing functions', () => {
    const throwing = (): number => { throw new Error('kaboom'); };
    const success = (): number => 7;

    expect(tryCatch(success)).toEqual({ ok: true, value: 7 });
    const failed = tryCatch(throwing);
    expect(isErr(failed)).toBe(true);
    if (isErr(failed)) expect(failed.error.message).toBe('kaboom');
  });

  it('tryCatch normalizes non-Error throws', () => {
    const failed = tryCatch(() => { throw 'string error'; });
    expect(isErr(failed)).toBe(true);
    if (isErr(failed)) expect(failed.error.message).toBe('string error');
  });

  it('tryCatchAsync wraps async functions', async () => {
    const okResult = await tryCatchAsync(async () => 'done');
    expect(okResult).toEqual({ ok: true, value: 'done' });

    const failed = await tryCatchAsync(async () => {
      throw new Error('async boom');
    });
    expect(isErr(failed)).toBe(true);
    if (isErr(failed)) expect(failed.error.message).toBe('async boom');
  });
});
