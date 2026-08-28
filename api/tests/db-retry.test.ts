import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isTransientError, withRetry } from '../src/infrastructure/db-retry';

describe('db retry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('retries transient failures with exponential backoff and jitter', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }))
      .mockRejectedValueOnce(Object.assign(new Error('deadlock'), { code: '40P01' }))
      .mockResolvedValue('ok');
    const logger = { warn: vi.fn() } as any;

    const promise = withRetry(operation, { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 1_000 }, logger);

    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(100);

    await expect(promise).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('stops after max retries', async () => {
    const error = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    const operation = vi.fn().mockRejectedValue(error);

    const promise = withRetry(operation, { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 100 });
    const assertion = expect(promise).rejects.toBe(error);

    await vi.runAllTimersAsync();
    await assertion;
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('does not retry deterministic database errors', async () => {
    const error = Object.assign(new Error('duplicate key'), { code: '23505' });
    const operation = vi.fn().mockRejectedValue(error);

    await expect(withRetry(operation, { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 100 })).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('classifies transient postgres, system, and timeout message errors', () => {
    expect(isTransientError({ code: '08006' })).toBe(true);
    expect(isTransientError({ code: 'ECONNREFUSED' })).toBe(true);
    expect(isTransientError(new Error('pool connection timeout'))).toBe(true);
    expect(isTransientError({ code: '23505' })).toBe(false);
  });
});
