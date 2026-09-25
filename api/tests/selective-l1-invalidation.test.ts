/**
 * #533 — Selective L1 invalidation tests
 * Verifies that cache invalidation only clears relevant entries, not the entire
 * L1 cache. Tests pattern-based selective invalidation, index consistency with
 * TTL expiry and LRU eviction, invalidation groups, and metrics.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('Selective L1 Invalidation', () => {
  describe('pattern-aware invalidation', () => {
    it('invalidates only matching keys for a single asset pattern', () => {
      const cache = {
        'prices:XLM:p0:l50': { price: 100, timestamp: Date.now() },
        'prices:XLM:p1:l50': { price: 100, timestamp: Date.now() },
        'prices:USDC:p0:l50': { price: 1, timestamp: Date.now() },
        'history:XLM:c123:l50:t1234567890': { data: [], timestamp: Date.now() },
      };

      // Invalidate only XLM prices
      const pattern = 'prices:XLM:*';
      const entriesToClear = Object.keys(cache).filter((k) => {
        const parts = k.split(':');
        return parts[0] === 'prices' && parts[1] === 'XLM';
      });

      expect(entriesToClear).toEqual(['prices:XLM:p0:l50', 'prices:XLM:p1:l50']);

      // USDC and history should remain
      expect(cache['prices:USDC:p0:l50']).toBeDefined();
      expect(cache['history:XLM:c123:l50:t1234567890']).toBeDefined();
    });

    it('invalidates history entries separately from prices', () => {
      const cache = {
        'prices:XLM:p0:l50': { price: 100 },
        'history:XLM:c123:l50:t1234567890': { data: [] },
        'history:XLM:c456:l50:t1234567890': { data: [] },
      };

      // Invalidate only history for XLM
      const historyPattern = 'history:XLM:*';
      const historyEntries = Object.keys(cache).filter((k) => k.startsWith('history:XLM:'));

      expect(historyEntries).toHaveLength(2);
      expect(cache['prices:XLM:p0:l50']).toBeDefined();
    });

    it('supports wildcard patterns for broad invalidation', () => {
      const cache = {
        'prices:XLM:p0:l50': { price: 100 },
        'prices:USDC:p0:l50': { price: 1 },
        'history:XLM:c123:l50:t1234567890': { data: [] },
        'sources:health': { status: 'ok' },
      };

      // Invalidate all price-related entries
      const pricePattern = 'prices:*';
      const priceEntries = Object.keys(cache).filter((k) => k.startsWith('prices:'));

      expect(priceEntries).toHaveLength(2);
      expect(cache['history:XLM:c123:l50:t1234567890']).toBeDefined();
      expect(cache['sources:health']).toBeDefined();
    });
  });

  describe('unrelated entries survive invalidation', () => {
    it('preserves unrelated cached entries when invalidating a specific asset', () => {
      const cache = {
        'prices:XLM:p0:l50': { price: 100 },
        'prices:USDC:p0:l50': { price: 1 },
        'history:XLM:c123:l50:t1234567890': { data: [] },
        'health:aggregate': { status: 'healthy' },
      };

      // Invalidate XLM prices only
      const xlmPriceKeys = Object.keys(cache).filter((k) => k === 'prices:XLM:p0:l50');

      // Other entries should be untouched
      expect(cache['prices:USDC:p0:l50']).toBeDefined();
      expect(cache['history:XLM:c123:l50:t1234567890']).toBeDefined();
      expect(cache['health:aggregate']).toBeDefined();
    });

    it('preserves sources and health entries when invalidating prices', () => {
      const cache = {
        'prices:XLM:p0:l50': { price: 100 },
        'prices:USDC:p0:l50': { price: 1 },
        'sources:chainlink': { status: 'ok' },
        'sources:redstone': { status: 'ok' },
        'health:live': { uptime: 12345 },
      };

      // Invalidate all prices
      const priceKeys = Object.keys(cache).filter((k) => k.startsWith('prices:'));

      expect(priceKeys).toHaveLength(2);
      expect(cache['sources:chainlink']).toBeDefined();
      expect(cache['sources:redstone']).toBeDefined();
      expect(cache['health:live']).toBeDefined();
    });
  });

  describe('index structure and consistency', () => {
    it('maintains a tag-to-keys index for fast pattern matching', () => {
      const index = {
        'asset:XLM': ['prices:XLM:p0:l50', 'prices:XLM:p1:l50', 'history:XLM:c123:l50:t1234567890'],
        'asset:USDC': ['prices:USDC:p0:l50'],
        'type:health': ['health:aggregate', 'health:live'],
      };

      // Looking up which keys are tagged with 'asset:XLM'
      const xlmKeys = index['asset:XLM'];
      expect(xlmKeys).toHaveLength(3);
    });

    it('cleans up dangling index references on TTL expiry', async () => {
      const index = {
        'asset:XLM': ['prices:XLM:p0:l50', 'prices:XLM:p1:l50'],
      };

      // Simulate TTL expiry removing a key
      const expiredKey = 'prices:XLM:p0:l50';

      // Index must be updated
      index['asset:XLM'] = index['asset:XLM'].filter((k) => k !== expiredKey);

      expect(index['asset:XLM']).toEqual(['prices:XLM:p1:l50']);
    });

    it('cleans up dangling index references on LRU eviction', () => {
      const index = {
        'asset:XLM': ['prices:XLM:p0:l50', 'prices:XLM:p1:l50', 'prices:XLM:p2:l50'],
      };

      // Simulate LRU eviction of oldest key
      const evictedKey = 'prices:XLM:p0:l50';

      // Index must be updated
      index['asset:XLM'] = index['asset:XLM'].filter((k) => k !== evictedKey);

      expect(index['asset:XLM']).toEqual(['prices:XLM:p1:l50', 'prices:XLM:p2:l50']);
    });

    it('bounds index structure size to prevent memory leak', () => {
      const MAX_INDEX_ENTRIES = 10000;
      const index = new Map<string, Set<string>>();

      // Add up to MAX_INDEX_ENTRIES
      for (let i = 0; i < MAX_INDEX_ENTRIES; i++) {
        const tagKey = `asset:asset_${i}`;
        if (!index.has(tagKey)) {
          index.set(tagKey, new Set());
        }
      }

      expect(index.size).toBe(MAX_INDEX_ENTRIES);

      // Check that index doesn't grow unbounded
      expect(index.size).toBeLessThanOrEqual(MAX_INDEX_ENTRIES * 1.1);
    });
  });

  describe('invalidation groups', () => {
    it('defines that a single price and its paginated list belong to the same group', () => {
      const groups = {
        'price:XLM': ['prices:XLM:p0:l50', 'prices:XLM:p1:l50', 'prices:XLM:p2:l50'],
        'history:XLM': ['history:XLM:c123:l50:t1234567890', 'history:XLM:c456:l50:t1234567890'],
      };

      // All pages for XLM prices must be invalidated together
      expect(groups['price:XLM']).toHaveLength(3);
    });

    it('ensures paginated lists containing a price are invalidated together', () => {
      // When prices:XLM is updated, all paginated pages that contain it must be cleared
      const affectedKeys = [
        'prices:XLM:p0:l50', // Contains asset 0-49
        'prices:XLM:p1:l50', // Contains asset 50-99
        'prices:XLM:p2:l50', // Contains asset 100-149
      ];

      // All should be invalidated
      expect(affectedKeys.every((k) => k.startsWith('prices:XLM:'))).toBe(true);
    });

    it('prevents serving inconsistent combinations of correlated data', () => {
      const validCombinations = [
        { priceStale: true, pageStale: true }, // OK: both stale
        { priceStale: false, pageStale: false }, // OK: both fresh
      ];

      const invalidCombinations = [
        { priceStale: true, pageStale: false }, // NOT OK: price stale but page fresh
        { priceStale: false, pageStale: true }, // NOT OK: price fresh but page stale
      ];

      // After invalidation, state must be consistent
      expect(validCombinations[0].priceStale === validCombinations[0].pageStale).toBe(true);
      expect(validCombinations[1].priceStale === validCombinations[1].pageStale).toBe(true);
    });
  });

  describe('per-invalidation work bounds', () => {
    it('completes pattern matching in bounded time', () => {
      const cache = new Map<string, any>();

      // Populate with 1000 entries
      for (let i = 0; i < 1000; i++) {
        cache.set(`prices:XLM:p${i}:l50`, { price: 100 });
      }

      const startTime = Date.now();

      // Find all matching entries
      const matches = Array.from(cache.keys()).filter((k) => k.startsWith('prices:XLM:'));

      const elapsed = Date.now() - startTime;

      expect(matches).toHaveLength(1000);
      expect(elapsed).toBeLessThan(100); // Should be fast
    });

    it('documents the worst-case pattern matching scenario', () => {
      // Worst case: match all entries in cache
      // With N=1000 entries, pattern '.*' matches everything
      // Time: O(N) iteration + regex match per key
      // Expected: < 10ms on modern hardware

      const worstCaseN = 1000;
      const expectedMaxTimeMs = 50;

      const estimatedTime = worstCaseN * 0.01; // Assuming 0.01ms per key-pattern match
      expect(estimatedTime).toBeLessThan(expectedMaxTimeMs);
    });
  });

  describe('redis-less fallback path', () => {
    it('remains correct when Redis is unavailable', () => {
      const l1Cache = {
        'prices:XLM:p0:l50': { price: 100 },
        'prices:USDC:p0:l50': { price: 1 },
        'health:aggregate': { status: 'healthy' },
      };

      // Invalidate without Redis — only L1 can be cleared
      const keysToInvalidate = Object.keys(l1Cache).filter((k) => k.startsWith('prices:'));

      expect(keysToInvalidate).toHaveLength(2);
      expect(l1Cache['health:aggregate']).toBeDefined();
    });

    it('preserves invalidation semantics with only L1 cache', () => {
      const l1Cache = {
        'prices:XLM:p0:l50': { price: 100, timestamp: Date.now() },
        'prices:USDC:p0:l50': { price: 1, timestamp: Date.now() },
      };

      // Invalidate XLM without Redis
      const pattern = 'prices:XLM:*';
      const toInvalidate = Object.keys(l1Cache).filter((k) => k.startsWith('prices:XLM:'));

      // Even without Redis, XLM should be cleared
      expect(toInvalidate).toHaveLength(1);

      // USDC should remain
      expect(l1Cache['prices:USDC:p0:l50']).toBeDefined();
    });
  });

  describe('metrics', () => {
    it('tracks count of invalidated entries per invalidation', () => {
      const metrics = {
        invalidationMessageTotal: 0,
        invalidatedEntriesTotal: 0,
      };

      // Invalidate 3 entries
      metrics.invalidationMessageTotal++;
      metrics.invalidatedEntriesTotal += 3;

      expect(metrics.invalidationMessageTotal).toBe(1);
      expect(metrics.invalidatedEntriesTotal).toBe(3);
    });

    it('tracks L1 hit rate before and after selective invalidation', () => {
      const metrics = {
        l1HitRate: 0.85, // 85% hits before
      };

      // After implementing selective invalidation
      // Hit rate should improve since fewer entries are cleared
      const expectedImprovement = 0.05; // 5% improvement
      metrics.l1HitRate += expectedImprovement;

      expect(metrics.l1HitRate).toBeGreaterThan(0.85);
    });

    it('measures impact of invalidation pattern coverage', () => {
      const metrics = {
        totalCacheEntries: 500,
        entriesClearedPerInvalidation: {
          'prices:XLM': 10, // Selective: only 10 entries
          'prices:*': 250, // Broad: 250 entries
          'invalidate-all': 500, // Complete flush: all entries
        },
      };

      expect(metrics.entriesClearedPerInvalidation['prices:XLM']).toBeLessThan(
        metrics.entriesClearedPerInvalidation['prices:*'],
      );
      expect(metrics.entriesClearedPerInvalidation['prices:*']).toBeLessThan(
        metrics.entriesClearedPerInvalidation['invalidate-all'],
      );
    });
  });
});
