import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { loadCorpus, scoreWindow, backtestFreshness, Reference } from '../src/price-quality/benchmark';
import { freshnessBudget, isFresh } from '../src/price-quality/freshness';
import { PriceAggregator } from '../src/price-aggregation/aggregator';

vi.mock('../src/infrastructure/config', () => ({ config: { stalenessThresholdMs: 60000 } }));
vi.mock('../src/observability/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('../src/observability/alert-manager', () => ({ alertManager: { emit: vi.fn(), checkPrice: vi.fn() } }));

const policy = { minAgeMs: 5000, baseAgeMs: 30000, hardMaxAgeMs: 60000, sensitivity: 10 };
const root = new URL('../../../benchmarks/price-quality/v1/', import.meta.url);
const raw = readFileSync(new URL('references.jsonl', root), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));
const corpus = loadCorpus(raw, manifest);
const ref: Reference = { asset: 'BTC', timestamp: 100, price: '100', reference: 'coinmetrics-price-usd' };
const prediction = { asset: 'BTC', timestamp: 100, price: '101', confidence: 1, observedAt: 100 };
afterEach(() => vi.useRealTimers());

describe('independent benchmark and calibration', () => {
  it('pins two complete years for both assets and rejects corrupted, missing and duplicate rows', () => {
    expect(corpus).toHaveLength(1462);
    expect(() => loadCorpus(raw + '\n', manifest)).toThrow('checksum');
    const changed = raw.split('\n').slice(1).join('\n');
    expect(() => loadCorpus(changed, { ...manifest, sha256: createHash('sha256').update(changed).digest('hex') })).toThrow('coverage');
    const duplicate = raw + raw.split('\n')[0] + '\n';
    expect(() => loadCorpus(duplicate, { ...manifest, sha256: createHash('sha256').update(duplicate).digest('hex') })).toThrow('Duplicate');
  });
  it('computes exact relative error, includes confidence=1 and enforces half-open windows', () => {
    const report = scoreWindow([ref], [prediction], 100, 101, 100, 1);
    expect(report.curve[4]).toMatchObject({ count: 1, meanErrorBps: 100, p95ErrorBps: 100, status: 'pass', withinBoundRate: 1 });
    expect(report.coverage).toBe(1);
    expect(scoreWindow([ref], [prediction], 99, 100).outsideWindow).toBe(1);
    expect(scoreWindow([ref], [], 100, 101).curve[4].status).toBe('insufficient-data');
  });
  it('counts gaps without nearest-neighbor or forward matching and fails high error', () => {
    expect(scoreWindow([ref], [{ ...prediction, timestamp: 101 }], 100, 102).unmatched).toBe(1);
    expect(scoreWindow([ref], [{ ...prediction, price: '102' }], 100, 101, 100, 1).curve[4].status).toBe('fail');
    expect(scoreWindow([ref], [{ ...prediction, observedAt: null }], 100, 101).unverifiedAge).toBe(1);
  });
  it('rejects malformed, duplicated, infinite and zero-price samples or invalid bounds', () => {
    for (const bad of [{ ...prediction, price: '0' }, { ...prediction, confidence: NaN }, { ...prediction, confidence: 1.1 }, { ...prediction, secret: 'no' }]) {
      expect(() => scoreWindow([ref], [bad], 100, 101)).toThrow();
    }
    expect(() => scoreWindow([ref], [prediction, prediction], 100, 101)).toThrow('Duplicate');
    expect(() => scoreWindow([ref], [], 101, 100)).toThrow();
  });
});

