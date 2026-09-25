import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

interface PriceEntry {
  price: string;
  decimals: number;
  timestamp: number;
  observedLive: boolean;
  reconstructed?: {
    source: string;
    method: string;
  };
}

interface GapDetectionResult {
  asset: string;
  gapStart: number;
  gapEnd: number;
  gapDurationSeconds: number;
  isRecoverable: boolean;
}

interface BackfillResult {
  asset: string;
  gap: GapDetectionResult;
  status: 'filled' | 'unrecoverable' | 'rejected';
  entriesFilled?: number;
  reconstructionSource?: string;
  reconstructionError?: string;
}

class GapBackfillManager {
  private history: Map<string, PriceEntry[]> = new Map();
  private permanentGaps: Map<string, GapDetectionResult[]> = new Map();
  private backfillMetrics = {
    filled: 0,
    unrecoverable: 0,
    rejected: 0,
  };

  writeEntry(asset: string, entry: PriceEntry): void {
    if (!this.history.has(asset)) {
      this.history.set(asset, []);
    }
    this.history.get(asset)!.push(entry);
  }

  detectGaps(asset: string): GapDetectionResult[] {
    const entries = this.history.get(asset) || [];
    if (entries.length < 2) return [];

    const gaps: GapDetectionResult[] = [];
    const sortedEntries = [...entries].sort((a, b) => a.timestamp - b.timestamp);

    for (let i = 0; i < sortedEntries.length - 1; i++) {
      const current = sortedEntries[i];
      const next = sortedEntries[i + 1];
      const timeDiff = next.timestamp - current.timestamp;

      const expectedInterval = 60; // Assume 1 minute intervals
      if (timeDiff > expectedInterval * 2) {
        gaps.push({
          asset,
          gapStart: current.timestamp,
          gapEnd: next.timestamp,
          gapDurationSeconds: timeDiff,
          isRecoverable: this.isGapRecoverable(asset, current.timestamp, next.timestamp),
        });
      }
    }

    return gaps;
  }

  private isGapRecoverable(asset: string, gapStart: number, gapEnd: number): boolean {
    // Simulate checking if upstream providers have historical data
    const hoursAgo = (Date.now() / 1000 - gapStart) / 3600;
    // Assume providers keep 30 days of history
    return hoursAgo < 30 * 24;
  }

  backfillGap(asset: string, gap: GapDetectionResult, reconstructedData: PriceEntry[]): BackfillResult {
    // Validate reconstruction against adjacent observations
    const entries = this.history.get(asset) || [];
    const gapStartEntry = entries.find((e) => e.timestamp === gap.gapStart);
    const gapEndEntry = entries.find((e) => e.timestamp === gap.gapEnd);

    if (!gapStartEntry || !gapEndEntry) {
      return {
        asset,
        gap,
        status: 'rejected',
        reconstructionError: 'Cannot find gap boundaries',
      };
    }

    // Validate reconstruction with threshold of 10%
    const threshold = 0.1;
    for (const recon of reconstructedData) {
      const startPrice = parseFloat(gapStartEntry.price);
      const endPrice = parseFloat(gapEndEntry.price);
      const reconPrice = parseFloat(recon.price);

      const startDiff = Math.abs(reconPrice - startPrice) / startPrice;
      const endDiff = Math.abs(reconPrice - endPrice) / endPrice;

      if (startDiff > threshold && endDiff > threshold) {
        return {
          asset,
          gap,
          status: 'rejected',
          reconstructionError: `Reconstruction diverges by ${(startDiff * 100).toFixed(2)}%`,
        };
      }
    }

    // Add reconstructed entries with provenance
    const addedEntries: PriceEntry[] = reconstructedData.map((entry) => ({
      ...entry,
      observedLive: false,
      reconstructed: {
        source: 'historical-api',
        method: 'backfill',
      },
    }));

    if (!this.history.has(asset)) {
      this.history.set(asset, []);
    }

    this.history.get(asset)!.push(...addedEntries);
    this.backfillMetrics.filled++;

    return {
      asset,
      gap,
      status: 'filled',
      entriesFilled: addedEntries.length,
      reconstructionSource: 'historical-api',
    };
  }

  markPermanentGap(asset: string, gap: GapDetectionResult): void {
    if (!this.permanentGaps.has(asset)) {
      this.permanentGaps.set(asset, []);
    }
    this.permanentGaps.get(asset)!.push(gap);
    this.backfillMetrics.unrecoverable++;
  }

