import { describe, it, expect, beforeEach } from 'vitest';

interface HistoryEntry {
  price: string;
  decimals: number;
  source: string;
  timestamp: number;
}

interface ArchivalConfig {
  archiveAfterSeconds: number;
  retentionSeconds: number;
}

class FileArchivalManager {
  private config: ArchivalConfig;

  constructor(config: ArchivalConfig) {
    this.config = config;
  }

  identifyArchiveCandidates(history: HistoryEntry[]): HistoryEntry[] {
    const cutoff = Math.floor(Date.now() / 1000) - this.config.archiveAfterSeconds;
    return history.filter((h) => h.timestamp < cutoff);
  }

  identifyArchiveCandidatesAtTime(
    history: HistoryEntry[],
    nowSeconds: number,
  ): HistoryEntry[] {
    const cutoff = nowSeconds - this.config.archiveAfterSeconds;
    return history.filter((h) => h.timestamp < cutoff);
  }

  splitActiveAndArchive(
    history: HistoryEntry[],
    nowSeconds: number,
  ): { active: HistoryEntry[]; archive: HistoryEntry[] } {
    const cutoff = nowSeconds - this.config.archiveAfterSeconds;
    const archive: HistoryEntry[] = [];
    const active: HistoryEntry[] = [];
    for (const entry of history) {
      if (entry.timestamp < cutoff) {
        archive.push(entry);
      } else {
        active.push(entry);
      }
    }
    return { active, archive };
  }

  /** Identify cold storage files whose cutoff timestamp is older than retention. */
  identifyColdFilesForPurge(
    files: { path: string; cutoffTimestamp: number }[],
    nowSeconds: number,
  ): string[] {
    if (this.config.retentionSeconds <= 0) return [];
    const cutoff = nowSeconds - this.config.retentionSeconds;
    return files.filter((f) => f.cutoffTimestamp < cutoff).map((f) => f.path);
  }

  /** Build an archive filename matching the format: history_{ASSET}_{cutoff}_{ts}.ndjson.gz */
  buildArchiveFilename(
    asset: string,
    cutoffSeconds: number,
  ): string {
    return `history_${asset}_${cutoffSeconds}_${Date.now()}.ndjson.gz`;
  }

  /** Parse cutoff timestamp from archive filename. */
  parseCutoffFromFilename(filename: string): number | null {
    const parts = filename.replace('.ndjson.gz', '').split('_');
    return parseInt(parts[2], 10) || null;
  }

  /** Merge restored entries deduplicating by timestamp:source. */
  mergeRestoredEntries(
    current: HistoryEntry[],
    restored: HistoryEntry[],
  ): HistoryEntry[] {
    const existing = new Set(current.map((h) => `${h.timestamp}:${h.source}`));
    const merged = [...current];
    for (const entry of restored) {
      if (!existing.has(`${entry.timestamp}:${entry.source}`)) {
        merged.push(entry);
        existing.add(`${entry.timestamp}:${entry.source}`);
      }
    }
    merged.sort((a, b) => a.timestamp - b.timestamp);
    return merged;
  }
}

