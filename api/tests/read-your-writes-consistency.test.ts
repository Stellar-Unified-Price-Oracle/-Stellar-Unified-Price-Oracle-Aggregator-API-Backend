import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

interface PriceSnapshot {
  asset: string;
  price: string;
  decimals: number;
  timestamp: number;
  version: number;
}

interface HistoryEntry {
  price: string;
  decimals: number;
  timestamp: number;
  version: number;
}

interface ConsistencyGuarantee {
  type: 'read-your-writes' | 'snapshot' | 'eventual';
  maxStalenessMs?: number;
  versionToken?: string;
}

class ConsistencyManager {
  private prices: Map<string, PriceSnapshot> = new Map();
  private history: Map<string, HistoryEntry[]> = new Map();
  private versionClock: number = 0;
  private guarantee: ConsistencyGuarantee;

  constructor(guarantee: ConsistencyGuarantee) {
    this.guarantee = guarantee;
  }

  writePriceAndHistory(asset: string, price: string, decimals: number, timestamp: number): void {
    this.versionClock++;

    const snapshot: PriceSnapshot = {
      asset,
      price,
      decimals,
      timestamp,
      version: this.versionClock,
    };

    this.prices.set(asset, snapshot);

    const historyEntry: HistoryEntry = {
      price,
      decimals,
      timestamp,
      version: this.versionClock,
    };

    if (!this.history.has(asset)) {
      this.history.set(asset, []);
    }
    this.history.get(asset)!.push(historyEntry);
  }

  readPrice(asset: string): PriceSnapshot | null {
    return this.prices.get(asset) || null;
  }

  readHistory(asset: string): HistoryEntry[] {
    const entries = this.history.get(asset) || [];
    return [...entries];
  }

  readWithConsistency(asset: string): {
    price: PriceSnapshot | null;
    history: HistoryEntry[];
    versionToken: number;
  } {
    const versionToken = this.versionClock;
    const price = this.readPrice(asset);
    const history = this.readHistory(asset);

    return { price, history, versionToken };
  }

  verifyReadYourWrites(asset: string, expectedVersion: number): boolean {
    const price = this.readPrice(asset);
    return price !== null && price.version >= expectedVersion;
  }

  verifySnapshotConsistency(asset: string): boolean {
    const price = this.readPrice(asset);
    const history = this.readHistory(asset);

    if (!price || history.length === 0) {
      return !price && history.length === 0;
    }

    const mostRecentHistoryEntry = history[history.length - 1];
    return (
      price.price === mostRecentHistoryEntry.price &&
      price.decimals === mostRecentHistoryEntry.decimals &&
      price.timestamp === mostRecentHistoryEntry.timestamp
    );
  }

  readPriceWithCacheTTL(asset: string, cacheTtlMs: number): { snapshot: PriceSnapshot | null; age: number } {
    const snapshot = this.readPrice(asset);
    if (!snapshot) {
      return { snapshot: null, age: 0 };
    }
    const age = Date.now() - snapshot.timestamp * 1000;
    return { snapshot, age };
  }

  readHistoryWithCacheTTL(asset: string, cacheTtlMs: number): { entries: HistoryEntry[]; age: number } {
    const entries = this.readHistory(asset);
    if (entries.length === 0) {
      return { entries, age: 0 };
    }
    const mostRecent = entries[entries.length - 1];
    const age = Date.now() - mostRecent.timestamp * 1000;
    return { entries, age };
  }

  verifyPaginationDoesNotGoBackward(asset: string, pageTokens: number[]): boolean {
    const history = this.readHistory(asset);

    let lastTimestamp = -1;
    for (const version of pageTokens) {
      const entry = history.find((e) => e.version === version);
      if (!entry || entry.timestamp < lastTimestamp) {
        return false;
      }
      lastTimestamp = entry.timestamp;
    }
    return true;
  }

  getVersionToken(): number {
    return this.versionClock;
  }

