import { describe, it, expect, vi } from 'vitest';
import { CircuitOpenError, DbCircuitBreaker } from '../src/infrastructure/db-circuit-breaker';

const config = {
  enabled: true,
  failureThreshold: 2,
  successThreshold: 2,
  openMs: 1_000,
};

describe('DbCircuitBreaker', () => {
  it('opens after the configured failure threshold and fails fast while open', async () => {
    let now = 0;
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as any;
    const breaker = new DbCircuitBreaker('primary', config, logger, () => now);
    const error = new Error('db down');

    await expect(breaker.execute(() => Promise.reject(error))).rejects.toBe(error);
    await expect(breaker.execute(() => Promise.reject(error))).rejects.toBe(error);

    expect(breaker.getState()).toBe('open');
    expect(breaker.getStateCode()).toBe(2);
    expect(logger.error).toHaveBeenCalledWith('Database circuit breaker "primary" opened');
    await expect(breaker.execute(() => Promise.resolve('skipped'))).rejects.toBeInstanceOf(CircuitOpenError);

    now = 999;
    await expect(breaker.execute(() => Promise.resolve('still skipped'))).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it('moves half-open after open timeout and closes after enough successful probes', async () => {
    let now = 0;
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as any;
    const breaker = new DbCircuitBreaker('replica', config, logger, () => now);

    await expect(breaker.execute(() => Promise.reject(new Error('one')))).rejects.toThrow('one');
    await expect(breaker.execute(() => Promise.reject(new Error('two')))).rejects.toThrow('two');

    now = 1_000;
    await expect(breaker.execute(() => Promise.resolve('probe-1'))).resolves.toBe('probe-1');
    expect(breaker.getState()).toBe('half-open');
    expect(breaker.getStateCode()).toBe(1);

    await expect(breaker.execute(() => Promise.resolve('probe-2'))).resolves.toBe('probe-2');
    expect(breaker.getState()).toBe('closed');
    expect(breaker.getStateCode()).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith('Database circuit breaker "replica" half-open (probing)');
    expect(logger.info).toHaveBeenCalledWith('Database circuit breaker "replica" closed');
  });

  it('reopens immediately when a half-open probe fails', async () => {
    let now = 0;
    const breaker = new DbCircuitBreaker('replica', config, undefined, () => now);

    await expect(breaker.execute(() => Promise.reject(new Error('one')))).rejects.toThrow('one');
    await expect(breaker.execute(() => Promise.reject(new Error('two')))).rejects.toThrow('two');

    now = 1_000;
    await expect(breaker.execute(() => Promise.reject(new Error('probe failed')))).rejects.toThrow('probe failed');

    expect(breaker.getState()).toBe('open');
    expect(breaker.getStateCode()).toBe(2);
  });

  it('bypasses state tracking when disabled', async () => {
    const breaker = new DbCircuitBreaker('disabled', { ...config, enabled: false });

    await expect(breaker.execute(() => Promise.resolve('ok'))).resolves.toBe('ok');
    await expect(breaker.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow('fail');

    expect(breaker.getState()).toBe('closed');
    expect(breaker.getStateCode()).toBe(0);
  });
});
