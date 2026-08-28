import { logger } from '../observability/logger';

export interface RetryableSubmission {
  asset: string;
  price: bigint;
  decimals: number;
  timestamp: number;
  attemptCount: number;
  lastError?: string;
  nextRetryAt: number;
}

export interface RetryMetrics {
  totalQueued: number;
  totalRetried: number;
  totalFailed: number;
  averageRetries: number;
}

export class SubmissionRetryQueue {
  private queue: Map<string, RetryableSubmission> = new Map();
  private metrics: RetryMetrics = {
    totalQueued: 0,
    totalRetried: 0,
    totalFailed: 0,
    averageRetries: 0,
  };
  private maxRetries: number;
  private maxBackoffMs: number;
  private baseBackoffMs: number;
  private retryInterval: NodeJS.Timeout | null = null;

  constructor(options: {
    maxRetries?: number;
    baseBackoffMs?: number;
    maxBackoffMs?: number;
    checkIntervalMs?: number;
  } = {}) {
    this.maxRetries = options.maxRetries ?? 5;
    this.baseBackoffMs = options.baseBackoffMs ?? 1000;
    this.maxBackoffMs = options.maxBackoffMs ?? 60000;
  }

  start(): void {
    if (this.retryInterval) return;
    const checkIntervalMs = 5000;
    this.retryInterval = setInterval(() => {
      this.processQueue().catch((err) => {
        logger.error('[RetryQueue] Error processing queue:', err);
      });
    }, checkIntervalMs);
    this.retryInterval.unref?.();
    logger.info('[RetryQueue] Retry queue processor started');
  }

  stop(): void {
    if (this.retryInterval) {
      clearInterval(this.retryInterval);
      this.retryInterval = null;
    }
    logger.info('[RetryQueue] Retry queue processor stopped');
  }

  enqueue(submission: Omit<RetryableSubmission, 'attemptCount' | 'nextRetryAt'>): string {
    const key = `${submission.asset}:${submission.timestamp}`;
    const retry: RetryableSubmission = {
      ...submission,
      attemptCount: 0,
      nextRetryAt: Date.now(),
    };
    this.queue.set(key, retry);
    this.metrics.totalQueued++;
    logger.info(`[RetryQueue] Submission queued for ${submission.asset}`, {
      key,
      price: submission.price.toString(),
      queueSize: this.queue.size,
    });
    return key;
  }

  async processQueue(): Promise<void> {
    const now = Date.now();
    const readyItems: [string, RetryableSubmission][] = [];

    for (const [key, submission] of this.queue.entries()) {
      if (submission.nextRetryAt <= now) {
        readyItems.push([key, submission]);
      }
    }

    for (const [key, submission] of readyItems) {
      submission.attemptCount++;
      this.metrics.totalRetried++;

      if (submission.attemptCount > this.maxRetries) {
        this.queue.delete(key);
        this.metrics.totalFailed++;
        logger.error(`[RetryQueue] Max retries exceeded for ${submission.asset}`, {
          key,
          attemptCount: submission.attemptCount,
          lastError: submission.lastError,
        });
        this.emit('failure', {
          key,
          submission,
          reason: `Max retries (${this.maxRetries}) exceeded`,
        });
      } else {
        const backoffMs = this.calculateBackoff(submission.attemptCount);
        submission.nextRetryAt = now + backoffMs;
        logger.info(`[RetryQueue] Retry scheduled for ${submission.asset}`, {
          key,
          attemptCount: submission.attemptCount,
          nextRetryMs: backoffMs,
          queueSize: this.queue.size,
        });
        this.emit('retry', { key, submission, attemptCount: submission.attemptCount });
      }
    }

    this.updateMetrics();
  }

  private calculateBackoff(attemptCount: number): number {
    const exponential = this.baseBackoffMs * Math.pow(2, attemptCount - 1);
    const jitter = Math.random() * this.baseBackoffMs;
    const backoff = Math.min(exponential + jitter, this.maxBackoffMs);
    return Math.floor(backoff);
  }

  private updateMetrics(): void {
    if (this.metrics.totalRetried > 0) {
      this.metrics.averageRetries = (this.metrics.totalRetried + this.metrics.totalFailed) / this.metrics.totalQueued;
    }
  }

  getMetrics(): RetryMetrics {
    return { ...this.metrics };
  }

  getQueueSize(): number {
    return this.queue.size;
  }

  getQueueItems(): RetryableSubmission[] {
    return Array.from(this.queue.values());
  }

  getItem(key: string): RetryableSubmission | undefined {
    return this.queue.get(key);
  }

  remove(key: string): boolean {
    return this.queue.delete(key);
  }

  private listeners: Map<string, Array<(data: any) => void>> = new Map();

  on(event: 'retry' | 'failure', handler: (data: any) => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(handler);
  }

  private emit(event: string, data: any): void {
    const handlers = this.listeners.get(event) || [];
    for (const handler of handlers) {
      try {
        handler(data);
      } catch (err) {
        logger.error(`[RetryQueue] Error in ${event} handler:`, err);
      }
    }
  }
}
