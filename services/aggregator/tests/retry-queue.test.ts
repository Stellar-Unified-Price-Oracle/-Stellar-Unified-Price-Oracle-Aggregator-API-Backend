import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { SubmissionRetryQueue } from '../src/contract-publishing/retry-queue';

describe('Submission Retry Queue (Issue #227)', () => {
  let queue: SubmissionRetryQueue;

  beforeAll(() => {
    queue = new SubmissionRetryQueue({
      maxRetries: 3,
      baseBackoffMs: 100,
      maxBackoffMs: 1000,
    });
    queue.start();
  });

  afterAll(() => {
    queue.stop();
  });

  it('should enqueue a submission and track it', () => {
    const key = queue.enqueue({
      asset: 'BTC',
      price: BigInt('43500'),
      decimals: 8,
      timestamp: Math.floor(Date.now() / 1000),
    });

    expect(key).toBeDefined();
    expect(queue.getQueueSize()).toBe(1);

    const item = queue.getItem(key);
    expect(item).toBeDefined();
    expect(item?.asset).toBe('BTC');
    expect(item?.attemptCount).toBe(0);
  });

  it('should calculate exponential backoff correctly', async () => {
    const submission = {
      asset: 'ETH',
      price: BigInt('2250'),
      decimals: 8,
      timestamp: Math.floor(Date.now() / 1000),
    };

    const key = queue.enqueue(submission);
    await queue.processQueue();

    const item = queue.getItem(key);
    expect(item?.attemptCount).toBe(1);
    expect(item?.nextRetryAt).toBeGreaterThan(Date.now());
  });

  it('should track metrics correctly', () => {
    queue.enqueue({
      asset: 'XLM',
      price: BigInt('250'),
      decimals: 8,
      timestamp: Math.floor(Date.now() / 1000),
    });

    const metrics = queue.getMetrics();
    expect(metrics.totalQueued).toBeGreaterThan(0);
    expect(metrics.totalRetried).toBeGreaterThanOrEqual(0);
    expect(metrics.totalFailed).toBeGreaterThanOrEqual(0);
  });

  it('should emit retry events when retry is scheduled', async () => {
    let retryEventEmitted = false;
    const handler = () => {
      retryEventEmitted = true;
    };

    queue.on('retry', handler);

    const key = queue.enqueue({
      asset: 'USDC',
      price: BigInt('1'),
      decimals: 6,
      timestamp: Math.floor(Date.now() / 1000),
    });

    await queue.processQueue();

    expect(retryEventEmitted).toBe(true);
  });

  it('should remove item after max retries exceeded', async () => {
    const queue2 = new SubmissionRetryQueue({
      maxRetries: 2,
      baseBackoffMs: 10,
      maxBackoffMs: 100,
    });
    queue2.start();

    let failureEventEmitted = false;
    queue2.on('failure', () => {
      failureEventEmitted = true;
    });

    const key = queue2.enqueue({
      asset: 'TEST',
      price: BigInt('100'),
      decimals: 8,
      timestamp: Math.floor(Date.now() / 1000),
    });

    for (let i = 0; i < 4; i++) {
      await queue2.processQueue();
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    expect(failureEventEmitted).toBe(true);
    expect(queue2.getItem(key)).toBeUndefined();
    queue2.stop();
  });

  it('should handle multiple concurrent submissions', () => {
    const queue2 = new SubmissionRetryQueue();
    queue2.start();

    const keys = [];
    for (let i = 0; i < 5; i++) {
      const key = queue2.enqueue({
        asset: `ASSET${i}`,
        price: BigInt(1000 + i),
        decimals: 8,
        timestamp: Math.floor(Date.now() / 1000),
      });
      keys.push(key);
    }

    expect(queue2.getQueueSize()).toBe(5);
    expect(queue2.getQueueItems().length).toBe(5);

    queue2.stop();
  });

  it('should calculate jittered exponential backoff', async () => {
    vi.useFakeTimers();
    try {
      const queue2 = new SubmissionRetryQueue({
        baseBackoffMs: 1000,
        maxBackoffMs: 30000,
      });

      const key = queue2.enqueue({
        asset: 'BACKOFF_TEST',
        price: BigInt('1000'),
        decimals: 8,
        timestamp: Math.floor(Date.now() / 1000),
      });

      await queue2.processQueue();
      const item2 = queue2.getItem(key)!;

      // Attempt 1: exponential = 1000, jitter in [0, 1000) -> [1000, 2000).
      const backoff1 = item2.nextRetryAt - Date.now();
      expect(backoff1).toBeGreaterThanOrEqual(1000);
      expect(backoff1).toBeLessThan(2000);

      // Advance past the first retry time, then process again.
      vi.advanceTimersByTime(backoff1 + 1);
      await queue2.processQueue();

      const item3 = queue2.getItem(key);
      expect(item3).toBeDefined();

      // Attempt 2: exponential = 2000, jitter in [0, 1000) -> [2000, 3000).
      const backoff2 = item3!.nextRetryAt - Date.now();
      expect(backoff2).toBeGreaterThanOrEqual(2000);
      expect(backoff2).toBeLessThan(3000);

      queue2.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('should allow manual removal of items', () => {
    const key = queue.enqueue({
      asset: 'REMOVE_TEST',
      price: BigInt('100'),
      decimals: 8,
      timestamp: Math.floor(Date.now() / 1000),
    });

    expect(queue.getItem(key)).toBeDefined();
    const removed = queue.remove(key);
    expect(removed).toBe(true);
    expect(queue.getItem(key)).toBeUndefined();
  });

  it('should return all queue items', () => {
    const queue2 = new SubmissionRetryQueue();
    const key1 = queue2.enqueue({
      asset: 'ITEM1',
      price: BigInt('100'),
      decimals: 8,
      timestamp: Math.floor(Date.now() / 1000),
    });

    const key2 = queue2.enqueue({
      asset: 'ITEM2',
      price: BigInt('200'),
      decimals: 8,
      timestamp: Math.floor(Date.now() / 1000),
    });

    const items = queue2.getQueueItems();
    expect(items.length).toBe(2);
    expect(items.map(i => i.asset)).toContain('ITEM1');
    expect(items.map(i => i.asset)).toContain('ITEM2');
  });
});
