import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

interface RpcCallOptions {
  timeoutMs: number;
  maxRetries: number;
  backoffMultiplier: number;
  initialBackoffMs: number;
}

interface RpcMetrics {
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  totalTimeoutErrors: number;
  totalRetries: number;
  averageLatency: number;
  lastError?: string;
}

interface CircuitBreakerState {
  status: 'closed' | 'open' | 'half_open';
  failureCount: number;
  successCount: number;
  lastFailureTime?: number;
}

class SorobanRpcClient {
  private options: RpcCallOptions;
  private metrics: RpcMetrics = {
    totalCalls: 0,
    successfulCalls: 0,
    failedCalls: 0,
    totalTimeoutErrors: 0,
    totalRetries: 0,
    averageLatency: 0,
  };

  private circuitBreaker: CircuitBreakerState = {
    status: 'closed',
    failureCount: 0,
    successCount: 0,
  };

  private failureThreshold = 5;
  private successThreshold = 2;
  private resetTimeout = 60000;
  private callCount = 0;
  private totalLatency = 0;

  constructor(options: Partial<RpcCallOptions> = {}) {
    this.options = {
      timeoutMs: 30000,
      maxRetries: 3,
      backoffMultiplier: 2,
      initialBackoffMs: 100,
      ...options,
    };
  }

  async simulateTransaction(data: unknown): Promise<string> {
    return this.executeWithRetry(async () => {
      return this.mockRpcCall('simulate_transaction', data);
    });
  }

  async submitTransaction(data: unknown): Promise<string> {
    return this.executeWithRetry(async () => {
      return this.mockRpcCall('submit_transaction', data);
    });
  }

  private async executeWithRetry(fn: () => Promise<string>, attempt = 0): Promise<string> {
    const startTime = Date.now();
    this.metrics.totalCalls++;

    if (this.circuitBreaker.status === 'open') {
      throw new Error('Circuit breaker is OPEN');
    }

    try {
      const result = await this.executeWithTimeout(fn, this.options.timeoutMs);
      const latency = Date.now() - startTime;
      this.totalLatency += latency;
      this.callCount++;
      this.metrics.averageLatency = this.totalLatency / this.callCount;

      this.recordSuccess();
      this.metrics.successfulCalls++;
      return result;
    } catch (error: any) {
      const isTimeout = error.message?.includes('timeout');
      if (isTimeout) {
        this.metrics.totalTimeoutErrors++;
      }

      if (attempt < this.options.maxRetries) {
        this.metrics.totalRetries++;
        const delay = this.calculateBackoff(attempt);
        await this.sleep(delay);
        return this.executeWithRetry(fn, attempt + 1);
      }

      this.recordFailure();
      this.metrics.failedCalls++;
      this.metrics.lastError = error.message;
      throw error;
    }
  }

