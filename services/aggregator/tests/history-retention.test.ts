import { describe, it, expect, beforeEach, vi } from 'vitest';

interface HistoryEntry {
  price: string;
  decimals: number;
  source: string;
  timestamp: number;
}

interface HistoryConfig {
  maxEntries: number;
  retentionSeconds: number;
}

class HistoryRetentionManager {
  private config: HistoryConfig;

  constructor(config: HistoryConfig) {
    this.config = config;
  }

  pruneHistory(history: HistoryEntry[]): HistoryEntry[] {
    let pruned = history;

    if (this.config.retentionSeconds > 0) {
      const cutoff = Math.floor(Date.now() / 1000) - this.config.retentionSeconds;
      pruned = pruned.filter((h) => h.timestamp >= cutoff);
    }

    return this.config.maxEntries > 0 && pruned.length > this.config.maxEntries
      ? pruned.slice(-this.config.maxEntries)
      : pruned;
  }

  pruneHistoryWithTime(history: HistoryEntry[], now: number): HistoryEntry[] {
    let pruned = history;

    if (this.config.retentionSeconds > 0) {
      const cutoff = Math.floor(now / 1000) - this.config.retentionSeconds;
      pruned = pruned.filter((h) => h.timestamp >= cutoff);
    }

    return this.config.maxEntries > 0 && pruned.length > this.config.maxEntries
      ? pruned.slice(-this.config.maxEntries)
      : pruned;
  }

  identifyArchiveCandidates(
    history: HistoryEntry[],
    archiveThresholdSeconds: number,
  ): HistoryEntry[] {
    const cutoff = Math.floor(Date.now() / 1000) - archiveThresholdSeconds;
    return history.filter((h) => h.timestamp < cutoff);
  }

  removeArchivedEntries(
    history: HistoryEntry[],
    archived: HistoryEntry[],
  ): HistoryEntry[] {
    const archivedTimestamps = new Set(archived.map((a) => a.timestamp));
    return history.filter((h) => !archivedTimestamps.has(h.timestamp));
  }
}

