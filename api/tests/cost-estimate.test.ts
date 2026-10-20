import { describe, it, expect } from 'vitest';

import {
  estimateRequestCost,
  COST_MODEL_VERSION,
  BATCH_MAX_ASSETS,
  HISTORY_LIMIT_DEFAULT,
  HISTORY_LIMIT_MAX,
  ESTIMATE_OPERATIONS,
} from '../src/price-serving/cost-estimate';
import { TIER_RATE_LIMITS, TIER_RATE_LIMIT_CEILINGS } from '../src/platform/limit-model';
import { PAGINATION_DEFAULTS } from '../src/price-serving/pagination';

// ── Pure model: determinism ──────────────────────────────────────────────────

describe('estimateRequestCost determinism (issue #720)', () => {
  it('produces a byte-identical estimate for identical inputs', () => {
    const params = { operation: 'batch_prices', assetCount: 25 };
    expect(estimateRequestCost(params)).toEqual(estimateRequestCost({ ...params }));
    expect(estimateRequestCost({ ...params }));
    expect(JSON.stringify(estimateRequestCost(params))).toBe(JSON.stringify(estimateRequestCost(params)));
  });

  it('carries the rule-table version and the fixed bounds snapshot', () => {
    const estimate = estimateRequestCost({ operation: 'single_price' });
    expect(estimate.costModelVersion).toBe(COST_MODEL_VERSION);
    expect(estimate.bounds).toEqual({
      batchAssetsMax: BATCH_MAX_ASSETS,
      historyLimitDefault: HISTORY_LIMIT_DEFAULT,
      historyLimitMax: HISTORY_LIMIT_MAX,
    });
  });
});

// ── Pure model: quota and billing rule alignment ────────────────────────────

describe('estimateRequestCost rule alignment with enforced quota and billing', () => {
  it('charges one request unit per request — success or failure', () => {
    for (const op of ESTIMATE_OPERATIONS) {
      const accepted = estimateRequestCost({ operation: op, ...opDefaults(op) });
      expect(accepted.quota.units).toBe(1);
      expect(accepted.billing.meteredUnits).toBe(1);
      expect(accepted.billing.meteredOnFailure).toBe(true);
    }

    // Rejected shapes are metered through the same one-slot path.
    const rejected = estimateRequestCost({ operation: 'batch_prices', assetCount: 999 });
    expect(rejected.accepted).toBe(false);
    expect(rejected.quota.units).toBe(1);
    expect(rejected.billing.meteredOnFailure).toBe(true);
  });

  it('publishes tier allowances that match the enforced limit model', () => {
    const estimate = estimateRequestCost({ operation: 'single_price' });
    for (const tier of Object.keys(TIER_RATE_LIMITS) as Array<keyof typeof TIER_RATE_LIMITS>) {
      expect(estimate.quota.tierAllowancePerMinute[tier]).toBe(TIER_RATE_LIMITS[tier]);
      expect(estimate.quota.tierOverrideCeilingPerMinute[tier]).toBe(TIER_RATE_LIMIT_CEILINGS[tier]);
      expect(estimate.quota.fitsPerMinuteAtTierDefaults[tier]).toBe(TIER_RATE_LIMITS[tier]);
    }
  });

  it('bills in the requests-per-key dimension used by the fee schedule', () => {
    const estimate = estimateRequestCost({ operation: 'single_price' });
    expect(estimate.billing.dimension).toBe('requests-per-key');
    expect(estimate.quota.dimension).toBe('requests');
  });
});

function opDefaults(op: string): { assetCount?: number; historyLimit?: number } {
  if (op === 'batch_prices') return { assetCount: 1 };
  if (op === 'price_history') return { historyLimit: 10 };
  return {};
}

// ── Pure model: normal / boundary / failure cases ───────────────────────────

describe('estimateRequestCost cases', () => {
  it('accepts a normal single price estimate', () => {
    const estimate = estimateRequestCost({ operation: 'single_price' });
    expect(estimate.accepted).toBe(true);
    expect(estimate.rejection).toBeUndefined();
    expect(estimate.data).toEqual({ assets: 1 });
  });

  it('accepts a normal batch estimate and reports planned assets', () => {
    const estimate = estimateRequestCost({ operation: 'batch_prices', assetCount: 3 });
    expect(estimate.accepted).toBe(true);
    expect(estimate.data).toEqual({ assets: 3 });
  });

  it('accepts batch at both bounds (1 and 50 assets)', () => {
    expect(estimateRequestCost({ operation: 'batch_prices', assetCount: 1 }).accepted).toBe(true);
    expect(estimateRequestCost({ operation: 'batch_prices', assetCount: BATCH_MAX_ASSETS }).accepted).toBe(true);
  });

  it('rejects batch beyond the boundary with the executed-request consequence', () => {
    const estimate = estimateRequestCost({ operation: 'batch_prices', assetCount: BATCH_MAX_ASSETS + 1 });
    expect(estimate.accepted).toBe(false);
    expect(estimate.rejection?.code).toBe('INVALID_PARAMS');
    expect(estimate.rejection?.message).toContain('400 VALIDATION_ERROR');
  });

  it('rejects non-integer and zero asset counts', () => {
    for (const assetCount of [0, -1, 1.5, Number.NaN]) {
      const estimate = estimateRequestCost({ operation: 'batch_prices', assetCount });
      expect(estimate.accepted).toBe(false);
      expect(estimate.rejection?.code).toBe('INVALID_PARAMS');
    }
  });

  it('defaults history to the schema default and accepts the max bound', () => {
    const defaulted = estimateRequestCost({ operation: 'price_history' });
    expect(defaulted.accepted).toBe(true);
    expect(defaulted.data).toEqual({ historyPoints: HISTORY_LIMIT_DEFAULT });

    expect(estimateRequestCost({ operation: 'price_history', historyLimit: HISTORY_LIMIT_MAX }).accepted).toBe(true);
    expect(estimateRequestCost({ operation: 'price_history', historyLimit: 1 }).accepted).toBe(true);
  });

  it('rejects history beyond the limit bound and non-integers', () => {
    expect(estimateRequestCost({ operation: 'price_history', historyLimit: HISTORY_LIMIT_MAX + 1 }).accepted).toBe(false);
    expect(estimateRequestCost({ operation: 'price_history', historyLimit: 2.5 }).accepted).toBe(false);
  });

  it('rejects parameters that do not belong to the operation', () => {
    expect(estimateRequestCost({ operation: 'single_price', assetCount: 2 }).rejection?.code).toBe('INVALID_PARAMS');
    expect(estimateRequestCost({ operation: 'batch_prices', historyLimit: 5 }).rejection?.code).toBe('INVALID_PARAMS');
    expect(estimateRequestCost({ operation: 'price_history', assetCount: 2 }).rejection?.code).toBe('INVALID_PARAMS');
  });

  it('rejects unknown operations', () => {
    const estimate = estimateRequestCost({ operation: 'submit_contract_txn' });
    expect(estimate.accepted).toBe(false);
    expect(estimate.operation).toBeNull();
    expect(estimate.rejection?.code).toBe('INVALID_OPERATION');
  });

  it('stays aligned with the pagination contract for history pages', () => {
    expect(HISTORY_LIMIT_DEFAULT).toBe(PAGINATION_DEFAULTS.PAGE_SIZE);
  });
});

