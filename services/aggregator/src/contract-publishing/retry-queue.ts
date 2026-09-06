import { logger } from '../observability/logger';

export type RetryEvent = { key: string; submission: RetryableSubmission } & (
  | { event: 'retry'; attemptCount: number }
  | { event: 'failure'; reason: string }
);

export type RetryScheduledEvent = RetryEvent & { event: 'retry'; attemptCount: number };
export type RetryFailedEvent = RetryEvent & { event: 'failure'; reason: string };

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
        this.emit({
          event: 'failure',
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
        this.emit({
          event: 'retry',
          key,
          submission,
          attemptCount: submission.attemptCount,
        });
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

  private listeners: {
    retry: Array<(data: RetryScheduledEvent) => void>;
    failure: Array<(data: RetryFailedEvent) => void>;
  } = { retry: [], failure: [] };

  on(event: 'retry', handler: (data: RetryScheduledEvent) => void): void;
  on(event: 'failure', handler: (data: RetryFailedEvent) => void): void;
  on(
    event: 'retry' | 'failure',
    handler: ((data: RetryScheduledEvent) => void) | ((data: RetryFailedEvent) => void),
  ): void {
    this.listeners[event].push(handler as never);
  }

  private emit(data: RetryEvent): void {
    if (data.event === 'retry') {
      for (const handler of this.listeners.retry) {
        try {
          handler(data);
        } catch (err) {
          logger.error('[RetryQueue] Error in retry handler:', err);
        }
      }
    } else {
      for (const handler of this.listeners.failure) {
        try {
          handler(data);
        } catch (err) {
          logger.error('[RetryQueue] Error in failure handler:', err);
        }
      }
    }
  }
}