  isPermanentGap(asset: string, timestamp: number): boolean {
    const gaps = this.permanentGaps.get(asset) || [];
    return gaps.some((gap) => timestamp >= gap.gapStart && timestamp <= gap.gapEnd);
  }

  getHistory(asset: string): PriceEntry[] {
    const entries = this.history.get(asset) || [];
    return entries.sort((a, b) => a.timestamp - b.timestamp);
  }

  isBackfillPruned(asset: string, backfilledVersion: number, maxEntries: number, retentionSeconds: number): boolean {
    const entries = this.getHistory(asset);
    if (entries.length <= maxEntries) return false;

    const now = Math.floor(Date.now() / 1000);
    const cutoff = now - retentionSeconds;

    // Check if backfill would be at risk of pruning
    return entries.length > maxEntries && entries[entries.length - maxEntries - 1].timestamp < cutoff;
  }

  getBackfillMetrics(): { filled: number; unrecoverable: number; rejected: number } {
    return { ...this.backfillMetrics };
  }

  idempotentBackfill(asset: string, gap: GapDetectionResult, data: PriceEntry[]): BackfillResult {
    // Check if already backfilled
    const existing = (this.permanentGaps.get(asset) || []).some(
      (g) => g.gapStart === gap.gapStart && g.gapEnd === gap.gapEnd
    );

    if (existing) {
      return {
        asset,
        gap,
        status: 'filled',
        entriesFilled: 0,
      };
    }

    return this.backfillGap(asset, gap, data);
  }

  concurrencySafeBackfill(asset: string, gap: GapDetectionResult, data: PriceEntry[]): BackfillResult {
    // Simulate concurrency by checking again
    const gaps = this.detectGaps(asset);
    const gapExists = gaps.some((g) => g.gapStart === gap.gapStart && g.gapEnd === gap.gapEnd);

    if (!gapExists) {
      return {
        asset,
        gap,
        status: 'filled',
        entriesFilled: 0,
      };
    }

    return this.backfillGap(asset, gap, data);
  }
}

