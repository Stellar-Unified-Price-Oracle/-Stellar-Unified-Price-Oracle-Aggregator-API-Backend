import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  estimateCostUsd,
  recordCall,
  getBudgetUtilization,
  getDailyCount,
  getDailyCounts,
  resetDailyCounts,
  estimateConsumerCost,
  getConsumerCostTable,
  MAX_CONSUMER_FEEDS,
} from '../src/infrastructure/cost-model';

describe('Cost Model', () => {
  beforeEach(() => {
    resetDailyCounts();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('estimateCostUsd', () => {
    it('should return correct cost per call for chainlink', () => {
      const cost = estimateCostUsd('chainlink');
      expect(cost).toBe(0.0);
    });

    it('should return correct cost per call for redstone', () => {
      const cost = estimateCostUsd('redstone');
      expect(cost).toBe(0.0);
    });

    it('should return correct cost per call for band', () => {
      const cost = estimateCostUsd('band');
      expect(cost).toBe(0.0);
    });

    it('should return correct cost per call for reflector', () => {
      const cost = estimateCostUsd('reflector');
      expect(cost).toBe(0.0);
    });

    it('should handle case-insensitive source names', () => {
      expect(estimateCostUsd('CHAINLINK')).toBe(0.0);
      expect(estimateCostUsd('ChainLink')).toBe(0.0);
      expect(estimateCostUsd('chainlink')).toBe(0.0);
    });

    it('should return 0 for unknown source', () => {
      const cost = estimateCostUsd('unknown_source');
      expect(cost).toBe(0.0);
    });
  });

  describe('recordCall', () => {
    it('should increment daily call count', () => {
      recordCall('chainlink');
      expect(getDailyCount('chainlink')).toBe(1);

      recordCall('chainlink');
      expect(getDailyCount('chainlink')).toBe(2);
    });

    it('should track calls for multiple sources independently', () => {
      recordCall('chainlink');
      recordCall('chainlink');
      recordCall('redstone');

      expect(getDailyCount('chainlink')).toBe(2);
      expect(getDailyCount('redstone')).toBe(1);
    });

    it('should handle case-insensitive source names', () => {
      recordCall('CHAINLINK');
      recordCall('chainlink');

      expect(getDailyCount('chainlink')).toBe(2);
      expect(getDailyCount('CHAINLINK')).toBe(2);
    });
  });

  describe('getDailyCount', () => {
    it('should return 0 for untracked source', () => {
      expect(getDailyCount('unknown_source')).toBe(0);
    });

    it('should return correct count for tracked source', () => {
      recordCall('band');
      recordCall('band');
      recordCall('band');

      expect(getDailyCount('band')).toBe(3);
    });

    it('should reset count at midnight UTC', () => {
      recordCall('chainlink');
      recordCall('chainlink');
      expect(getDailyCount('chainlink')).toBe(2);

      vi.setSystemTime(new Date('2024-01-16T00:00:00Z'));

      expect(getDailyCount('chainlink')).toBe(0);

      recordCall('chainlink');
      expect(getDailyCount('chainlink')).toBe(1);
    });
  });

  describe('getBudgetUtilization', () => {
    it('should return 0 for untracked source', () => {
      const util = getBudgetUtilization('unknown_source');
      expect(util).toBe(0);
    });

    it('should calculate correct utilization percentage', () => {
      // Budget is 10000 for chainlink
      recordCall('chainlink');
      recordCall('chainlink');
      recordCall('chainlink');
      recordCall('chainlink');
      recordCall('chainlink');

      const util = getBudgetUtilization('chainlink');
      expect(util).toBe(5 / 10000);
    });

    it('should return 1.0 when budget is fully utilized', () => {
      // Mock 10000 calls to chainlink
      for (let i = 0; i < 10000; i++) {
        recordCall('chainlink');
      }

      const util = getBudgetUtilization('chainlink');
      expect(util).toBe(1.0);
    });

    it('should return > 1.0 when budget is exceeded', () => {
      // Mock 11000 calls to chainlink
      for (let i = 0; i < 11000; i++) {
        recordCall('chainlink');
      }

      const util = getBudgetUtilization('chainlink');
      expect(util).toBeGreaterThan(1.0);
      expect(util).toBe(11000 / 10000);
    });

    it('should reset utilization at midnight UTC', () => {
      recordCall('redstone');
      recordCall('redstone');
      expect(getBudgetUtilization('redstone')).toBe(2 / 10000);

      vi.setSystemTime(new Date('2024-01-16T00:00:00Z'));

      expect(getBudgetUtilization('redstone')).toBe(0);

      recordCall('redstone');
      expect(getBudgetUtilization('redstone')).toBe(1 / 10000);
    });
  });

  describe('getDailyCounts', () => {
    it('should return empty object when no calls recorded', () => {
      const counts = getDailyCounts();
      expect(counts).toEqual({});
    });

    it('should return all tracked sources and counts', () => {
      recordCall('chainlink');
      recordCall('chainlink');
      recordCall('redstone');
      recordCall('band');
      recordCall('band');
      recordCall('band');

      const counts = getDailyCounts();
      expect(counts['chainlink']).toBe(2);
      expect(counts['redstone']).toBe(1);
      expect(counts['band']).toBe(3);
    });

    it('should reset all counts at midnight UTC', () => {
      recordCall('chainlink');
      recordCall('redstone');

      vi.setSystemTime(new Date('2024-01-16T00:00:00Z'));

      const counts = getDailyCounts();
      expect(counts).toEqual({});
    });

    it('should return a copy, not reference to internal state', () => {
      recordCall('chainlink');
      const counts1 = getDailyCounts();
      counts1['chainlink'] = 999;

      const counts2 = getDailyCounts();
      expect(counts2['chainlink']).toBe(1);
    });
  });

  describe('estimateConsumerCost', () => {
    it('should estimate storage and transaction costs for a single feed', () => {
      const estimate = estimateConsumerCost({ feedCount: 1, feeStroops: 100 });

      expect(estimate.feedCount).toBe(1);
      expect(estimate.feeStroops).toBe(100);
      expect(estimate.storageBytes).toBeGreaterThan(0);
      expect(estimate.storageCostStroops).toBeGreaterThan(0);
      expect(estimate.transactionCostStroops).toBeGreaterThan(0);
      expect(estimate.totalCostStroops).toBe(
        estimate.storageCostStroops + estimate.transactionCostStroops,
      );
    });

    it('should scale storage cost linearly with feed count', () => {
      const one = estimateConsumerCost({ feedCount: 1, feeStroops: 100 });
      const ten = estimateConsumerCost({ feedCount: 10, feeStroops: 100 });

      expect(ten.storageBytes).toBe(one.storageBytes * 10);
      expect(ten.storageCostStroops).toBe(one.storageCostStroops * 10);
    });

    it('should scale transaction cost with fee conditions', () => {
      const low = estimateConsumerCost({ feedCount: 5, feeStroops: 100 });
      const high = estimateConsumerCost({ feedCount: 5, feeStroops: 1000 });

      expect(high.transactionCostStroops).toBeGreaterThan(low.transactionCostStroops);
      expect(high.storageCostStroops).toBe(low.storageCostStroops);
    });

    it('should estimate costs across representative feed counts', () => {
      for (const feedCount of [1, 5, 10, 25, 50]) {
        const estimate = estimateConsumerCost({ feedCount, feeStroops: 100 });
        expect(estimate.feedCount).toBe(feedCount);
        expect(estimate.totalCostStroops).toBeGreaterThan(0);
      }
    });

    it('should handle the maximum supported feed count boundary', () => {
      const estimate = estimateConsumerCost({
        feedCount: MAX_CONSUMER_FEEDS,
        feeStroops: 100,
      });

      expect(estimate.feedCount).toBe(MAX_CONSUMER_FEEDS);
      expect(estimate.totalCostStroops).toBeGreaterThan(0);
    });

    it('should reject feed counts above the maximum supported', () => {
      expect(() =>
        estimateConsumerCost({ feedCount: MAX_CONSUMER_FEEDS + 1, feeStroops: 100 }),
      ).toThrow(/feed/i);
    });

    it('should reject non-positive feed counts', () => {
      expect(() => estimateConsumerCost({ feedCount: 0, feeStroops: 100 })).toThrow(/feed/i);
      expect(() => estimateConsumerCost({ feedCount: -1, feeStroops: 100 })).toThrow(/feed/i);
    });

    it('should fail when the provided fee is insufficient', () => {
      expect(() => estimateConsumerCost({ feedCount: 1, feeStroops: 0 })).toThrow(/fee/i);
      expect(() => estimateConsumerCost({ feedCount: 1, feeStroops: -5 })).toThrow(/fee/i);
    });
  });

  describe('getConsumerCostTable', () => {
    it('should produce a reproducible cost table', () => {
      const first = getConsumerCostTable();
      const second = getConsumerCostTable();

      expect(second).toEqual(first);
    });

    it('should return a copy, not reference to internal state', () => {
      const table = getConsumerCostTable();
      table[0].totalCostStroops = -1;

      const fresh = getConsumerCostTable();
      expect(fresh[0].totalCostStroops).not.toBe(-1);
    });

    it('should cover representative feed counts and fee conditions', () => {
      const table = getConsumerCostTable();

      expect(table.length).toBeGreaterThan(0);
      const feedCounts = new Set(table.map((row) => row.feedCount));
      const fees = new Set(table.map((row) => row.feeStroops));

      expect(feedCounts.size).toBeGreaterThan(1);
      expect(fees.size).toBeGreaterThan(1);
      expect(feedCounts.has(MAX_CONSUMER_FEEDS)).toBe(true);
    });
  });
});
