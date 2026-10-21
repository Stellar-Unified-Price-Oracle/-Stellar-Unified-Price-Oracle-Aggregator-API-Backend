import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  classifyDisagreement,
  getHistoricalCorrections,
  QualityObservation,
  recordHistoricalCorrection,
  replayAggregation,
  ReplayPolicy,
} from '../src/price-aggregation/quality';

const policy: ReplayPolicy = {
  version: 'test-v1', maxAgeSeconds: 30, staleWeight: 0.5,
  excludeAfterSeconds: 120, disagreementThresholdPercent: 2,
};
const sample = (): QualityObservation[] => [
  { asset: 'XLM', source: 'chainlink', price: 100n, decimals: 0, timestamp: 100, observedAt: 100, denomination: 'USD', venue: 'global' },
  { asset: 'XLM', source: 'band', price: 102n, decimals: 0, timestamp: 101, observedAt: 101, denomination: 'USD', venue: 'global' },
  { asset: 'XLM', source: 'redstone', price: 150n, decimals: 0, timestamp: 20, observedAt: 20, denomination: 'USD', venue: 'global' },
];

describe('price quality issues #699-#702', () => {
  it('measures stale-source influence and enforces fresh, stale, and excluded boundaries', () => {
    const result = replayAggregation('xlm', sample(), 0, 101, policy);
    expect(result.staleSources).toEqual(['redstone']);
    expect(result.excludedSources).toEqual([]);
    expect(result.staleImpact.freshOnlyPrice).toBe('101');
    expect(result.staleImpact.relativeDeltaPercent).not.toBeNull();
    expect(replayAggregation('xlm', sample(), 0, 141, policy).excludedSources).toContain('redstone');
    expect(() => replayAggregation('xlm', sample(), 10, 0, policy)).toThrow('Invalid replay window');
    expect(() => replayAggregation('xlm', sample(), 0, 101, { ...policy, staleWeight: 2 })).toThrow('Invalid replay policy');
  });

  it('classifies disagreement from timing, denomination, venue and provider evidence', () => {
    const base = sample().slice(0, 2);
    const cases: Array<[QualityObservation, string]> = [
      [{ ...base[0], source: 'timing', price: 150n, observedAt: 1 }, 'timing'],
      [{ ...base[0], source: 'currency', price: 150n, denomination: 'EUR' }, 'denomination'],
      [{ ...base[0], source: 'venue', price: 150n, venue: 'regional' }, 'market_venue'],
      [{ ...base[0], source: 'provider', price: 150n, providerError: 'stale response id' }, 'provider_error'],
    ];
    for (const [outlier, cause] of cases) {
      const result = classifyDisagreement([outlier, base[1]]);
      expect(result.find((item) => item.source === outlier.source)?.cause).toBe(cause);
      expect(result.find((item) => item.source === outlier.source)?.evidence.deviationPercent).toBeGreaterThan(2);
    }
    expect(classifyDisagreement([])).toEqual([]);
  });

  it('replays to the same byte-stable result regardless of input order', () => {
    const a = JSON.stringify(replayAggregation('XLM', sample(), 0, 101, policy));
    const b = JSON.stringify(replayAggregation('XLM', sample().reverse(), 0, 101, policy));
    expect(a).toBe(b);
  });

  it('retains corrected and prior values in an append-only, hash-linked revision history', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'price-corrections-'));
    try {
      const base = {
        asset: 'XLM', originalTimestamp: 50, correctedAt: 200, reason: 'provider published corrected observation',
        sourceEvidence: ['https://provider.example/correction/7'],
        previousValue: { price: '99', decimals: 7, source: 'chainlink', timestamp: 50 },
        correctedValue: { price: '101', decimals: 7, source: 'chainlink', timestamp: 50 },
      };
      const first = recordHistoricalCorrection(base, directory);
      const second = recordHistoricalCorrection({ ...base, correctedAt: 201, reason: 'second review' }, directory);
      expect(second.previousRevisionHash).toBe(first.revisionHash);
      expect(getHistoricalCorrections('XLM', directory)).toEqual([first, second]);
      expect(() => recordHistoricalCorrection({ ...base, reason: ' ', sourceEvidence: [] }, directory)).toThrow();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