describe('bounded freshness and evidence', () => {
  it('tightens monotonically and cannot cross hard maximum at any volatility', () => {
    let last = policy.baseAgeMs;
    for (const volatility of [0, 1, 100, 1000, 1000000, Number.MAX_VALUE]) {
      const budget = freshnessBudget(policy, volatility);
      expect(budget).toBeLessThanOrEqual(last);
      expect(budget).toBeGreaterThanOrEqual(policy.minAgeMs);
      expect(budget).toBeLessThanOrEqual(policy.hardMaxAgeMs);
      last = budget;
    }
    expect(isFresh(100, 100000 + policy.hardMaxAgeMs, policy.hardMaxAgeMs)).toBe(false);
    expect(isFresh(100, 100000 + policy.minAgeMs - 1, policy.minAgeMs)).toBe(true);
    for (const time of [null, undefined, NaN, -1, 101]) expect(isFresh(time, 100000, 5000)).toBe(false);
    expect(() => freshnessBudget({ ...policy, hardMaxAgeMs: 1 }, 0)).toThrow();
    expect(() => freshnessBudget(policy, NaN)).toThrow();
    for (const invalid of [null, false, 0, {}, { ...policy, sensitivity: -1 }]) {
      expect(() => new PriceAggregator(undefined, invalid as never)).toThrow();
    }
  });
  it('replays the complete corpus deterministically with zero hard-limit violations', () => {
    const report = backtestFreshness(corpus, policy);
    expect(report.comparisons).toBe(10220);
    expect(report.hardLimitViolations).toBe(0);
    expect(report.adaptiveAccepted).toBeLessThan(report.fixedAccepted);
    expect(backtestFreshness([...corpus].reverse(), policy)).toEqual(report);
  });
  it('captures mixed precision and exclusions from the actual result without raw payload leakage', () => {
    vi.useFakeTimers(); vi.setSystemTime(100000);
    const aggregator = new PriceAggregator(undefined, policy);
    aggregator.updateSourcePrice({ asset: 'BTC', source: 'chainlink', price: 10000n, decimals: 2, timestamp: 100, observedAt: 100 });
    aggregator.updateSourcePrice({ asset: 'BTC', source: 'redstone', price: 1000000n, decimals: 4, timestamp: 100, observedAt: 100 });
    aggregator.updateSourcePrice({ asset: 'BTC', source: 'band', price: 100n, decimals: 0, timestamp: 1, observedAt: 1, secret: 'private' } as never);
    const result = aggregator.getLatestForAsset('btc');
    const bundle = aggregator.getEvidence('BTC')!;
    expect(bundle.result).toEqual(result);
    expect(bundle.quorum).toEqual({ available: 3, contributing: 2, minimum: 1, met: true });
    expect(bundle.observations[0].normalizedPrice).toBe('1000000');
    expect(bundle.observations[2]).toMatchObject({ included: false, reasons: ['outside-freshness-policy'] });
    expect(JSON.stringify(bundle)).not.toContain('private');
    const { id, ...content } = bundle;
    expect(id).toBe(createHash('sha256').update(JSON.stringify(content)).digest('hex'));
    bundle.observations.length = 0;
    expect(aggregator.getEvidence('BTC')!.observations).toHaveLength(3);
    vi.setSystemTime(160000);
    expect(aggregator.getLatestForAsset('BTC')).toBeNull();
    expect(aggregator.getEvidence('BTC')).toMatchObject({ result: null, quorum: { contributing: 0, met: false } });
  });
  it('excludes suspicious sources using breaker keys and rejects suspicious-only bounded decisions', () => {
    vi.useFakeTimers(); vi.setSystemTime(100000);
    const aggregator = new PriceAggregator(undefined, policy);
    aggregator.updateSourcePrice({ asset: 'BTC', source: 'chainlink', price: 100n, decimals: 0, timestamp: 100, observedAt: 100 });
    aggregator.updateSourcePrice({ asset: 'BTC', source: 'redstone', price: 100n, decimals: 0, timestamp: 100, observedAt: 100 });
    aggregator.updateSourcePrice({ asset: 'BTC', source: 'band', price: 1000n, decimals: 0, timestamp: 100, observedAt: 100 });
    expect(aggregator.getLatestForAsset('BTC')!.price).toBe('100');
    expect(aggregator.getEvidence('BTC')!.observations[2]).toMatchObject({ included: false, reasons: ['suspicious'] });
    vi.setSystemTime(125000);
    aggregator.updateSourcePrice({ asset: 'BTC', source: 'band', price: 1000n, decimals: 0, timestamp: 125, observedAt: 125 });
    vi.setSystemTime(130001);
    expect(aggregator.getLatestForAsset('BTC')).toBeNull();
  });
  it('uses lagged volatility and repeated reads do not reset the budget or mutate captured output', () => {
    vi.useFakeTimers(); vi.setSystemTime(100000);
    const aggregator = new PriceAggregator({ deviationThreshold: 100, recoveryRequiredSuccesses: 1 }, policy);
    aggregator.updateSourcePrice({ asset: 'BTC', source: 'chainlink', price: 100n, decimals: 0, timestamp: 100, observedAt: 100 });
    aggregator.getLatestForAsset('BTC');
    vi.setSystemTime(101000);
    aggregator.updateSourcePrice({ asset: 'BTC', source: 'chainlink', price: 110n, decimals: 0, timestamp: 101, observedAt: 101 });
    const result = aggregator.getLatestForAsset('BTC')!;
    result.price = 'mutated';
    expect(aggregator.getEvidence('BTC')!.result!.price).toBe('110');
    aggregator.getLatestForAsset('BTC');
    const budget = aggregator.getEvidence('BTC')!.policy.budgetMs;
    expect(budget).toBe(15000);
    aggregator.getLatestForAsset('BTC');
    expect(aggregator.getEvidence('BTC')!.policy.budgetMs).toBe(budget);
  });
  it('records legacy stale fallback and never fabricates a bundle for unknown assets', () => {
    vi.useFakeTimers(); vi.setSystemTime(100000000);
    const aggregator = new PriceAggregator();
    expect(aggregator.getEvidence('unknown')).toBeNull();
    aggregator.updateSourcePrice({ asset: 'BTC', source: 'chainlink', price: 100n, decimals: 0, timestamp: 1 });
    expect(aggregator.getLatestForAsset('BTC')!.stale).toBe(true);
    expect(aggregator.getEvidence('BTC')).toMatchObject({ fallback: 'stale', policy: { mode: 'legacy' } });
  });
});
