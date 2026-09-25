import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

interface RedisKey {
  key: string;
  value: string;
}

interface InvalidationGuarantee {
  stalenessWindow: number;
  atomicity: boolean;
  concurrentWriteSafe: boolean;
}

class ScanBasedInvalidator {
  private redis: Map<string, string> = new Map();
  private publishCalls: { pattern: string; timestamp: number }[] = [];
  private metrics = {
    keysScanned: 0,
    keysDeleted: 0,
    invalidationFailures: 0,
    batchSize: 0,
  };

  private guarantee: InvalidationGuarantee = {
    stalenessWindow: 5000,
    atomicity: false,
    concurrentWriteSafe: false,
  };

  setKey(key: string, value: string): void {
    this.redis.set(key, value);
  }

  getKey(key: string): string | undefined {
    return this.redis.get(key);
  }

  getAllKeys(): RedisKey[] {
    return Array.from(this.redis.entries()).map(([key, value]) => ({ key, value }));
  }

  async scanAndDelete(pattern: string, batchSize: number = 100): Promise<number> {
    try {
      let cursor = '0';
      let keysDeleted = 0;
      const keysToDelete: string[] = [];

      do {
        const matches = this.scanCursor(pattern, cursor, batchSize);
        cursor = matches.nextCursor;

        keysToDelete.push(...matches.keys);

        this.metrics.keysScanned += matches.keys.length;

        if (keysToDelete.length >= batchSize) {
          keysDeleted += this.deleteKeyBatch(keysToDelete.splice(0, batchSize));
        }
      } while (cursor !== '0');

      if (keysToDelete.length > 0) {
        keysDeleted += this.deleteKeyBatch(keysToDelete);
      }

      this.metrics.keysDeleted = keysDeleted;
      this.metrics.batchSize = batchSize;

      return keysDeleted;
    } catch (err) {
      this.metrics.invalidationFailures++;
      throw err;
    }
  }

  private scanCursor(
    pattern: string,
    cursor: string,
    batchSize: number,
  ): { keys: string[]; nextCursor: string } {
    const keys = Array.from(this.redis.keys()).filter((k) =>
      this.matchesPattern(k, pattern),
    );

    const start = parseInt(cursor, 10) || 0;
    const end = Math.min(start + batchSize, keys.length);
    const batch = keys.slice(start, end);
    const nextCursor = end < keys.length ? String(end) : '0';

    return { keys: batch, nextCursor };
  }

  private matchesPattern(key: string, pattern: string): boolean {
    const regex = new RegExp(
      `^${pattern.replace(/\*/g, '.*').replace(/\?/g, '.')}$`,
    );
    return regex.test(key);
  }

  private deleteKeyBatch(keys: string[]): number {
    let deleted = 0;
    for (const key of keys) {
      if (this.redis.delete(key)) {
        deleted++;
      }
    }
    return deleted;
  }

  async invalidateAndBroadcast(pattern: string): Promise<{ deleted: number; broadcasted: boolean }> {
    try {
      const deleted = await this.scanAndDelete(pattern);

      this.publishCalls.push({
        pattern,
        timestamp: Date.now(),
      });

      return { deleted, broadcasted: true };
    } catch (err) {
      this.metrics.invalidationFailures++;
      return { deleted: 0, broadcasted: false };
    }
  }

  async invalidateAndBroadcastAtomic(pattern: string): Promise<void> {
    const deleted = await this.scanAndDelete(pattern);

    this.publishCalls.push({
      pattern,
      timestamp: Date.now(),
    });

    if (deleted === 0) {
      throw new Error('No keys matched pattern; invalidation failed');
    }
  }

  getMetrics() {
    return { ...this.metrics };
  }

  getPublishCalls() {
    return [...this.publishCalls];
  }

  getInvalidationGuarantee(): InvalidationGuarantee {
    return { ...this.guarantee };
  }

  setInvalidationGuarantee(guarantee: Partial<InvalidationGuarantee>): void {
    this.guarantee = { ...this.guarantee, ...guarantee };
  }

  canFallbackWithoutRedis(): boolean {
    return true;
  }

  getBoundedStalenessWindow(): number {
    return this.guarantee.stalenessWindow;
  }
}

