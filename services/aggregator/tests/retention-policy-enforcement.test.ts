import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';

interface PriceEntry {
  price: string;
  decimals: number;
  source: string;
  timestamp: number;
}

interface RetentionConfig {
  rawObservations: {
    retentionSeconds: number;
    maxEntries: number;
  };
  aggregates: {
    retentionSeconds: number;
    maxEntries: number;
  };
  auditRecords: {
    retentionSeconds: number;
    maxEntries: number;
  };
  derivedFeatures: {
    retentionSeconds: number;
    maxEntries: number;
  };
}

class RetentionPolicyEnforcer {
  private config: RetentionConfig;
  private dataDir: string;

  constructor(config: RetentionConfig, dataDir: string) {
    this.config = config;
    this.dataDir = dataDir;
  }

  enforceRetention(asset: string, entries: PriceEntry[], dataClass: keyof RetentionConfig): PriceEntry[] {
    const policy = this.config[dataClass];
    let retained = entries;

    if (policy.retentionSeconds > 0) {
      const now = Math.floor(Date.now() / 1000);
      const cutoff = now - policy.retentionSeconds;
      retained = retained.filter((e) => e.timestamp >= cutoff);
    }

    if (policy.maxEntries > 0 && retained.length > policy.maxEntries) {
      retained = retained.slice(-policy.maxEntries);
    }

    return retained;
  }

  enforceRetentionWithTime(
    asset: string,
    entries: PriceEntry[],
    dataClass: keyof RetentionConfig,
    now: number
  ): PriceEntry[] {
    const policy = this.config[dataClass];
    let retained = entries;

    if (policy.retentionSeconds > 0) {
      const cutoff = Math.floor(now / 1000) - policy.retentionSeconds;
      retained = retained.filter((e) => e.timestamp >= cutoff);
    }

    if (policy.maxEntries > 0 && retained.length > policy.maxEntries) {
      retained = retained.slice(-policy.maxEntries);
    }

    return retained;
  }

  scheduleRetentionJob(intervalMs: number): NodeJS.Timeout {
    return setInterval(() => {
      this.runRetentionJob();
    }, intervalMs);
  }

  private runRetentionJob(): void {
    const assets = this.getTrackedAssets();
    for (const asset of assets) {
      const filePath = path.join(this.dataDir, `${asset}.json`);
      if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const now = Date.now();

        for (const dataClass of Object.keys(this.config) as Array<keyof RetentionConfig>) {
          if (data[dataClass]) {
            data[dataClass] = this.enforceRetentionWithTime(asset, data[dataClass], dataClass, now);
          }
        }

        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
      }
    }
  }

  private getTrackedAssets(): string[] {
    if (!fs.existsSync(this.dataDir)) return [];
    return fs
      .readdirSync(this.dataDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace('.json', ''));
  }

  getRetentionWindow(dataClass: keyof RetentionConfig): { seconds: number; maxEntries: number } {
    const policy = this.config[dataClass];
    return {
      seconds: policy.retentionSeconds,
      maxEntries: policy.maxEntries,
    };
  }

  isUnpolledAssetPruned(asset: string): boolean {
    const filePath = path.join(this.dataDir, `${asset}.json`);
    if (!fs.existsSync(filePath)) return true;

    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const now = Math.floor(Date.now() / 1000);

    for (const dataClass of Object.keys(this.config) as Array<keyof RetentionConfig>) {
      if (data[dataClass]) {
        const entries = data[dataClass];
        if (entries.length > 0) {
          const oldestEntry = entries[0];
          const policy = this.config[dataClass];
          if (policy.retentionSeconds > 0 && oldestEntry.timestamp < now - policy.retentionSeconds) {
            return false;
          }
        }
      }
    }

    return true;
  }
}