describe('History Retention', () => {
  let manager: HistoryRetentionManager;

  beforeEach(() => {
    manager = new HistoryRetentionManager({
      maxEntries: 1000,
      retentionSeconds: 86400,
    });
  });

  describe('TTL-Based Retention', () => {
    it('should remove entries older than retention period', () => {
      const now = Math.floor(Date.now() / 1000);
      const retentionSeconds = 3600;

      const manager = new HistoryRetentionManager({
        maxEntries: 0,
        retentionSeconds,
      });

      const history: HistoryEntry[] = [
        { price: '100', decimals: 8, source: 'chainlink', timestamp: now - 7200 },
        { price: '101', decimals: 8, source: 'redstone', timestamp: now - 1800 },
        { price: '102', decimals: 8, source: 'band', timestamp: now },
      ];

      const pruned = manager.pruneHistoryWithTime(history, now * 1000);

      expect(pruned).toHaveLength(2);
      expect(pruned[0].price).toBe('101');
      expect(pruned[1].price).toBe('102');
    });

    it('should keep entries within retention period', () => {
      const now = Math.floor(Date.now() / 1000);
      const retentionSeconds = 3600;

      const manager = new HistoryRetentionManager({
        maxEntries: 0,
        retentionSeconds,
      });

      const history: HistoryEntry[] = [
        { price: '100', decimals: 8, source: 'chainlink', timestamp: now - 1800 },
        { price: '101', decimals: 8, source: 'redstone', timestamp: now - 900 },
        { price: '102', decimals: 8, source: 'band', timestamp: now },
      ];

      const pruned = manager.pruneHistoryWithTime(history, now * 1000);

      expect(pruned).toHaveLength(3);
    });

    it('should handle zero retention (keep all)', () => {
      const now = Math.floor(Date.now() / 1000);

      const manager = new HistoryRetentionManager({
        maxEntries: 0,
        retentionSeconds: 0,
      });

      const history: HistoryEntry[] = [
        { price: '100', decimals: 8, source: 'chainlink', timestamp: now - 86400 * 365 },
        { price: '101', decimals: 8, source: 'redstone', timestamp: now - 1800 },
        { price: '102', decimals: 8, source: 'band', timestamp: now },
      ];

      const pruned = manager.pruneHistoryWithTime(history, now * 1000);

      expect(pruned).toHaveLength(3);
    });

    it('should handle negative retention (invalid state)', () => {
      const manager = new HistoryRetentionManager({
        maxEntries: 0,
        retentionSeconds: -1,
      });

      const history: HistoryEntry[] = [
        { price: '100', decimals: 8, source: 'chainlink', timestamp: 1000 },
        { price: '101', decimals: 8, source: 'redstone', timestamp: 2000 },
      ];

      const pruned = manager.pruneHistoryWithTime(history, 3000 * 1000);

      expect(pruned).toHaveLength(2);
    });
  });

  describe('Entry Count Limiting', () => {
    it('should limit entries to maxEntries', () => {
      const maxEntries = 100;
      const manager = new HistoryRetentionManager({
        maxEntries,
        retentionSeconds: 0,
      });

      const history = Array.from({ length: 150 }, (_, i) => ({
        price: (100 + i).toString(),
        decimals: 8,
        source: 'chainlink',
        timestamp: i,
      }));

      const pruned = manager.pruneHistory(history);

      // The manager keeps the NEWEST maxEntries entries (slice(-maxEntries)).
      expect(pruned).toHaveLength(maxEntries);
      expect(pruned[0].price).toBe('150');
      expect(pruned[maxEntries - 1].price).toBe('249');
    });

    it('should keep newest entries when exceeding max', () => {
      const maxEntries = 5;
      const manager = new HistoryRetentionManager({
        maxEntries,
        retentionSeconds: 0,
      });

      const history: HistoryEntry[] = [
        { price: '1', decimals: 8, source: 'chainlink', timestamp: 1 },
        { price: '2', decimals: 8, source: 'chainlink', timestamp: 2 },
        { price: '3', decimals: 8, source: 'chainlink', timestamp: 3 },
        { price: '4', decimals: 8, source: 'chainlink', timestamp: 4 },
        { price: '5', decimals: 8, source: 'chainlink', timestamp: 5 },
        { price: '6', decimals: 8, source: 'chainlink', timestamp: 6 },
        { price: '7', decimals: 8, source: 'chainlink', timestamp: 7 },
      ];

      const pruned = manager.pruneHistory(history);

      expect(pruned).toHaveLength(maxEntries);
      expect(pruned[0].price).toBe('3');
      expect(pruned[maxEntries - 1].price).toBe('7');
    });

    it('should handle zero max entries (unlimited)', () => {
      const manager = new HistoryRetentionManager({
        maxEntries: 0,
        retentionSeconds: 0,
      });

      const history = Array.from({ length: 500 }, (_, i) => ({
        price: (100 + i).toString(),
        decimals: 8,
        source: 'chainlink',
        timestamp: i,
      }));

      const pruned = manager.pruneHistory(history);

      expect(pruned).toHaveLength(500);
    });
  });

  describe('Combined Retention and Entry Limits', () => {
    it('should apply both retention and entry limits', () => {
      const now = Math.floor(Date.now() / 1000);
      const retentionSeconds = 3600;
      const maxEntries = 10;

      const manager = new HistoryRetentionManager({
        maxEntries,
        retentionSeconds,
      });

      const history: HistoryEntry[] = Array.from({ length: 100 }, (_, i) => ({
        price: (100 + i).toString(),
        decimals: 8,
        source: 'chainlink',
        timestamp: now - 7200 + i * 10,
      }));

      const pruned = manager.pruneHistoryWithTime(history, now * 1000);

      expect(pruned.length).toBeLessThanOrEqual(maxEntries);
      pruned.forEach((entry) => {
        expect(entry.timestamp).toBeGreaterThanOrEqual(now - retentionSeconds);
      });
    });

    it('should prioritize retention over entry limit if needed', () => {
      const now = Math.floor(Date.now() / 1000);
      const retentionSeconds = 3600;
      const maxEntries = 5;

      const manager = new HistoryRetentionManager({
        maxEntries,
        retentionSeconds,
      });

      const history: HistoryEntry[] = Array.from({ length: 100 }, (_, i) => ({
        price: (100 + i).toString(),
        decimals: 8,
        source: 'chainlink',
        timestamp: now - 1800 + i,
      }));

      const pruned = manager.pruneHistoryWithTime(history, now * 1000);

      expect(pruned.length).toBeLessThanOrEqual(maxEntries);
      pruned.forEach((entry) => {
        expect(entry.timestamp).toBeGreaterThanOrEqual(now - retentionSeconds);
      });
    });
  });

  describe('Archive Migration', () => {
    it('should identify entries for archival', () => {
      const now = Math.floor(Date.now() / 1000);
      const archiveThreshold = 86400 * 30;

      const history: HistoryEntry[] = [
        { price: '100', decimals: 8, source: 'chainlink', timestamp: now - 86400 * 60 },
        { price: '101', decimals: 8, source: 'redstone', timestamp: now - 86400 * 35 },
        { price: '102', decimals: 8, source: 'band', timestamp: now - 86400 * 7 },
        { price: '103', decimals: 8, source: 'chainlink', timestamp: now },
      ];

      const candidates = manager.identifyArchiveCandidates(history, archiveThreshold);

      expect(candidates).toHaveLength(2);
      expect(candidates[0].price).toBe('100');
      expect(candidates[1].price).toBe('101');
    });

    it('should remove archived entries correctly', () => {
      const history: HistoryEntry[] = [
        { price: '100', decimals: 8, source: 'chainlink', timestamp: 1000 },
        { price: '101', decimals: 8, source: 'redstone', timestamp: 2000 },
        { price: '102', decimals: 8, source: 'band', timestamp: 3000 },
      ];

      const archived = [history[0], history[1]];

      const remaining = manager.removeArchivedEntries(history, archived);

      expect(remaining).toHaveLength(1);
      expect(remaining[0].price).toBe('102');
    });

    it('should handle empty archived list', () => {
      const history: HistoryEntry[] = [
        { price: '100', decimals: 8, source: 'chainlink', timestamp: 1000 },
        { price: '101', decimals: 8, source: 'redstone', timestamp: 2000 },
      ];

      const remaining = manager.removeArchivedEntries(history, []);

      expect(remaining).toHaveLength(2);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty history', () => {
      const pruned = manager.pruneHistory([]);
      expect(pruned).toEqual([]);
    });

    it('should handle single entry', () => {
      const history: HistoryEntry[] = [
        { price: '100', decimals: 8, source: 'chainlink', timestamp: Math.floor(Date.now() / 1000) },
      ];

      const pruned = manager.pruneHistory(history);
      expect(pruned).toHaveLength(1);
    });

    it('should handle duplicate timestamps', () => {
      const now = Math.floor(Date.now() / 1000);

      const history: HistoryEntry[] = [
        { price: '100', decimals: 8, source: 'chainlink', timestamp: now },
        { price: '101', decimals: 8, source: 'redstone', timestamp: now },
        { price: '102', decimals: 8, source: 'band', timestamp: now },
      ];

      const pruned = manager.pruneHistory(history);
      expect(pruned).toHaveLength(3);
    });

    it('should preserve entry order after pruning', () => {
      const now = Math.floor(Date.now() / 1000);

      const history: HistoryEntry[] = [
        { price: '100', decimals: 8, source: 'chainlink', timestamp: now - 1000 },
        { price: '101', decimals: 8, source: 'redstone', timestamp: now - 500 },
        { price: '102', decimals: 8, source: 'band', timestamp: now },
      ];

      const pruned = manager.pruneHistoryWithTime(history, now * 1000);

      expect(pruned[0].price).toBe('100');
      expect(pruned[1].price).toBe('101');
      expect(pruned[2].price).toBe('102');
    });

    it('should handle very large retention windows', () => {
      const manager = new HistoryRetentionManager({
        maxEntries: 0,
        retentionSeconds: 86400 * 365 * 10,
      });

      const now = Math.floor(Date.now() / 1000);

      const history: HistoryEntry[] = [
        { price: '100', decimals: 8, source: 'chainlink', timestamp: now - 86400 * 365 * 5 },
        { price: '101', decimals: 8, source: 'redstone', timestamp: now },
      ];

      const pruned = manager.pruneHistoryWithTime(history, now * 1000);
      expect(pruned).toHaveLength(2);
    });
  });

  describe('Configuration Scenarios', () => {
    it('should handle default retention config', () => {
      const manager = new HistoryRetentionManager({
        maxEntries: 1000,
        retentionSeconds: 86400,
      });

      const now = Math.floor(Date.now() / 1000);

      // All timestamps are within the 86400s retention window.
      const history = Array.from({ length: 500 }, (_, i) => ({
        price: (100 + i).toString(),
        decimals: 8,
        source: 'chainlink',
        timestamp: now - 3600 + i,
      }));

      const pruned = manager.pruneHistoryWithTime(history, now * 1000);

      expect(pruned.length).toBe(500);
    });

    it('should handle aggressive retention config', () => {
      const manager = new HistoryRetentionManager({
        maxEntries: 10,
        retentionSeconds: 3600,
      });

      const now = Math.floor(Date.now() / 1000);

      const history = Array.from({ length: 100 }, (_, i) => ({
        price: (100 + i).toString(),
        decimals: 8,
        source: 'chainlink',
        timestamp: now - 1800 + i,
      }));

      const pruned = manager.pruneHistoryWithTime(history, now * 1000);

      expect(pruned.length).toBeLessThanOrEqual(10);
    });

    it('should handle permissive retention config', () => {
      const manager = new HistoryRetentionManager({
        maxEntries: 10000,
        retentionSeconds: 0,
      });

      const history = Array.from({ length: 5000 }, (_, i) => ({
        price: (100 + i).toString(),
        decimals: 8,
        source: 'chainlink',
        timestamp: i,
      }));

      const pruned = manager.pruneHistory(history);

      expect(pruned).toHaveLength(5000);
    });
  });
});
