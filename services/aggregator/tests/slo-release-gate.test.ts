import { describe, it, expect } from 'vitest';
import { evaluateSloGate, SloEvaluationInput } from '../../../scripts/slo-release-gate';

describe('SLO Error-Budget Release Gate (#552)', () => {
  const healthyMetrics: SloEvaluationInput = {
    canonical1hBurnRate: 0.5,
    canonical6hBurnRate: 0.8,
    canonical24hBurnRate: 1.1,
    remainingBudgetPercent: 88.5,
    metricsAvailable: true,
  };

  it('permits release when SLO error budget and burn rates are healthy', () => {
    const result = evaluateSloGate(healthyMetrics, { environment: 'production' });
    expect(result.decision).toBe('PERMIT');
    expect(result.exitCode).toBe(0);
    expect(result.reasons[0]).toContain('Error budget healthy');
  });

  it('blocks release when fast-burn 1h threshold (>= 14.4x) is breached', () => {
    const criticalMetrics: SloEvaluationInput = {
      ...healthyMetrics,
      canonical1hBurnRate: 16.2,
    };
    const result = evaluateSloGate(criticalMetrics, { environment: 'production' });
    expect(result.decision).toBe('BLOCK');
    expect(result.exitCode).toBe(1);
    expect(result.reasons.some((r) => r.includes('Fast burn rate critical: 1h burn rate'))).toBe(true);
  });

  it('blocks release when fast-burn 6h threshold (>= 6.0x) is breached', () => {
    const highBurnMetrics: SloEvaluationInput = {
      ...healthyMetrics,
      canonical6hBurnRate: 7.5,
    };
    const result = evaluateSloGate(highBurnMetrics, { environment: 'production' });
    expect(result.decision).toBe('BLOCK');
    expect(result.exitCode).toBe(1);
    expect(result.reasons.some((r) => r.includes('Fast burn rate high: 6h burn rate'))).toBe(true);
  });

  it('blocks release when monthly error budget is completely exhausted', () => {
    const exhaustedMetrics: SloEvaluationInput = {
      ...healthyMetrics,
      remainingBudgetPercent: -2.4,
    };
    const result = evaluateSloGate(exhaustedMetrics, { environment: 'production' });
    expect(result.decision).toBe('BLOCK');
    expect(result.exitCode).toBe(1);
    expect(result.reasons.some((r) => r.includes('Monthly error budget completely exhausted'))).toBe(true);
  });

  it('restricts release to DEGRADED_PERMIT when slow-burn 24h threshold (>= 3.0x) is breached', () => {
    const slowBurnMetrics: SloEvaluationInput = {
      ...healthyMetrics,
      canonical24hBurnRate: 3.8,
    };
    const result = evaluateSloGate(slowBurnMetrics, { environment: 'production' });
    expect(result.decision).toBe('DEGRADED_PERMIT');
    expect(result.exitCode).toBe(0);
    expect(result.reasons.some((r) => r.includes('reduced-traffic canary'))).toBe(true);
  });

  it('isolates canary burn rate so canary-specific errors do not block the canonical release gate', () => {
    const canarySpikeMetrics: SloEvaluationInput = {
      ...healthyMetrics,
      canaryBurnRate: 25.0, // High canary burn
    };
    const result = evaluateSloGate(canarySpikeMetrics, { environment: 'production' });
    // Should still permit canonical release because canonical burn rates are healthy
    expect(result.decision).toBe('PERMIT');
    expect(result.reasons.some((r) => r.includes('Canary-isolated burn rate observed'))).toBe(true);
  });

  it('allows emergency hotfix override with audit record and visible warning', () => {
    const criticalMetrics: SloEvaluationInput = {
      ...healthyMetrics,
      canonical1hBurnRate: 20.0,
      remainingBudgetPercent: 0,
    };
    const result = evaluateSloGate(criticalMetrics, {
      environment: 'production',
      overrideReason: 'HOTFIX: INC-999 fix memory leak causing 500s',
      overrideApprover: 'principal-sre@stellar.org',
    });

    expect(result.decision).toBe('OVERRIDDEN_PERMIT');
    expect(result.exitCode).toBe(0);
    expect(result.overrideApplied).toBe(true);
    expect(result.overrideApprover).toBe('principal-sre@stellar.org');
    expect(result.reasons.some((r) => r.includes('EMERGENCY OVERRIDE APPLIED'))).toBe(true);
  });

  it('fails closed in production when metrics are unavailable', () => {
    const metricsDown: SloEvaluationInput = {
      ...healthyMetrics,
      metricsAvailable: false,
    };
    const result = evaluateSloGate(metricsDown, { environment: 'production' });
    expect(result.decision).toBe('BLOCK');
    expect(result.exitCode).toBe(1);
    expect(result.reasons.some((r) => r.includes('FAIL_CLOSED'))).toBe(true);
  });

  it('warns and permits in staging when metrics are unavailable to avoid blocking dev testing', () => {
    const metricsDown: SloEvaluationInput = {
      ...healthyMetrics,
      metricsAvailable: false,
    };
    const result = evaluateSloGate(metricsDown, { environment: 'staging' });
    expect(result.decision).toBe('PERMIT');
    expect(result.exitCode).toBe(0);
    expect(result.reasons.some((r) => r.includes('WARN_AND_PERMIT'))).toBe(true);
  });
});
