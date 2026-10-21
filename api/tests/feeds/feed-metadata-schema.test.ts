import { describe, expect, it } from 'vitest';
import {
  assessFeedMetadataCompatibility,
  readFeedMetadata,
  validateFeedMetadata,
} from '../../src/feeds/feed-metadata-schema';

const valid = () => ({
  schemaVersion: 2,
  schemaRevision: 0,
  feedId: 'btc-usd',
  network: 'stellar:pubnet',
  base: { asset: 'BTC', issuer: null, decimals: 8 },
  quote: { asset: 'USD', issuer: null, decimals: 2 },
  precision: 7,
  eligibleSources: [
    { source: 'chainlink', weightBps: 3000, required: true },
    { source: 'redstone', weightBps: 2500, required: false },
  ],
  freshness: { heartbeatSeconds: 30, maxStalenessSeconds: 120, deviationThresholdBps: 50 },
  ownership: { team: 'market-data', owner: 'feeds@example.com', oncall: 'pagerduty:market-data' },
  lifecycle: { state: 'active', since: '2026-01-01T00:00:00Z' },
});

describe('feed metadata schema v2', () => {
  it('accepts a complete document including boundary precision values', () => {
    for (const precision of [0, 18]) {
      const result = validateFeedMetadata({ ...valid(), precision });
      expect(result.ok).toBe(true);
    }
    expect(validateFeedMetadata(valid()).ok).toBe(true);
  });

  it('rejects missing identity, units, freshness and ownership fields', () => {
    for (const field of ['feedId', 'network', 'base', 'quote', 'precision', 'eligibleSources', 'freshness', 'ownership', 'lifecycle']) {
      const doc: Record<string, unknown> = valid();
      delete doc[field];
      const result = validateFeedMetadata(doc);
      expect(result.ok, field).toBe(false);
      if (!result.ok) expect(result.errors.some((e) => e.path.includes(field))).toBe(true);
    }
  });

  it('rejects malformed units, duplicate sources and invalid freshness windows', () => {
    const badUnit = { ...valid(), base: { asset: 'BTC', decimals: 19 } };
    expect(validateFeedMetadata(badUnit).ok).toBe(false);

    const duplicate = valid();
    duplicate.eligibleSources = [
      { source: 'chainlink', weightBps: 5000, required: true },
      { source: 'chainlink', weightBps: 5000, required: false },
    ];
    expect(validateFeedMetadata(duplicate).ok).toBe(false);

    const invertedWindow = valid();
    invertedWindow.freshness = { heartbeatSeconds: 120, maxStalenessSeconds: 119 };
    expect(validateFeedMetadata(invertedWindow).ok).toBe(false);
  });

  it('requires a distinct successor for deprecated and retired feeds', () => {
    const missing = valid();
    missing.lifecycle = { state: 'deprecated', since: '2026-02-01T00:00:00Z' };
    expect(validateFeedMetadata(missing).ok).toBe(false);

    const self = valid();
    self.lifecycle = { state: 'retired', since: '2026-02-01T00:00:00Z', successorFeedId: 'btc-usd' };
    expect(validateFeedMetadata(self).ok).toBe(false);

    const ok = valid();
    ok.lifecycle = { state: 'retired', since: '2026-02-01T00:00:00Z', successorFeedId: 'btc-usd-v2' };
    expect(validateFeedMetadata(ok).ok).toBe(true);
  });

  it('strict writers reject unknown fields while readers ignore additive fields', () => {
    const withAdditive = { ...valid(), futureOptionalField: { anything: true } };
    expect(validateFeedMetadata(withAdditive).ok).toBe(false);

    const read = readFeedMetadata(withAdditive);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.compatibility.mode).toBe('exact');
  });

  it('classifies older, same and newer revisions', () => {
    expect(assessFeedMetadataCompatibility(valid()).mode).toBe('exact');
    expect(
      assessFeedMetadataCompatibility({ ...valid(), schemaRevision: 0 }, { major: 2, revision: 3 }).mode,
    ).toBe('backward-compatible');
    expect(
      assessFeedMetadataCompatibility({ ...valid(), schemaRevision: 5 }, { major: 2, revision: 3 }).mode,
    ).toBe('forward-degraded');
  });

  it('rejects a different major version and accepts a degraded newer revision end-to-end', () => {
    const futureMajor = { ...valid(), schemaVersion: 3 };
    const rejected = readFeedMetadata(futureMajor);
    expect(rejected.ok).toBe(false);

    const newerRevision = { ...valid(), schemaRevision: 4, futureOptionalField: true };
    const accepted = readFeedMetadata(newerRevision, { major: 2, revision: 3 });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.compatibility.mode).toBe('forward-degraded');
  });
});