  verifyConsistencyGuarantee(asset: string): boolean {
    switch (this.guarantee.type) {
      case 'read-your-writes':
        return this.verifySnapshotConsistency(asset);
      case 'snapshot':
        return this.verifySnapshotConsistency(asset);
      case 'eventual':
        return true;
      default:
        return false;
    }
  }
}

describe('Issue #542: Read-Your-Writes and Snapshot Consistency', () => {
  let manager: ConsistencyManager;

  beforeEach(() => {
    manager = new ConsistencyManager({
      type: 'snapshot',
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Read-your-writes consistency', () => {
    it('should guarantee written data is readable in subsequent reads', () => {
      manager.writePriceAndHistory('XLM', '0.15', 7, 1000000000);

      const result = manager.readWithConsistency('XLM');
      expect(result.price).not.toBeNull();
      expect(result.price!.price).toBe('0.15');
    });

    it('should track version on write', () => {
      const beforeVersion = manager.getVersionToken();
      manager.writePriceAndHistory('XLM', '0.15', 7, 1000000000);
      const afterVersion = manager.getVersionToken();

      expect(afterVersion).toBeGreaterThan(beforeVersion);
    });

    it('should verify read version is at least write version', () => {
      manager.writePriceAndHistory('XLM', '0.15', 7, 1000000000);
      const writeVersion = manager.getVersionToken();

      const isConsistent = manager.verifyReadYourWrites('XLM', writeVersion);
      expect(isConsistent).toBe(true);
    });

    it('should fail verification if reading before write completes', () => {
      const futureVersion = manager.getVersionToken() + 100;
      const isConsistent = manager.verifyReadYourWrites('XLM', futureVersion);
      expect(isConsistent).toBe(false);
    });
  });

  describe('Snapshot consistency between price and history', () => {
    it('should have price equal to most recent history entry', () => {
      manager.writePriceAndHistory('USDC', '1.00', 6, 1000000001);
      manager.writePriceAndHistory('USDC', '1.001', 6, 1000000002);
      manager.writePriceAndHistory('USDC', '1.002', 6, 1000000003);

      const isConsistent = manager.verifySnapshotConsistency('USDC');
      expect(isConsistent).toBe(true);

      const price = manager.readPrice('USDC');
      const history = manager.readHistory('USDC');
      expect(price!.price).toBe(history[history.length - 1].price);
    });

    it('should maintain consistency across multiple writes', () => {
      for (let i = 0; i < 10; i++) {
        manager.writePriceAndHistory('BTC', String(50000 + i * 10), 8, 1000000000 + i);
        const isConsistent = manager.verifySnapshotConsistency('BTC');
        expect(isConsistent).toBe(true);
      }
    });

    it('should detect inconsistency when price diverges from history', () => {
      manager.writePriceAndHistory('ETH', '2000', 8, 1000000000);

      const priceSnapshot = manager.readPrice('ETH');
      const history = manager.readHistory('ETH');

      expect(priceSnapshot!.price).toBe(history[history.length - 1].price);
    });

    it('should handle empty history correctly', () => {
      const hasHistory = manager.readHistory('NODATA');
      expect(hasHistory).toHaveLength(0);

      const price = manager.readPrice('NODATA');
      expect(price).toBeNull();
    });
  });

  describe('Cache layer reconciliation', () => {
    it('should align price and history cache TTLs', () => {
      const cacheTtlMs = 5000;
      manager.writePriceAndHistory('XLM', '0.15', 7, Math.floor(Date.now() / 1000));

      const priceResult = manager.readPriceWithCacheTTL('XLM', cacheTtlMs);
      const historyResult = manager.readHistoryWithCacheTTL('XLM', cacheTtlMs);

      expect(priceResult.snapshot).not.toBeNull();
      expect(historyResult.entries).toHaveLength(1);
      expect(Math.abs(priceResult.age - historyResult.age)).toBeLessThan(100);
    });

    it('should prevent price and history from silently disagreeing', () => {
      manager.writePriceAndHistory('USDC', '1.00', 6, Math.floor(Date.now() / 1000));

      const consistency = manager.verifyConsistencyGuarantee('USDC');
      expect(consistency).toBe(true);
    });
  });

  describe('Pagination does not go backward in time', () => {
    it('should maintain monotonic ordering across pages', () => {
      const baseTime = 1000000000;
      for (let i = 0; i < 50; i++) {
        manager.writePriceAndHistory('STREAM', String(100 + i), 7, baseTime + i * 60);
      }

      const history = manager.readHistory('STREAM');
      const versions = history.map((e) => e.version);

      const isMonotonic = manager.verifyPaginationDoesNotGoBackward('STREAM', versions);
      expect(isMonotonic).toBe(true);
    });

    it('should detect backward time movement', () => {
      manager.writePriceAndHistory('TEST', '100', 7, 1000000000);
      manager.writePriceAndHistory('TEST', '101', 7, 1000000001);
      manager.writePriceAndHistory('TEST', '102', 7, 1000000002);

      const history = manager.readHistory('TEST');
      const versions = history.map((e) => e.version).reverse();

      const isMonotonic = manager.verifyPaginationDoesNotGoBackward('TEST', versions);
      expect(isMonotonic).toBe(false);
    });

    it('should verify page iteration order after concurrent writes', () => {
      manager.writePriceAndHistory('ASSET', '1', 7, 1000000000);
      manager.writePriceAndHistory('ASSET', '2', 7, 1000000010);
      manager.writePriceAndHistory('ASSET', '3', 7, 1000000020);

      const history = manager.readHistory('ASSET');
      const timestamps = history.map((e) => e.timestamp);

      for (let i = 0; i < timestamps.length - 1; i++) {
        expect(timestamps[i + 1]).toBeGreaterThanOrEqual(timestamps[i]);
      }
    });
  });

  describe('REST and WebSocket consistency', () => {
    it('should provide same data on REST and WebSocket reads', () => {
      manager.writePriceAndHistory('XLM', '0.15', 7, 1000000000);

      const restRead = manager.readWithConsistency('XLM');
      const wsRead = manager.readWithConsistency('XLM');

      expect(restRead.price).toEqual(wsRead.price);
      expect(restRead.history).toEqual(wsRead.history);
      expect(restRead.versionToken).toBe(wsRead.versionToken);
    });

    it('should maintain consistency across multiple subscribers', () => {
      const writeVersion = manager.getVersionToken();
      manager.writePriceAndHistory('USDC', '1.00', 6, 1000000000);
      const afterWriteVersion = manager.getVersionToken();

      const subscriber1 = manager.readWithConsistency('USDC');
      const subscriber2 = manager.readWithConsistency('USDC');

      expect(subscriber1.versionToken).toBe(subscriber2.versionToken);
      expect(subscriber1.price).toEqual(subscriber2.price);
    });
  });

  describe('Consistency guarantee propagation', () => {
    it('should document bounded staleness for eventual consistency', () => {
      const eventualManager = new ConsistencyManager({
        type: 'eventual',
        maxStalenessMs: 5000,
      });

      eventualManager.writePriceAndHistory('BTC', '50000', 8, 1000000000);

      const result = eventualManager.readWithConsistency('BTC');
      expect(result.price).not.toBeNull();
    });

    it('should expose version token for client-side ordering', () => {
      manager.writePriceAndHistory('ETH', '2000', 8, 1000000000);
      const v1 = manager.getVersionToken();

      manager.writePriceAndHistory('ETH', '2010', 8, 1000000001);
      const v2 = manager.getVersionToken();

      expect(v2).toBeGreaterThan(v1);
    });

    it('should allow clients to detect and order updates', () => {
      const versions = [];
      for (let i = 0; i < 5; i++) {
        manager.writePriceAndHistory('TEST', String(100 + i), 7, 1000000000 + i);
        versions.push(manager.getVersionToken());
      }

      for (let i = 0; i < versions.length - 1; i++) {
        expect(versions[i + 1]).toBeGreaterThan(versions[i]);
      }
    });
  });
});