describe('Issue #543: Single Enforceable Retention Policy', () => {
  let enforcer: RetentionPolicyEnforcer;
  let testDir: string;
  const retentionConfig: RetentionConfig = {
    rawObservations: {
      retentionSeconds: 7 * 24 * 60 * 60, // 7 days
      maxEntries: 100000,
    },
    aggregates: {
      retentionSeconds: 30 * 24 * 60 * 60, // 30 days
      maxEntries: 50000,
    },
    auditRecords: {
      retentionSeconds: 365 * 24 * 60 * 60, // 1 year
      maxEntries: 1000000,
    },
    derivedFeatures: {
      retentionSeconds: 90 * 24 * 60 * 60, // 90 days
      maxEntries: 500000,
    },
  };

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(tmpdir(), 'retention-test-'));
    enforcer = new RetentionPolicyEnforcer(retentionConfig, testDir);
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  describe('Retention configured per data class', () => {
    it('should have raw observations configured with 7 day retention', () => {
      const window = enforcer.getRetentionWindow('rawObservations');
      expect(window.seconds).toBe(7 * 24 * 60 * 60);
      expect(window.maxEntries).toBe(100000);
    });

    it('should have aggregates configured with 30 day retention', () => {
      const window = enforcer.getRetentionWindow('aggregates');
      expect(window.seconds).toBe(30 * 24 * 60 * 60);
      expect(window.maxEntries).toBe(50000);
    });

    it('should have audit records configured with 1 year retention', () => {
      const window = enforcer.getRetentionWindow('auditRecords');
      expect(window.seconds).toBe(365 * 24 * 60 * 60);
      expect(window.maxEntries).toBe(1000000);
    });

    it('should have derived features configured with 90 day retention', () => {
      const window = enforcer.getRetentionWindow('derivedFeatures');
      expect(window.seconds).toBe(90 * 24 * 60 * 60);
      expect(window.maxEntries).toBe(500000);
    });
  });

  describe('Schedule-driven retention enforcement', () => {
    it('should prune raw observations older than retention window', () => {
      const now = Date.now();
      const retentionSeconds = retentionConfig.rawObservations.retentionSeconds;

      const entries: PriceEntry[] = [
        { price: '100', decimals: 7, source: 'chainlink', timestamp: Math.floor(now / 1000) - retentionSeconds - 1000 },
        { price: '101', decimals: 7, source: 'chainlink', timestamp: Math.floor(now / 1000) - retentionSeconds + 1000 },
        { price: '102', decimals: 7, source: 'chainlink', timestamp: Math.floor(now / 1000) },
      ];

      const pruned = enforcer.enforceRetentionWithTime('XLM', entries, 'rawObservations', now);
      expect(pruned).toHaveLength(2);
      expect(pruned[0].price).toBe('101');
      expect(pruned[1].price).toBe('102');
    });

    it('should enforce maxEntries limit on aggregates', () => {
      const now = Date.now();
      const maxEntries = retentionConfig.aggregates.maxEntries;

      const entries: PriceEntry[] = Array.from({ length: maxEntries + 100 }, (_, i) => ({
        price: String(100 + i),
        decimals: 7,
        source: 'aggregator',
        timestamp: Math.floor(now / 1000) - 1000 + i,
      }));

      const pruned = enforcer.enforceRetentionWithTime('USDC', entries, 'aggregates', now);
      expect(pruned).toHaveLength(maxEntries);
      expect(pruned[0].price).toBe(String(100 + 100));
    });

    it('should not re-prune already pruned data', () => {
      const now = Date.now();
      const entries: PriceEntry[] = [
        { price: '100', decimals: 7, source: 'chainlink', timestamp: Math.floor(now / 1000) - 3600 },
        { price: '101', decimals: 7, source: 'chainlink', timestamp: Math.floor(now / 1000) - 1800 },
      ];

      const firstPass = enforcer.enforceRetentionWithTime('XLM', entries, 'rawObservations', now);
      const secondPass = enforcer.enforceRetentionWithTime('XLM', firstPass, 'rawObservations', now);

      expect(secondPass).toEqual(firstPass);
    });
  });

  describe('Unpolled assets pruned correctly', () => {
    it('should identify unpolled assets that exceed retention window', () => {
      const now = Date.now();
      const filePath = path.join(testDir, 'OLDTOKEN.json');

      const tooOldEntries: PriceEntry[] = [
        { price: '100', decimals: 7, source: 'chainlink', timestamp: Math.floor(now / 1000) - 365 * 24 * 60 * 60 - 1000 },
      ];

      const data = { rawObservations: tooOldEntries };
      fs.writeFileSync(filePath, JSON.stringify(data));

      expect(enforcer.isUnpolledAssetPruned('OLDTOKEN')).toBe(true);
    });

    it('should not prune assets within retention window', () => {
      const now = Date.now();
      const filePath = path.join(testDir, 'ACTIVETOKEN.json');

      const recentEntries: PriceEntry[] = [
        { price: '100', decimals: 7, source: 'chainlink', timestamp: Math.floor(now / 1000) - 1000 },
      ];

      const data = { rawObservations: recentEntries };
      fs.writeFileSync(filePath, JSON.stringify(data));

      expect(enforcer.isUnpolledAssetPruned('ACTIVETOKEN')).toBe(false);
    });
  });

  describe('Configured retention matches observed retention', () => {
    it('should retain data up to configured time window', () => {
      const now = Date.now();
      const retentionSecs = 7 * 24 * 60 * 60;

      const entries: PriceEntry[] = Array.from({ length: 100 }, (_, i) => ({
        price: String(100 + i),
        decimals: 7,
        source: 'chainlink',
        timestamp: Math.floor(now / 1000) - (i * 3600), // One per hour
      }));

      const retained = enforcer.enforceRetentionWithTime('XLM', entries, 'rawObservations', now);

      const oldestTimestamp = retained[0].timestamp;
      const cutoffTimestamp = Math.floor(now / 1000) - retentionSecs;

      expect(oldestTimestamp).toBeGreaterThanOrEqual(cutoffTimestamp);
      expect(retained[retained.length - 1].timestamp).toBeLessThanOrEqual(Math.floor(now / 1000));
    });

    it('should verify retention boundaries are respected', () => {
      const now = Date.now();
      const auditRetentionSecs = retentionConfig.auditRecords.retentionSeconds;

      const entries: PriceEntry[] = [
        { price: '100', decimals: 7, source: 'audit', timestamp: Math.floor(now / 1000) - auditRetentionSecs - 1 },
        { price: '101', decimals: 7, source: 'audit', timestamp: Math.floor(now / 1000) - auditRetentionSecs },
        { price: '102', decimals: 7, source: 'audit', timestamp: Math.floor(now / 1000) },
      ];

      const retained = enforcer.enforceRetentionWithTime('AUDIT', entries, 'auditRecords', now);

      expect(retained).toHaveLength(2);
      expect(retained.every((e) => e.timestamp >= Math.floor(now / 1000) - auditRetentionSecs)).toBe(true);
    });
  });

  describe('Retention isolation across data classes', () => {
    it('should not apply raw observations retention to aggregate data', () => {
      const now = Date.now();
      const rawRetention = retentionConfig.rawObservations.retentionSeconds;
      const aggregateRetention = retentionConfig.aggregates.retentionSeconds;

      const entries: PriceEntry[] = [
        { price: '100', decimals: 7, source: 'agg', timestamp: Math.floor(now / 1000) - rawRetention - 1000 },
        { price: '101', decimals: 7, source: 'agg', timestamp: Math.floor(now / 1000) },
      ];

      const prunedAsRaw = enforcer.enforceRetentionWithTime('TEST', entries, 'rawObservations', now);
      const prunedAsAggregate = enforcer.enforceRetentionWithTime('TEST', entries, 'aggregates', now);

      expect(prunedAsRaw).toHaveLength(1);
      expect(prunedAsAggregate).toHaveLength(2);
    });
  });
});