describe('File Archival Service', () => {
  let manager: FileArchivalManager;
  const DAY = 86400;

  beforeEach(() => {
    manager = new FileArchivalManager({
      archiveAfterSeconds: DAY * 90,
      retentionSeconds: DAY * 365,
    });
  });

  describe('Archive Candidate Identification', () => {
    it('should identify entries older than archive threshold', () => {
      const nowSeconds = Math.floor(Date.now() / 1000);

      const history: HistoryEntry[] = [
        { price: '100', decimals: 7, source: 'chainlink', timestamp: nowSeconds - DAY * 120 },
        { price: '101', decimals: 7, source: 'redstone', timestamp: nowSeconds - DAY * 95 },
        { price: '102', decimals: 7, source: 'band', timestamp: nowSeconds - DAY * 60 },
        { price: '103', decimals: 7, source: 'reflector', timestamp: nowSeconds - DAY * 7 },
        { price: '104', decimals: 7, source: 'chainlink', timestamp: nowSeconds },
      ];

      const candidates = manager.identifyArchiveCandidatesAtTime(history, nowSeconds);

      expect(candidates).toHaveLength(2);
      expect(candidates[0].price).toBe('100');
      expect(candidates[1].price).toBe('101');
    });

    it('should return empty when all entries are within threshold', () => {
      const nowSeconds = Math.floor(Date.now() / 1000);

      const history: HistoryEntry[] = [
        { price: '100', decimals: 7, source: 'chainlink', timestamp: nowSeconds - DAY * 10 },
        { price: '101', decimals: 7, source: 'redstone', timestamp: nowSeconds },
      ];

      const candidates = manager.identifyArchiveCandidatesAtTime(history, nowSeconds);
      expect(candidates).toHaveLength(0);
    });

    it('should archive all entries when all are old', () => {
      const nowSeconds = Math.floor(Date.now() / 1000);

      const history: HistoryEntry[] = [
        { price: '100', decimals: 7, source: 'chainlink', timestamp: nowSeconds - DAY * 200 },
        { price: '101', decimals: 7, source: 'redstone', timestamp: nowSeconds - DAY * 180 },
      ];

      const candidates = manager.identifyArchiveCandidatesAtTime(history, nowSeconds);
      expect(candidates).toHaveLength(2);
    });
  });

  describe('Split Active and Archive', () => {
    it('should correctly split entries into active and archive', () => {
      const nowSeconds = Math.floor(Date.now() / 1000);

      const history: HistoryEntry[] = [
        { price: '100', decimals: 7, source: 'chainlink', timestamp: nowSeconds - DAY * 120 },
        { price: '101', decimals: 7, source: 'redstone', timestamp: nowSeconds - DAY * 60 },
        { price: '102', decimals: 7, source: 'band', timestamp: nowSeconds },
      ];

      const { active, archive } = manager.splitActiveAndArchive(history, nowSeconds);

      expect(archive).toHaveLength(1);
      expect(archive[0].price).toBe('100');
      expect(active).toHaveLength(2);
      expect(active[0].price).toBe('101');
      expect(active[1].price).toBe('102');
    });

    it('should maintain ordering in both active and archive', () => {
      const nowSeconds = Math.floor(Date.now() / 1000);

      const history: HistoryEntry[] = [
        { price: 'a', decimals: 7, source: 's1', timestamp: 1000 },
        { price: 'b', decimals: 7, source: 's2', timestamp: 2000 },
        { price: 'c', decimals: 7, source: 's3', timestamp: 3000 },
        { price: 'd', decimals: 7, source: 's4', timestamp: 4000 },
      ];

      const { active, archive } = manager.splitActiveAndArchive(history, nowSeconds);

      for (let i = 1; i < archive.length; i++) {
        expect(archive[i].timestamp).toBeGreaterThan(archive[i - 1].timestamp);
      }
      for (let i = 1; i < active.length; i++) {
        expect(active[i].timestamp).toBeGreaterThan(active[i - 1].timestamp);
      }
    });
  });

  describe('Cold File Retention Purge', () => {
    it('should identify cold files older than retention', () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const mgr = new FileArchivalManager({
        archiveAfterSeconds: DAY * 90,
        retentionSeconds: DAY * 365,
      });

      const files = [
        { path: 'history_XLM_1000_2000.ndjson.gz', cutoffTimestamp: 1000 },
        { path: 'history_BTC_2000_3000.ndjson.gz', cutoffTimestamp: 2000 },
        { path: 'history_ETH_3000_4000.ndjson.gz', cutoffTimestamp: nowSeconds - DAY * 10 },
      ];

      const toPurge = mgr.identifyColdFilesForPurge(files, nowSeconds);

      expect(toPurge).toHaveLength(2);
      expect(toPurge).toContain('history_XLM_1000_2000.ndjson.gz');
      expect(toPurge).toContain('history_BTC_2000_3000.ndjson.gz');
    });

    it('should not purge any files when retention is disabled', () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const mgr = new FileArchivalManager({
        archiveAfterSeconds: DAY * 90,
        retentionSeconds: 0,
      });

      const files = [
        { path: 'history_XLM_1000_2000.ndjson.gz', cutoffTimestamp: 1000 },
      ];

      const toPurge = mgr.identifyColdFilesForPurge(files, nowSeconds);
      expect(toPurge).toHaveLength(0);
    });

    it('should purge all files when retention is very short', () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const mgr = new FileArchivalManager({
        archiveAfterSeconds: DAY * 90,
        retentionSeconds: DAY * 1,
      });

      const files = [
        { path: 'history_XLM_1000_2000.ndjson.gz', cutoffTimestamp: 1000 },
        { path: 'history_BTC_2000_3000.ndjson.gz', cutoffTimestamp: 2000 },
      ];

      const toPurge = mgr.identifyColdFilesForPurge(files, nowSeconds);

      expect(toPurge).toHaveLength(2);
    });
  });

  describe('Archive Filename Parsing', () => {
    it('should build correct archive filename', () => {
      const filename = manager.buildArchiveFilename('XLM', 1719000000);
      expect(filename).toMatch(/^history_XLM_1719000000_\d+\.ndjson\.gz$/);
    });

    it('should parse cutoff timestamp from filename', () => {
      const cutoff = manager.parseCutoffFromFilename('history_XLM_1719000000_2000.ndjson.gz');
      expect(cutoff).toBe(1719000000);
    });

    it('should return null for invalid filename', () => {
      const cutoff = manager.parseCutoffFromFilename('not_a_valid_file.gz');
      expect(cutoff).toBeNull();
    });
  });

  describe('Restore (Merge Deduplication)', () => {
    it('should merge restored entries without duplicates', () => {
      const current: HistoryEntry[] = [
        { price: '100', decimals: 7, source: 'chainlink', timestamp: 3000 },
        { price: '101', decimals: 7, source: 'redstone', timestamp: 4000 },
      ];

      const restored: HistoryEntry[] = [
        { price: '99', decimals: 7, source: 'band', timestamp: 1000 },
        { price: '100', decimals: 7, source: 'chainlink', timestamp: 3000 },
        { price: '102', decimals: 7, source: 'reflector', timestamp: 2000 },
      ];

      const merged = manager.mergeRestoredEntries(current, restored);

      expect(merged).toHaveLength(4);
      expect(merged[0].timestamp).toBe(1000);
      expect(merged[1].timestamp).toBe(2000);
      expect(merged[2].timestamp).toBe(3000);
      expect(merged[3].timestamp).toBe(4000);
    });

    it('should handle empty restored list', () => {
      const current: HistoryEntry[] = [
        { price: '100', decimals: 7, source: 'chainlink', timestamp: 3000 },
      ];

      const merged = manager.mergeRestoredEntries(current, []);
      expect(merged).toHaveLength(1);
    });

    it('should handle empty current list', () => {
      const restored: HistoryEntry[] = [
        { price: '99', decimals: 7, source: 'band', timestamp: 1000 },
      ];

      const merged = manager.mergeRestoredEntries([], restored);
      expect(merged).toHaveLength(1);
    });

    it('should maintain sorted order after merge', () => {
      const current: HistoryEntry[] = [
        { price: 'c', decimals: 7, source: 's1', timestamp: 30 },
      ];

      const restored: HistoryEntry[] = [
        { price: 'a', decimals: 7, source: 's2', timestamp: 10 },
        { price: 'b', decimals: 7, source: 's3', timestamp: 20 },
        { price: 'd', decimals: 7, source: 's4', timestamp: 40 },
      ];

      const merged = manager.mergeRestoredEntries(current, restored);

      for (let i = 1; i < merged.length; i++) {
        expect(merged[i].timestamp).toBeGreaterThanOrEqual(merged[i - 1].timestamp);
      }
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty history', () => {
      const candidates = manager.identifyArchiveCandidates([]);
      expect(candidates).toEqual([]);
    });

    it('should handle single entry within threshold', () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const history: HistoryEntry[] = [
        { price: '100', decimals: 7, source: 'chainlink', timestamp: nowSeconds },
      ];
      const { active, archive } = manager.splitActiveAndArchive(history, nowSeconds);
      expect(archive).toHaveLength(0);
      expect(active).toHaveLength(1);
    });

    it('should handle zero archive threshold (archive all before now)', () => {
      const mgr = new FileArchivalManager({
        archiveAfterSeconds: 0,
        retentionSeconds: 0,
      });

      const nowSeconds = Math.floor(Date.now() / 1000);
      const history: HistoryEntry[] = [
        { price: '100', decimals: 7, source: 'chainlink', timestamp: nowSeconds - 1 },
        { price: '101', decimals: 7, source: 'redstone', timestamp: nowSeconds },
      ];

      const candidates = mgr.identifyArchiveCandidatesAtTime(history, nowSeconds);
      expect(candidates).toHaveLength(1);
      expect(candidates[0].price).toBe('100');
    });

    it('should handle very large archive threshold (archive nothing)', () => {
      const mgr = new FileArchivalManager({
        archiveAfterSeconds: DAY * 365 * 10,
        retentionSeconds: 0,
      });

      const nowSeconds = Math.floor(Date.now() / 1000);
      const history: HistoryEntry[] = [
        { price: '100', decimals: 7, source: 'chainlink', timestamp: nowSeconds - DAY * 365 },
        { price: '101', decimals: 7, source: 'redstone', timestamp: nowSeconds },
      ];

      const candidates = mgr.identifyArchiveCandidatesAtTime(history, nowSeconds);
      expect(candidates).toHaveLength(0);
    });
  });

  describe('Integration Scenarios', () => {
    it('should process multi-asset archival correctly', () => {
      const nowSeconds = Math.floor(Date.now() / 1000);

      const xlmHistory: HistoryEntry[] = [
        { price: '0.08', decimals: 7, source: 'chainlink', timestamp: nowSeconds - DAY * 120 },
        { price: '0.09', decimals: 7, source: 'redstone', timestamp: nowSeconds - DAY * 10 },
        { price: '0.10', decimals: 7, source: 'band', timestamp: nowSeconds },
      ];

      const btcHistory: HistoryEntry[] = [
        { price: '60000', decimals: 8, source: 'chainlink', timestamp: nowSeconds - DAY * 100 },
        { price: '65000', decimals: 8, source: 'redstone', timestamp: nowSeconds },
      ];

      const xlmResult = manager.splitActiveAndArchive(xlmHistory, nowSeconds);
      const btcResult = manager.splitActiveAndArchive(btcHistory, nowSeconds);

      expect(xlmResult.archive).toHaveLength(1);
      expect(xlmResult.active).toHaveLength(2);
      expect(btcResult.archive).toHaveLength(1);
      expect(btcResult.active).toHaveLength(1);
    });

    it('should handle archival with no candidates', () => {
      const nowSeconds = Math.floor(Date.now() / 1000);

      const history: HistoryEntry[] = [
        { price: '100', decimals: 7, source: 'chainlink', timestamp: nowSeconds },
        { price: '101', decimals: 7, source: 'redstone', timestamp: nowSeconds + 1 },
      ];

      const { active, archive } = manager.splitActiveAndArchive(history, nowSeconds);
      expect(archive).toHaveLength(0);
      expect(active).toHaveLength(2);
    });
  });
});