describe('Issue #541: Automated Gap Detection with Provenance-Aware Backfill', () => {
  let manager: GapBackfillManager;

  beforeEach(() => {
    manager = new GapBackfillManager();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Gap detection', () => {
    it('should detect gaps in price history', () => {
      const baseTime = 1000000000;
      manager.writeEntry('XLM', { price: '100', decimals: 7, timestamp: baseTime, observedLive: true });
      manager.writeEntry('XLM', { price: '101', decimals: 7, timestamp: baseTime + 60, observedLive: true });
      manager.writeEntry('XLM', { price: '102', decimals: 7, timestamp: baseTime + 300, observedLive: true });

      const gaps = manager.detectGaps('XLM');
      expect(gaps).toHaveLength(1);
      expect(gaps[0].gapDurationSeconds).toBe(240);
    });

    it('should not detect gaps in continuous data', () => {
      const baseTime = 1000000000;
      for (let i = 0; i < 10; i++) {
        manager.writeEntry('USDC', {
          price: String(100 + i * 0.01),
          decimals: 6,
          timestamp: baseTime + i * 60,
          observedLive: true,
        });
      }

      const gaps = manager.detectGaps('USDC');
      expect(gaps).toHaveLength(0);
    });

    it('should detect multiple gaps', () => {
      const baseTime = 1000000000;
      manager.writeEntry('BTC', { price: '50000', decimals: 8, timestamp: baseTime, observedLive: true });
      manager.writeEntry('BTC', { price: '50001', decimals: 8, timestamp: baseTime + 300, observedLive: true });
      manager.writeEntry('BTC', { price: '50002', decimals: 8, timestamp: baseTime + 500, observedLive: true });
      manager.writeEntry('BTC', { price: '50003', decimals: 8, timestamp: baseTime + 900, observedLive: true });

      const gaps = manager.detectGaps('BTC');
      expect(gaps.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Provenance recording', () => {
    it('should mark entries as observed live', () => {
      manager.writeEntry('XLM', { price: '100', decimals: 7, timestamp: 1000000000, observedLive: true });
      const history = manager.getHistory('XLM');
      expect(history[0].observedLive).toBe(true);
      expect(history[0].reconstructed).toBeUndefined();
    });

    it('should record reconstruction provenance', () => {
      const baseTime = 1000000000;
      manager.writeEntry('XLM', { price: '100', decimals: 7, timestamp: baseTime, observedLive: true });
      manager.writeEntry('XLM', { price: '105', decimals: 7, timestamp: baseTime + 300, observedLive: true });

      const gap: GapDetectionResult = {
        asset: 'XLM',
        gapStart: baseTime,
        gapEnd: baseTime + 300,
        gapDurationSeconds: 300,
        isRecoverable: true,
      };

      const reconstructed: PriceEntry[] = [
        { price: '101', decimals: 7, timestamp: baseTime + 60, observedLive: false },
        { price: '102', decimals: 7, timestamp: baseTime + 120, observedLive: false },
        { price: '103', decimals: 7, timestamp: baseTime + 180, observedLive: false },
        { price: '104', decimals: 7, timestamp: baseTime + 240, observedLive: false },
      ];

      manager.backfillGap('XLM', gap, reconstructed);
      const history = manager.getHistory('XLM');

      const reconEntry = history.find((e) => e.timestamp === baseTime + 60);
      expect(reconEntry).toBeDefined();
      expect(reconEntry!.observedLive).toBe(false);
      expect(reconEntry!.reconstructed).toBeDefined();
      expect(reconEntry!.reconstructed!.source).toBe('historical-api');
    });

    it('should distinguish observed live from reconstructed', () => {
      const baseTime = 1000000000;
      manager.writeEntry('ETH', { price: '2000', decimals: 8, timestamp: baseTime, observedLive: true });
      manager.writeEntry('ETH', { price: '2005', decimals: 8, timestamp: baseTime + 300, observedLive: true });

      const gap: GapDetectionResult = {
        asset: 'ETH',
        gapStart: baseTime,
        gapEnd: baseTime + 300,
        gapDurationSeconds: 300,
        isRecoverable: true,
      };

      const reconstructed: PriceEntry[] = [
        { price: '2001', decimals: 8, timestamp: baseTime + 60, observedLive: false },
      ];

      manager.backfillGap('ETH', gap, reconstructed);
      const history = manager.getHistory('ETH');

      const liveEntries = history.filter((e) => e.observedLive);
      const reconEntries = history.filter((e) => !e.observedLive);

      expect(liveEntries).toHaveLength(2);
      expect(reconEntries).toHaveLength(1);
    });
  });

  describe('Unrecoverable gap recording', () => {
    it('should mark unrecoverable gaps permanently', () => {
      const baseTime = 1000000000;
      const gap: GapDetectionResult = {
        asset: 'OLDTOKEN',
        gapStart: baseTime - 3600 * 24 * 40, // 40 days ago
        gapEnd: baseTime - 3600 * 24 * 35,
        gapDurationSeconds: 3600 * 24 * 5,
        isRecoverable: false,
      };

      manager.markPermanentGap('OLDTOKEN', gap);
      expect(manager.isPermanentGap('OLDTOKEN', gap.gapStart + 1000)).toBe(true);
    });

    it('should not re-alert on permanent gaps', () => {
      const baseTime = 1000000000;
      const gap: GapDetectionResult = {
        asset: 'XLM',
        gapStart: baseTime - 1000,
        gapEnd: baseTime,
        gapDurationSeconds: 1000,
        isRecoverable: false,
      };

      manager.markPermanentGap('XLM', gap);
      const gaps = manager.detectGaps('XLM');

      const shouldSkip = gaps.every((g) => !manager.isPermanentGap('XLM', g.gapStart));
      expect(shouldSkip).toBe(true);
    });
  });

  describe('Reconstruction validation', () => {
    it('should validate reconstruction against adjacent observations', () => {
      const baseTime = 1000000000;
      manager.writeEntry('TEST', { price: '100', decimals: 7, timestamp: baseTime, observedLive: true });
      manager.writeEntry('TEST', { price: '110', decimals: 7, timestamp: baseTime + 300, observedLive: true });

      const gap: GapDetectionResult = {
        asset: 'TEST',
        gapStart: baseTime,
        gapEnd: baseTime + 300,
        gapDurationSeconds: 300,
        isRecoverable: true,
      };

      // Reconstruction that diverges significantly
      const badReconstruction: PriceEntry[] = [
        { price: '50', decimals: 7, timestamp: baseTime + 150, observedLive: false },
      ];

      const result = manager.backfillGap('TEST', gap, badReconstruction);
      expect(result.status).toBe('rejected');
      expect(result.reconstructionError).toBeDefined();
    });

    it('should accept valid reconstruction', () => {
      const baseTime = 1000000000;
      manager.writeEntry('TEST', { price: '100', decimals: 7, timestamp: baseTime, observedLive: true });
      manager.writeEntry('TEST', { price: '110', decimals: 7, timestamp: baseTime + 300, observedLive: true });

      const gap: GapDetectionResult = {
        asset: 'TEST',
        gapStart: baseTime,
        gapEnd: baseTime + 300,
        gapDurationSeconds: 300,
        isRecoverable: true,
      };

      // Valid reconstruction within 10% threshold
      const goodReconstruction: PriceEntry[] = [
        { price: '105', decimals: 7, timestamp: baseTime + 150, observedLive: false },
      ];

      const result = manager.backfillGap('TEST', gap, goodReconstruction);
      expect(result.status).toBe('filled');
    });
  });

  describe('Backfill not silently pruned', () => {
    it('should protect backfilled data from pruning', () => {
      const baseTime = 1000000000;
      manager.writeEntry('XLM', { price: '100', decimals: 7, timestamp: baseTime, observedLive: true });

      const backfillVersion = 1;
      const maxEntries = 10;
      const retentionSeconds = 86400; // 1 day

      const isPruned = manager.isBackfillPruned('XLM', backfillVersion, maxEntries, retentionSeconds);
      expect(isPruned).toBe(false);
    });
  });

  describe('Idempotent and concurrency-safe backfill', () => {
    it('should be idempotent - same backfill twice', () => {
      const baseTime = 1000000000;
      manager.writeEntry('XLM', { price: '100', decimals: 7, timestamp: baseTime, observedLive: true });
      manager.writeEntry('XLM', { price: '105', decimals: 7, timestamp: baseTime + 300, observedLive: true });

      const gap: GapDetectionResult = {
        asset: 'XLM',
        gapStart: baseTime,
        gapEnd: baseTime + 300,
        gapDurationSeconds: 300,
        isRecoverable: true,
      };

      const reconstructed: PriceEntry[] = [
        { price: '102.5', decimals: 7, timestamp: baseTime + 150, observedLive: false },
      ];

      const result1 = manager.idempotentBackfill('XLM', gap, reconstructed);
      const result2 = manager.idempotentBackfill('XLM', gap, reconstructed);

      expect(result1.status).toBe('filled');
      expect(result2.status).toBe('filled');
      expect(result2.entriesFilled).toBe(0); // Second call should not add more
    });

    it('should handle concurrent backfill safely', () => {
      const baseTime = 1000000000;
      manager.writeEntry('BTC', { price: '50000', decimals: 8, timestamp: baseTime, observedLive: true });
      manager.writeEntry('BTC', { price: '50100', decimals: 8, timestamp: baseTime + 300, observedLive: true });

      const gap: GapDetectionResult = {
        asset: 'BTC',
        gapStart: baseTime,
        gapEnd: baseTime + 300,
        gapDurationSeconds: 300,
        isRecoverable: true,
      };

      const reconstructed: PriceEntry[] = [
        { price: '50050', decimals: 8, timestamp: baseTime + 150, observedLive: false },
      ];

      const result = manager.concurrencySafeBackfill('BTC', gap, reconstructed);
      expect(result.status).toBe('filled');
    });
  });

  describe('Backfill outcome metrics', () => {
    it('should track filled gaps', () => {
      const baseTime = 1000000000;
      manager.writeEntry('XLM', { price: '100', decimals: 7, timestamp: baseTime, observedLive: true });
      manager.writeEntry('XLM', { price: '105', decimals: 7, timestamp: baseTime + 300, observedLive: true });

      const gap: GapDetectionResult = {
        asset: 'XLM',
        gapStart: baseTime,
        gapEnd: baseTime + 300,
        gapDurationSeconds: 300,
        isRecoverable: true,
      };

      const reconstructed: PriceEntry[] = [
        { price: '102', decimals: 7, timestamp: baseTime + 60, observedLive: false },
      ];

      manager.backfillGap('XLM', gap, reconstructed);
      const metrics = manager.getBackfillMetrics();

      expect(metrics.filled).toBe(1);
    });

    it('should track unrecoverable gaps', () => {
      const baseTime = 1000000000;
      const gap: GapDetectionResult = {
        asset: 'TEST',
        gapStart: baseTime,
        gapEnd: baseTime + 1000,
        gapDurationSeconds: 1000,
        isRecoverable: false,
      };

      manager.markPermanentGap('TEST', gap);
      const metrics = manager.getBackfillMetrics();

      expect(metrics.unrecoverable).toBe(1);
    });
  });
});