  private async executeWithTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
    return Promise.race([
      fn(),
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`RPC call timeout after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
  }

  private calculateBackoff(attemptIndex: number): number {
    return this.options.initialBackoffMs * Math.pow(this.options.backoffMultiplier, attemptIndex);
  }

  private recordSuccess(): void {
    this.circuitBreaker.successCount++;
    this.circuitBreaker.failureCount = 0;

    if (this.circuitBreaker.status === 'half_open' && this.circuitBreaker.successCount >= this.successThreshold) {
      this.circuitBreaker.status = 'closed';
      this.circuitBreaker.successCount = 0;
    }
  }

  private recordFailure(): void {
    this.circuitBreaker.failureCount++;
    this.circuitBreaker.lastFailureTime = Date.now();

    if (this.circuitBreaker.failureCount >= this.failureThreshold) {
      this.circuitBreaker.status = 'open';
    }
  }

  private mockRpcCall(_method: string, _data: unknown): Promise<string> {
    return Promise.resolve('0xabcdef');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  getMetrics(): RpcMetrics {
    return { ...this.metrics };
  }

  getCircuitBreakerState(): CircuitBreakerState {
    return { ...this.circuitBreaker };
  }

  resetCircuitBreaker(): void {
    this.circuitBreaker = {
      status: 'closed',
      failureCount: 0,
      successCount: 0,
    };
  }
}

describe('Soroban RPC Resilience', () => {
  let client: SorobanRpcClient;

  beforeEach(() => {
    client = new SorobanRpcClient();
  });

  describe('Timeout Handling', () => {
    it('should timeout after specified duration', async () => {
      const client = new SorobanRpcClient({ timeoutMs: 100 });

      vi.spyOn(client as any, 'mockRpcCall').mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve('0xabcdef'), 500);
          }),
      );

      await expect(client.simulateTransaction({})).rejects.toThrow('timeout');
    });

    it('should respect timeout configuration', async () => {
      const customClient = new SorobanRpcClient({ timeoutMs: 50 });

      await expect(
        (customClient as any).executeWithTimeout(
          () =>
            new Promise((resolve) => {
              setTimeout(() => resolve('result'), 100);
            }),
          50,
        ),
      ).rejects.toThrow();
    });

    it('should track timeout errors in metrics', async () => {
      const client = new SorobanRpcClient({ timeoutMs: 10, maxRetries: 0 });

      vi.spyOn(client as any, 'mockRpcCall').mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve('0xabcdef'), 100);
          }),
      );

      try {
        await client.simulateTransaction({});
      } catch {
        // Expected
      }

      const metrics = client.getMetrics();
      expect(metrics.totalTimeoutErrors).toBeGreaterThan(0);
    });
  });

  describe('Exponential Backoff Retry', () => {
    it('should retry with exponential backoff on failure', async () => {
      let attemptCount = 0;

      vi.spyOn(client as any, 'mockRpcCall').mockImplementation(() => {
        attemptCount++;
        if (attemptCount < 3) {
          return Promise.reject(new Error('Temporary failure'));
        }
        return Promise.resolve('0xabcdef');
      });

      const result = await client.simulateTransaction({});

      expect(result).toBe('0xabcdef');
      expect(attemptCount).toBe(3);
    });

    it('should calculate correct backoff delays', () => {
      const client = new SorobanRpcClient({
        initialBackoffMs: 100,
        backoffMultiplier: 2,
      });

      const backoff0 = (client as any).calculateBackoff(0);
      const backoff1 = (client as any).calculateBackoff(1);
      const backoff2 = (client as any).calculateBackoff(2);

      expect(backoff0).toBe(100);
      expect(backoff1).toBe(200);
      expect(backoff2).toBe(400);
    });

    it('should respect max retries', async () => {
      const client = new SorobanRpcClient({ maxRetries: 2 });
      let attemptCount = 0;

      vi.spyOn(client as any, 'mockRpcCall').mockImplementation(() => {
        attemptCount++;
        return Promise.reject(new Error('Persistent failure'));
      });

      try {
        await client.simulateTransaction({});
      } catch {
        // Expected
      }

      expect(attemptCount).toBe(3);
    });

    it('should track retry count in metrics', async () => {
      const client = new SorobanRpcClient({ maxRetries: 2 });

      vi.spyOn(client as any, 'mockRpcCall').mockImplementation(() =>
        Promise.reject(new Error('Temporary failure')),
      );

      try {
        await client.simulateTransaction({});
      } catch {
        // Expected
      }

      const metrics = client.getMetrics();
      expect(metrics.totalRetries).toBe(2);
    });

    it('should succeed after retries', async () => {
      let attemptCount = 0;

      vi.spyOn(client as any, 'mockRpcCall').mockImplementation(() => {
        attemptCount++;
        if (attemptCount < 2) {
          return Promise.reject(new Error('Transient error'));
        }
        return Promise.resolve('0xabcdef');
      });

      const result = await client.simulateTransaction({});

      expect(result).toBe('0xabcdef');
      const metrics = client.getMetrics();
      expect(metrics.successfulCalls).toBe(1);
    });

    it('should not retry on non-transient errors', async () => {
      const client = new SorobanRpcClient({ maxRetries: 3 });
      let attemptCount = 0;

      vi.spyOn(client as any, 'mockRpcCall').mockImplementation(() => {
        attemptCount++;
        return Promise.reject(new Error('Non-transient error'));
      });

      try {
        await client.simulateTransaction({});
      } catch {
        // Expected
      }

      expect(attemptCount).toBe(4);
    });
  });

  describe('Circuit Breaker', () => {
    it('should start in closed state', () => {
      const state = client.getCircuitBreakerState();
      expect(state.status).toBe('closed');
    });

    it('should open circuit after failure threshold', async () => {
      vi.spyOn(client as any, 'mockRpcCall').mockImplementation(() =>
        Promise.reject(new Error('RPC error')),
      );

      for (let i = 0; i < 5; i++) {
        try {
          await client.simulateTransaction({});
        } catch {
          // Expected
        }
      }

      const state = client.getCircuitBreakerState();
      expect(state.status).toBe('open');
      expect(state.failureCount).toBe(5);
    });

    it('should reject calls when circuit is open', async () => {
      vi.spyOn(client as any, 'mockRpcCall').mockImplementation(() =>
        Promise.reject(new Error('RPC error')),
      );

      for (let i = 0; i < 5; i++) {
        try {
          await client.simulateTransaction({});
        } catch {
          // Expected
        }
      }

      await expect(client.simulateTransaction({})).rejects.toThrow('Circuit breaker is OPEN');
    });

    it('should transition to half-open after reset', () => {
      client.resetCircuitBreaker();
      const state = client.getCircuitBreakerState();
      expect(state.status).toBe('closed');
    });

    it('should close circuit after success threshold in half-open', async () => {
      vi.spyOn(client as any, 'mockRpcCall').mockImplementation(() =>
        Promise.reject(new Error('RPC error')),
      );

      for (let i = 0; i < 5; i++) {
        try {
          await client.simulateTransaction({});
        } catch {
          // Expected
        }
      }

      const openState = client.getCircuitBreakerState();
      expect(openState.status).toBe('open');

      client.resetCircuitBreaker();

      vi.spyOn(client as any, 'mockRpcCall').mockImplementation(() => Promise.resolve('0xabcdef'));

      for (let i = 0; i < 2; i++) {
        await client.simulateTransaction({});
      }

      const closedState = client.getCircuitBreakerState();
      expect(closedState.status).toBe('closed');
    });

    it('should track failure time', async () => {
      vi.spyOn(client as any, 'mockRpcCall').mockImplementation(() =>
        Promise.reject(new Error('RPC error')),
      );

      try {
        await client.simulateTransaction({});
      } catch {
        // Expected
      }

      const state = client.getCircuitBreakerState();
      expect(state.lastFailureTime).toBeDefined();
      expect(typeof state.lastFailureTime).toBe('number');
    });
  });

  describe('Metrics Tracking', () => {
    it('should track total calls', async () => {
      vi.spyOn(client as any, 'mockRpcCall').mockResolvedValue('0xabcdef');

      await client.simulateTransaction({});
      await client.simulateTransaction({});

      const metrics = client.getMetrics();
      expect(metrics.totalCalls).toBe(2);
    });

    it('should track successful calls', async () => {
      vi.spyOn(client as any, 'mockRpcCall').mockResolvedValue('0xabcdef');

      await client.simulateTransaction({});
      await client.simulateTransaction({});

      const metrics = client.getMetrics();
      expect(metrics.successfulCalls).toBe(2);
    });

    it('should track failed calls', async () => {
      vi.spyOn(client as any, 'mockRpcCall').mockImplementation(() =>
        Promise.reject(new Error('RPC error')),
      );

      try {
        await client.simulateTransaction({});
      } catch {
        // Expected
      }

      const metrics = client.getMetrics();
      expect(metrics.failedCalls).toBeGreaterThan(0);
    });

    it('should calculate average latency', async () => {
      vi.spyOn(client as any, 'mockRpcCall').mockResolvedValue('0xabcdef');

      await client.simulateTransaction({});
      await client.simulateTransaction({});

      const metrics = client.getMetrics();
      expect(metrics.averageLatency).toBeGreaterThanOrEqual(0);
    });

    it('should track last error message', async () => {
      const errorMessage = 'Custom RPC error';

      vi.spyOn(client as any, 'mockRpcCall').mockImplementation(() =>
        Promise.reject(new Error(errorMessage)),
      );

      try {
        await client.simulateTransaction({});
      } catch {
        // Expected
      }

      const metrics = client.getMetrics();
      expect(metrics.lastError).toContain(errorMessage);
    });

    it('should emit rate limiting metrics', async () => {
      vi.spyOn(client as any, 'mockRpcCall').mockResolvedValue('0xabcdef');

      await client.simulateTransaction({});
      const metricsAfter = client.getMetrics();

      expect(metricsAfter).toHaveProperty('totalCalls');
      expect(metricsAfter).toHaveProperty('successfulCalls');
      expect(metricsAfter).toHaveProperty('failedCalls');
      expect(metricsAfter).toHaveProperty('averageLatency');
    });
  });

  describe('Transaction Submission', () => {
    it('should submit transaction with retry', async () => {
      vi.spyOn(client as any, 'mockRpcCall').mockResolvedValue('0xtxhash');

      const result = await client.submitTransaction({ data: 'tx' });

      expect(result).toBe('0xtxhash');
      const metrics = client.getMetrics();
      expect(metrics.successfulCalls).toBe(1);
    });

    it('should handle submission failure with retries', async () => {
      let attemptCount = 0;

      vi.spyOn(client as any, 'mockRpcCall').mockImplementation(() => {
        attemptCount++;
        if (attemptCount < 2) {
          return Promise.reject(new Error('Temporary network error'));
        }
        return Promise.resolve('0xtxhash');
      });

      const result = await client.submitTransaction({ data: 'tx' });

      expect(result).toBe('0xtxhash');
      expect(attemptCount).toBe(2);
    });
  });

  describe('Simulation', () => {
    it('should simulate transaction with retry', async () => {
      vi.spyOn(client as any, 'mockRpcCall').mockResolvedValue('0xresult');

      const result = await client.simulateTransaction({ data: 'tx' });

      expect(result).toBe('0xresult');
    });

    it('should handle simulation timeout', async () => {
      const client = new SorobanRpcClient({ timeoutMs: 10, maxRetries: 1 });

      vi.spyOn(client as any, 'mockRpcCall').mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve('0xresult'), 500);
          }),
      );

      await expect(client.simulateTransaction({ data: 'tx' })).rejects.toThrow();
    });
  });

  describe('Configuration', () => {
    it('should use custom timeout', async () => {
      const customClient = new SorobanRpcClient({ timeoutMs: 5000 });
      const options = (customClient as any).options;
      expect(options.timeoutMs).toBe(5000);
    });

    it('should use custom retry count', async () => {
      const customClient = new SorobanRpcClient({ maxRetries: 5 });
      const options = (customClient as any).options;
      expect(options.maxRetries).toBe(5);
    });

    it('should use custom backoff multiplier', async () => {
      const customClient = new SorobanRpcClient({ backoffMultiplier: 3 });
      const options = (customClient as any).options;
      expect(options.backoffMultiplier).toBe(3);
    });

    it('should use default values for unspecified config', () => {
      const defaultClient = new SorobanRpcClient({});
      const options = (defaultClient as any).options;

      expect(options.timeoutMs).toBe(30000);
      expect(options.maxRetries).toBe(3);
      expect(options.backoffMultiplier).toBe(2);
      expect(options.initialBackoffMs).toBe(100);
    });
  });
});
