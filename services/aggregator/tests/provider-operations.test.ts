import { describe, expect, it } from 'vitest';
import { assessProviderConcentration, parseShadowSources, recordShadowObservation } from '../src/oracle-sources/provider-operations';
import type { NormalizedPrice } from '../src/infrastructure/types';

function price(source: string, value: string, decimals: number): NormalizedPrice {
  return {
    asset: 'XLM',
    price: BigInt(value),
    decimals,
    source: source as NormalizedPrice['source'],
    timestamp: 1_700_000_000,
    observedAt: 1_700_000_000,
    fetchedAt: 1_700_000_000,
  };
}

describe('provider operations', () => {
  it('flags a single provider and accepts a diverse feed at policy boundaries', () => {
    expect(assessProviderConcentration('xlm', ['chainlink']).reasons).toContain('insufficient_dependency_groups');
    const diverse = assessProviderConcentration('xlm', ['chainlink', 'redstone']);
    expect(diverse.healthy).toBe(true);
    expect(diverse.hhi).toBe(0.5);
    expect(assessProviderConcentration('xlm', ['chainlink', 'redstone'], {
      minimumDependencyGroups: 2,
      maximumDependencyShare: 0.49,
      maximumHhi: 0.6,
    }).reasons).toContain('dependency_share_over_policy');
  });

  it('parses shadow source names without accepting empty values', () => {
    expect([...parseShadowSources(' Chainlink, redstone ,,')]).toEqual(['chainlink', 'redstone']);
    expect([...parseShadowSources(undefined)]).toEqual([]);
  });

  it('compares shadow and active observations after decimal normalization', () => {
    const result = recordShadowObservation(price('reflector', '10100', 2), [
      price('chainlink', '100', 0),
      price('redstone', '10000', 2),
    ]);
    expect(result.compared).toBe(true);
    expect(result.deviationPercent).toBe(1);
  });

  it('reports missing active references and invalid numeric values as non-comparisons', () => {
    expect(recordShadowObservation(price('reflector', '100', 2), [])).toEqual({ compared: false });
    expect(recordShadowObservation(price('reflector', '100', 2), [price('chainlink', '0', 0)])).toEqual({ compared: false });
  });
});