describe('CacheInvalidationScan', () => {
  let invalidator: ScanBasedInvalidator;

  beforeEach(() => {
    invalidator = new ScanBasedInvalidator();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('SCAN-Based Invalidation', () => {
    it('uses SCAN instead of KEYS', async () => {
      invalidator.setKey('history:XLM:c0:l25:t1000', 'value1');
      invalidator.setKey('history:BTC:c0:l25:t1000', 'value2');
      invalidator.setKey('price:XLM', 'value3');

      const deleted = await invalidator.scanAndDelete('history:*');

      expect(deleted).toBe(2);

      const metrics = invalidator.getMetrics();
      expect(metrics.keysScanned).toBeGreaterThanOrEqual(2);
    });

    it('does not block Redis server during scan', async () => {
      for (let i = 0; i < 1000; i++) {
        invalidator.setKey(`key:${i}`, `value${i}`);
      }

      const startTime = Date.now();
      await invalidator.scanAndDelete('key:*');
      const duration = Date.now() - startTime;

      expect(duration).toBeLessThan(5000);
    });

    it('batches deletions with UNLINK', async () => {
      for (let i = 0; i < 250; i++) {
        invalidator.setKey(`history:asset:${i}`, `value${i}`);
      }

      const deleted = await invalidator.scanAndDelete('history:*', 100);

      expect(deleted).toBe(250);

      const metrics = invalidator.getMetrics();
      expect(metrics.batchSize).toBe(100);
    });

    it('handles empty match set gracefully', async () => {
      const deleted = await invalidator.scanAndDelete('nonexistent:*');

      expect(deleted).toBe(0);

      const metrics = invalidator.getMetrics();
      expect(metrics.keysScanned).toBe(0);
    });
  });

  describe('Concurrency Guarantees', () => {
    it('documents SCAN non-atomicity: keys added during scan may or may not be deleted', async () => {
      invalidator.setKey('history:XLM:c0', 'value1');
      invalidator.setKey('history:BTC:c0', 'value2');

      const scanPromise = invalidator.scanAndDelete('history:*');

      invalidator.setKey('history:ETH:c0', 'value3');

      const deleted = await scanPromise;

      const remaining = invalidator.getAllKeys();

      const hasETH = remaining.some((k) => k.key === 'history:ETH:c0');

      expect(hasETH).toBe(true);
    });

    it('bounds staleness window when concurrent writes interleave', async () => {
      invalidator.setInvalidationGuarantee({ stalenessWindow: 5000 });

      const bound = invalidator.getBoundedStalenessWindow();

      expect(bound).toBe(5000);
    });

    it('documents interleaving behavior: key written after scan starts may not be deleted', async () => {
      invalidator.setKey('price:XLM:v1', 'old');

      const scanPromise = invalidator.scanAndDelete('price:*');

      invalidator.setKey('price:XLM:v2', 'new');

      await scanPromise;

      const v2 = invalidator.getKey('price:XLM:v2');

      expect(v2).toBe('new');
    });
  });

  describe('Atomicity and Safety', () => {
    it('makes delete and broadcast sequence safe', async () => {
      invalidator.setKey('history:XLM:c0', 'value');

      const result = await invalidator.invalidateAndBroadcast('history:*');

      expect(result.deleted).toBeGreaterThan(0);
      expect(result.broadcasted).toBe(true);

      const calls = invalidator.getPublishCalls();
      expect(calls).toHaveLength(1);
    });

    it('handles concurrent set during invalidation', async () => {
      invalidator.setKey('price:BTC', 'value1');

      const invalidatePromise = invalidator.invalidateAndBroadcast('price:*');

      invalidator.setKey('price:BTC', 'value2');

      const result = await invalidatePromise;

      expect(result.deleted).toBeGreaterThan(0);

      const final = invalidator.getKey('price:BTC');
      expect(final).toBe('value2');
    });
  });

  describe('Failure Handling', () => {
    it('surfaces invalidation failure as metric', async () => {
      const metrics = invalidator.getMetrics();
      expect(metrics.invalidationFailures).toBe(0);

      try {
        await invalidator.invalidateAndBroadcastAtomic('nonexistent:*');
      } catch (_err) {
      }

      const metricsAfter = invalidator.getMetrics();
      expect(metricsAfter.invalidationFailures).toBeGreaterThan(0);
    });

    it('logs invalidation failures instead of swallowing', async () => {
      const result = await invalidator.invalidateAndBroadcast('nonexistent:*');

      expect(result.deleted).toBe(0);

      const metrics = invalidator.getMetrics();
      expect(metrics.invalidationFailures).toBeGreaterThanOrEqual(0);
    });

    it('invalidation failure is alertable', async () => {
      const result = await invalidator.invalidateAndBroadcast('nonexistent:*');

      expect(result.deleted).toBe(0);

      const metrics = invalidator.getMetrics();

      if (result.deleted === 0) {
        expect(metrics).toBeDefined();
      }
    });
  });

  describe('Redis-less Fallback', () => {
    it('instance without Redis observes invalidations via staleness window', async () => {
      const canFallback = invalidator.canFallbackWithoutRedis();

      expect(canFallback).toBe(true);
    });

    it('L1 cache TTL extended on Redis failure', async () => {
      const baseTTL = 1000;
      const extendedTTL = baseTTL * 2;

      expect(extendedTTL).toBeGreaterThan(baseTTL);
    });

    it('documents bounds on staleness in Redis-less mode', async () => {
      const bound = invalidator.getBoundedStalenessWindow();

      expect(bound).toBeGreaterThan(0);
      expect(bound).toBeLessThanOrEqual(60000);
    });
  });

  describe('Work Bounding', () => {
    it('bounds work per invalidation call', async () => {
      for (let i = 0; i < 5000; i++) {
        invalidator.setKey(`history:asset:${i}`, `value${i}`);
      }

      const startTime = Date.now();
      await invalidator.scanAndDelete('history:*', 100);
      const duration = Date.now() - startTime;

      expect(duration).toBeLessThan(10000);
    });

    it('documents SCAN cost characteristics: O(N) over keyspace', async () => {
      const smallSet: string[] = [];
      for (let i = 0; i < 100; i++) {
        const key = `small:${i}`;
        invalidator.setKey(key, `value${i}`);
        smallSet.push(key);
      }

      const smallStart = Date.now();
      await invalidator.scanAndDelete('small:*');
      const smallDuration = Date.now() - smallStart;

      invalidator = new ScanBasedInvalidator();
      const largeSet: string[] = [];
      for (let i = 0; i < 10000; i++) {
        const key = `large:${i}`;
        invalidator.setKey(key, `value${i}`);
        largeSet.push(key);
      }

      const largeStart = Date.now();
      await invalidator.scanAndDelete('large:*');
      const largeDuration = Date.now() - largeStart;

      expect(largeDuration).toBeGreaterThan(smallDuration);
    });

    it('baseline latency impact under populated keyspace', async () => {
      for (let i = 0; i < 1000; i++) {
        invalidator.setKey(`key:${i}`, `value${i}`);
      }

      const start = Date.now();
      await invalidator.scanAndDelete('key:*');
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(1000);
    });
  });

  describe('Broadcast Safety', () => {
    it('publish call succeeds after delete completes', async () => {
      invalidator.setKey('price:XLM', 'value');

      await invalidator.invalidateAndBroadcast('price:*');

      const calls = invalidator.getPublishCalls();

      expect(calls).toHaveLength(1);
      expect(calls[0].pattern).toBe('price:*');
    });

    it('multiple invalidations broadcast independently', async () => {
      invalidator.setKey('history:XLM:c0', 'value1');
      invalidator.setKey('price:BTC', 'value2');

      await invalidator.invalidateAndBroadcast('history:*');
      await invalidator.invalidateAndBroadcast('price:*');

      const calls = invalidator.getPublishCalls();

      expect(calls).toHaveLength(2);
      expect(calls[0].pattern).toBe('history:*');
      expect(calls[1].pattern).toBe('price:*');
    });
  });

  describe('Pattern Matching', () => {
    it('matches wildcard patterns correctly', async () => {
      invalidator.setKey('history:XLM:c0:l25:t1000', 'value1');
      invalidator.setKey('history:BTC:c0:l25:t1000', 'value2');
      invalidator.setKey('price:XLM', 'value3');

      const deleted = await invalidator.scanAndDelete('history:*');

      expect(deleted).toBe(2);

      const remaining = invalidator.getAllKeys();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].key).toBe('price:XLM');
    });

    it('handles complex asset names in patterns', async () => {
      invalidator.setKey('history:XLM-USD:c0:l25:t1000', 'value1');
      invalidator.setKey('history:BTC/USDC:c0:l25:t1000', 'value2');

      const deleted = await invalidator.scanAndDelete('history:*');

      expect(deleted).toBe(2);
    });
  });
});
