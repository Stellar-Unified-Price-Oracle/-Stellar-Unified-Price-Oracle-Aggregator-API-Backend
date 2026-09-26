import { describe, it, expect } from 'vitest';
import {
  enforceLatencyBudget,
  formatLatencySummaryMarkdown,
  API_HOP_BUDGETS,
} from '../../scripts/enforce-latency-budget';
import {
  validateTraceCoverage,
  assertTraceCoverage,
  MissingTraceSpanError,
  REQUIRED_API_HOPS,
} from '../src/observability/trace-propagation';

describe('End-to-End Latency Budget & Per-Hop Attribution (#554)', () => {
  const healthyHopMeasurements: Record<string, number> = {
    hop_ingress_tls: 5.0,        // budget: 10ms
    hop_middleware_auth: 8.0,    // budget: 15ms
    hop_cache_lookup: 16.0,      // budget: 25ms
    hop_data_store: 45.0,        // budget: 80ms
    hop_serialization: 10.0,     // budget: 20ms
    hop_egress_network: 15.0,    // budget: 30ms
  };

  it('passes per-hop latency budget under normal healthy conditions', () => {
    const result = enforceLatencyBudget(healthyHopMeasurements, 25);
    expect(result.passed).toBe(true);
    expect(result.failures).toHaveLength(0);
    expect(result.totalEndToEndP95Ms).toBe(99.0);
    expect(result.totalEndToEndP95Ms).toBeLessThan(result.slaLimitP95Ms);

    const summary = formatLatencySummaryMarkdown(result);
    expect(summary).toContain('✅ Per-Hop Latency Budget Enforcement Result');
  });

  it('detects a budget breach in a specific hop and reports its magnitude', () => {
    const regressedHopMeasurements: Record<string, number> = {
      ...healthyHopMeasurements,
      hop_cache_lookup: 38.0, // budget: 25ms, +25% tolerance max is 31.25ms
    };

    const result = enforceLatencyBudget(regressedHopMeasurements, 25);
    expect(result.passed).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("Hop 'hop_cache_lookup' (Cache Lookup (L1/L2)) exceeded budget");
    expect(result.failures[0]).toContain('+52.0% above budget');

    const failingHop = result.hops.find((h) => h.hopId === 'hop_cache_lookup');
    expect(failingHop?.status).toBe('FAIL');
  });

  it('detects end-to-end SLA breaches (> 1000ms)', () => {
    const massiveBreachMeasurements: Record<string, number> = {
      ...healthyHopMeasurements,
      hop_data_store: 1200.0,
    };

    const result = enforceLatencyBudget(massiveBreachMeasurements, 25, 1000);
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.includes('breached external SLA limit'))).toBe(true);
  });

  it('detects missing trace spans across the pipeline to prevent unmeasured hops', () => {
    // Missing cache.lookup and store.read
    const incompleteSpans = ['http.middleware', 'http.serialization'];
    const result = validateTraceCoverage(incompleteSpans, REQUIRED_API_HOPS);

    expect(result.complete).toBe(false);
    expect(result.missingHops).toEqual(['cache.lookup', 'store.read']);

    expect(() => {
      assertTraceCoverage(incompleteSpans, REQUIRED_API_HOPS);
    }).toThrow(MissingTraceSpanError);
  });

  it('verifies complete trace coverage passes without errors', () => {
    const completeSpans = [
      'http.middleware',
      'cache.lookup',
      'store.read',
      'http.serialization',
    ];
    const result = validateTraceCoverage(completeSpans, REQUIRED_API_HOPS);
    expect(result.complete).toBe(true);
    expect(result.missingHops).toHaveLength(0);

    expect(() => {
      assertTraceCoverage(completeSpans, REQUIRED_API_HOPS);
    }).not.toThrow();
  });
});
