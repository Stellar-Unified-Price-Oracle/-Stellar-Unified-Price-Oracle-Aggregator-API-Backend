import { describe, it, expect } from 'vitest';
import { buildPriceProvenance } from '../src/price-serving/consumer/price-provenance';
import type { PriceProvenance } from '@stellar-oracle/types';

const basePrice = {
  asset: 'XLM',
  price: '0.1200000',
  decimals: 7,
  sources: ['chainlink', 'redstone', 'band'] as const,
  timestamp: Math.floor(Date.now() / 1000) - 30,
  observedAt: Math.floor(Date.now() / 1000) - 35,
  fetchedAt: Math.floor(Date.now() / 1000),
};

describe('price provenance (#718)', () => {
  it('builds a complete provenance response linking price to lineage', () => {
    const prov = buildPriceProvenance(basePrice, '/api/v1');

    expect(prov.asset).toBe('XLM');
    expect(prov.price).toBe('0.1200000');
    expect(prov.decimals).toBe(7);
    expect(prov.timestamp).toBe(basePrice.timestamp);
    expect(prov.observedAt).toBe(basePrice.observedAt);
    expect(prov.catalogVersion).toBeDefined();
    expect(typeof prov.catalogVersion).toBe('string');
    expect(prov.aggregationPolicy.strategy).toBe('median');
    expect(prov.aggregationPolicy.sourceCount).toBe(3);
    expect(prov.aggregationPolicy.minSources).toBe(1);
    expect(prov.sourceSet).toEqual(['chainlink', 'redstone', 'band']);
    expect(prov.observationTimeSemantics.ageVerified).toBe(true);
    expect(prov.observationTimeSemantics.observedAt).toBe(basePrice.observedAt);
    expect(prov.observationTimeSemantics.fetchedAt).toBe(basePrice.fetchedAt);
    expect(prov.provenanceId).toBeDefined();
    expect(typeof prov.provenanceId).toBe('string');
    expect(prov.verificationUrl).toBe('/api/v1/lineage/verify/' + prov.provenanceId);
  });

  it('sets ageVerified false when observedAt is missing', () => {
    const prov = buildPriceProvenance({ ...basePrice, observedAt: undefined }, '/api/v2');
    expect(prov.observationTimeSemantics.ageVerified).toBe(false);
    expect(prov.observationTimeSemantics.observedAt).toBeNull();
  });

  it('uses a single source when sources array is absent', () => {
    const prov = buildPriceProvenance(
      { ...basePrice, source: 'chainlink', sources: undefined },
      '/api/v1',
    );
    expect(prov.sourceSet).toEqual(['chainlink']);
    expect(prov.aggregationPolicy.sourceCount).toBe(1);
  });

  it('is a valid PriceProvenance type', () => {
    const prov: PriceProvenance = buildPriceProvenance(basePrice, '/api/v1');
    expect(prov.asset).toBe('XLM');
  });
});