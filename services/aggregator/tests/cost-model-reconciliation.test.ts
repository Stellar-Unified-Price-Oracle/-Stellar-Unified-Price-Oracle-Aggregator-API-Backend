import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import {
  verifyRuntimeCostModelIntegrity,
  COST_PER_1K_CALLS,
  DAILY_BUDGET_CALLS,
} from '../src/infrastructure/cost-model';

describe('Cost Model Reconciliation against Real Cloud Billing (#555)', () => {
  const root = path.resolve(__dirname, '../../../');
  const costModelPath = path.join(root, 'config', 'cost-model.json');
  const costInvoicesPath = path.join(root, 'config', 'cost-invoices.json');

  it('validates cost-model.json schema contains error bands, variance thresholds, and changelog', () => {
    const raw = fs.readFileSync(costModelPath, 'utf8');
    const model = JSON.parse(raw);

    // Verify variance thresholds
    expect(model.varianceThresholds).toBeDefined();
    expect(model.varianceThresholds.totalMonthlyTolerancePct).toBe(15.0);
    expect(model.varianceThresholds.perServiceTolerancePct).toBe(20.0);
    expect(model.varianceThresholds.inferredCategoryTolerancePct).toBe(30.0);
    expect(model.varianceThresholds.runtimeCallCostTolerancePct).toBe(10.0);

    // Verify inferred error bands
    expect(model.inferredCostErrorBands).toBeDefined();
    expect(model.inferredCostErrorBands.networkEgress.errorBandPct).toBe(18.0);
    expect(model.inferredCostErrorBands.sharedControlPlane.errorBandPct).toBe(12.0);

    // Verify changelog
    expect(Array.isArray(model.changelog)).toBe(true);
    expect(model.changelog.length).toBeGreaterThan(0);
    expect(model.changelog[0].author).toBeDefined();
    expect(model.changelog[0].reason).toBeDefined();
  });

  it('validates invoices in cost-invoices.json contain attributable and inferred items', () => {
    const raw = fs.readFileSync(costInvoicesPath, 'utf8');
    const data = JSON.parse(raw);

    expect(Array.isArray(data.invoices)).toBe(true);
    for (const inv of data.invoices) {
      expect(inv.month).toMatch(/^\d{4}-\d{2}$/);
      expect(inv.invoicedTotal).toBeGreaterThan(0);
      expect(inv.attributableCategories).toBeDefined();
      expect(inv.inferredCategories).toBeDefined();
      expect(inv.dataSource).toBeDefined();
    }
  });

  it('verifies runtime cost model integrity matches config/cost-model.json', () => {
    const result = verifyRuntimeCostModelIntegrity(costModelPath);

    expect(result.valid).toBe(true);
    expect(result.driftDetected).toBe(false);
    expect(result.maxDriftPct).toBeLessThanOrEqual(result.tolerancePct);
  });

  it('detects unacknowledged drift when runtime rates deviate from modeled configuration', () => {
    // Construct temporary drifted model config
    const tempConfig = {
      varianceThresholds: { runtimeCallCostTolerancePct: 10.0 },
      runtimeOracleCallModel: {
        ratesPer1kCalls: {
          chainlink: 5.0, // Significant drift from 0.0
        },
        dailyBudgetCalls: {
          chainlink: 10000,
        },
      },
    };

    const tempFile = path.join(__dirname, 'temp-drifted-cost-model.json');
    fs.writeFileSync(tempFile, JSON.stringify(tempConfig), 'utf8');

    try {
      const result = verifyRuntimeCostModelIntegrity(tempFile);
      expect(result.driftDetected).toBe(true);
      expect(result.valid).toBe(false);
      expect(result.discrepancies.some((d) => d.includes('chainlink'))).toBe(true);
    } finally {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    }
  });
});
