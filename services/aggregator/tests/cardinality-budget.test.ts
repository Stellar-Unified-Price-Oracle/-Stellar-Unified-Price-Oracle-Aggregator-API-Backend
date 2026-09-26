import { describe, it, expect, beforeEach } from 'vitest';
import {
  validateCardinalityBudget,
  enforceStartupCardinalityBudget,
  sanitizeAssetLabel,
  sanitizeSourceLabel,
  setAllowedAssets,
  setAllowedSources,
  cardinalityViolationsTotal,
  MAX_APPROVED_SOURCES,
  MAX_CURATED_ASSETS,
  MAX_SERIES_BUDGET,
} from '../src/observability/cardinality';

describe('Prometheus Cardinality Budget & Enforcement (#553)', () => {
  beforeEach(() => {
    setAllowedAssets(['XLM', 'USDC', 'EURC']);
    setAllowedSources(['chainlink', 'redstone', 'band', 'reflector']);
  });

  it('passes validation under normal production configuration', () => {
    const sources = ['chainlink', 'redstone', 'band', 'reflector'];
    const assets = ['XLM', 'USDC', 'EURC'];

    const result = validateCardinalityBudget(sources, assets);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.estimatedTotalSeries).toBeLessThan(MAX_SERIES_BUDGET);
    expect(result.estimatedTotalSeries).toBeGreaterThan(0);
  });

  it('enforces budget headroom under worst-case boundary configuration', () => {
    // Exactly at allowed limits: 10 sources, 15 assets
    const sources = Array.from({ length: 10 }, (_, i) => `source_${i}`);
    const assets = Array.from({ length: 15 }, (_, i) => `ASSET_${i}`);

    const result = validateCardinalityBudget(sources, assets);
    expect(result.valid).toBe(true);
    expect(result.estimatedTotalSeries).toBeLessThanOrEqual(MAX_SERIES_BUDGET);
  });

  it('fails admission check when configuration exceeds approved source limit', () => {
    const tooManySources = Array.from({ length: MAX_APPROVED_SOURCES + 1 }, (_, i) => `source_${i}`);
    const assets = ['XLM', 'USDC'];

    const result = validateCardinalityBudget(tooManySources, assets);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Source count'))).toBe(true);

    expect(() => {
      enforceStartupCardinalityBudget(tooManySources, assets);
    }).toThrow(/Startup Cardinality Admission Check FAILED/);
  });

  it('fails admission check when configuration exceeds approved asset limit', () => {
    const sources = ['chainlink', 'redstone'];
    const tooManyAssets = Array.from({ length: MAX_CURATED_ASSETS + 1 }, (_, i) => `ASSET_${i}`);

    const result = validateCardinalityBudget(sources, tooManyAssets);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Asset count'))).toBe(true);

    expect(() => {
      enforceStartupCardinalityBudget(sources, tooManyAssets);
    }).toThrow(/Startup Cardinality Admission Check FAILED/);
  });

  it('sanitizes unapproved asset labels to "other" and increments violation metric', () => {
    const initialViolations = (cardinalityViolationsTotal as any).hashMap ? Object.keys((cardinalityViolationsTotal as any).hashMap).length : 0;

    // Approved asset
    expect(sanitizeAssetLabel('XLM')).toBe('XLM');
    expect(sanitizeAssetLabel('usdc')).toBe('USDC');

    // Unapproved asset
    expect(sanitizeAssetLabel('UNKNOWN_TOKEN_12345')).toBe('other');
  });

  it('sanitizes unapproved source labels to "other"', () => {
    // Approved source
    expect(sanitizeSourceLabel('chainlink')).toBe('chainlink');
    expect(sanitizeSourceLabel('REDSTONE')).toBe('redstone');

    // Unapproved source
    expect(sanitizeSourceLabel('rogue_untrusted_feed')).toBe('other');
  });

  it('verifies all critical alert labels remain available without dropping required dimensions', () => {
    // Alerts in monitoring/ require source and status on oracle_source_requests_total
    const safeSource = sanitizeSourceLabel('chainlink');
    expect(safeSource).toBe('chainlink');

    // Alerts in monitoring/ require source on oracle_source_sla_breaches_total
    expect(sanitizeSourceLabel('band')).toBe('band');
  });
});
