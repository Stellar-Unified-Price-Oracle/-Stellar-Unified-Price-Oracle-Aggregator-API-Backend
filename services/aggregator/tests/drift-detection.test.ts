import { describe, expect, it } from 'vitest';
import type { NormalizedPrice } from '../src/infrastructure/types';
import {
  buildBaseline,
  compareAgainstBaseline,
  driftBaselineStore,
} from '../src/price-aggregation/drift-baseline';
import { driftDetector } from '../src/price-aggregation/drift-detector';

const T0 = 1_700_000_000;

function prices(overrides: Partial<NormalizedPrice> & { price: bigint } = { price: 100n }): NormalizedPrice[] {
  const out: NormalizedPrice[] = [];
  for (let i = 0; i < 10; i++) {
    out.push({
      asset: 'XLM',
      price: overrides.price,
      decimals: 8,
      source: 'chainlink',
      timestamp: T0 + i * 30,
      observedAt: T0 + i * 30 - 5,
      fetchedAt: T0 + i * 30,
      ...overrides,
    } as NormalizedPrice);
  }
  return out;
}

describe('provider semantic drift detection (#707)', () => {
  it('builds a baseline capturing meaning, coverage and lag', () => {
    const baseline = buildBaseline('v1', 'XLM', 'chainlink', prices(), 8);
    expect(baseline.version).toBe('v1');
    expect(baseline.sampleCount).toBe(10);
    expect(baseline.meanPrice).toBe(100);
    expect(baseline.stdDevPrice).toBe(0);
    expect(baseline.observedAtCoverage).toBe(1);
    expect(baseline.medianReportingLagSeconds).toBe(5);
    expect(baseline.medianObservedAt).toBeGreaterThan(0);
    expect(baseline.windowStart).toBeLessThanOrEqual(T0);
  });

  it('reports no drift when the distribution is unchanged', () => {
    const baseline = buildBaseline('v1', 'XLM', 'chainlink', prices(), 8);
    const comparison = compareAgainstBaseline('XLM', 'chainlink', prices(), baseline);
    expect(comparison.driftDetected).toBe(false);
    expect(comparison.driftReasons).toEqual([]);
    expect(comparison.meanPriceChangePercent).toBeCloseTo(0);
  });

  it('flags a silent semantic value shift beyond the mean threshold', () => {
    const baseline = buildBaseline('v1', 'XLM', 'chainlink', prices({ price: 100n }), 8);
    const comparison = compareAgainstBaseline('XLM', 'chainlink', prices({ price: 120n }), baseline);
    expect(comparison.driftDetected).toBe(true);
    expect(comparison.meanPriceChangePercent).toBeCloseTo(20);
    expect(comparison.driftReasons.join(' ')).toMatch(/mean price/);
  });

  it('flags a provider that quietly stops reporting observation times', () => {
    const baseline = buildBaseline('v1', 'XLM', 'chainlink', prices(), 8);
    const dropped = prices().map((p) => ({ ...p, observedAt: null }));
    const comparison = compareAgainstBaseline('XLM', 'chainlink', dropped, baseline);
    expect(comparison.currentObservedAtCoverage).toBe(0);
    expect(comparison.driftDetected).toBe(true);
    expect(comparison.driftReasons.join(' ')).toMatch(/observedAt coverage/);
  });

  it('flags a provider reporting lag regression', () => {
    const baseline = buildBaseline('v1', 'XLM', 'chainlink', prices(), 8);
    const laggy = prices().map((p) => ({ ...p, timestamp: (p.observedAt ?? T0) + 900 }));
    const comparison = compareAgainstBaseline('XLM', 'chainlink', laggy, baseline);
    expect(comparison.reportingLagChangeSeconds).toBeGreaterThan(300);
    expect(comparison.driftDetected).toBe(true);
  });

  it('handles empty windows without throwing', () => {
    const baseline = buildBaseline('v1', 'XLM', 'chainlink', [], 8);
    expect(baseline.sampleCount).toBe(0);
    const comparison = compareAgainstBaseline('XLM', 'chainlink', [], baseline);
    expect(comparison.currentMeanPrice).toBe(0);
    expect(comparison.driftReasons).toEqual([]);
  });

  it('stores and retrieves versioned baselines per feed', () => {
    driftBaselineStore.setBaseline(buildBaseline('v1', 'BTC', 'redstone', prices({ price: 50_000n }), 8));
    driftBaselineStore.setBaseline(buildBaseline('v2', 'BTC', 'redstone', prices({ price: 51_000n }), 8));
    expect(driftBaselineStore.getBaseline('BTC', 'redstone')?.version).toBe('v2');
    expect(driftBaselineStore.getBaselines('BTC', 'redstone')).toHaveLength(2);
  });

  it('detects drift through the detector facade', () => {
    driftBaselineStore.setBaseline(
      buildBaseline(
        'v1',
        'SOL',
        'band',
        prices({ price: 100n }).map((p) => ({ ...p, asset: 'SOL', source: 'band' as const })),
        8,
      ),
    );
    const stable = driftDetector.detectDrift(
      'SOL',
      prices().map((p) => ({ ...p, asset: 'SOL', source: 'band' as const })),
    );
    expect(stable.comparisons.length).toBeGreaterThan(0);
    expect(stable.anyDrift).toBe(false);

    const shifted = driftDetector.detectDrift(
      'SOL',
      prices({ price: 200n }).map((p) => ({ ...p, asset: 'SOL', source: 'band' as const })),
    );
    expect(shifted.anyDrift).toBe(true);
  });
});
