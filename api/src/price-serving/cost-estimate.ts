/**
 * Deterministic request-cost estimates for bounded API operations (issue #720).
 *
 * A consumer plans a request (for example a batch decision over 40 assets)
 * and can ask the API what it will cost before executing it. Two properties
 * matter and are tested:
 *
 * 1. Determinism — the estimate is a pure function of the request parameters
 *    and the static rule table below. It never reads wall-clock time, the
 *    cache, the store or per-key state, so identical inputs always produce a
 *    byte-identical estimate.
 *
 * 2. Rule alignment — the estimate is expressed in exactly the dimensions
 *    that are enforced and billed:
 *      - Quota: one request consumes exactly one slot from the per-key fixed
 *        window (`platform/tenant-window.ts`). There is no per-asset or
 *        per-point quota dimension, so the estimate reports the same.
 *      - Billing: usage meters successful and failed requests per API key
 *        (`governance/usage-tracking.ts`, `docs/fee-schedule.md` § 3), so the
 *        metered dimension is "requests per key" and validation failures are
 *        metered too.
 *
 * Tier allowances come straight from `platform/limit-model.ts` so the table
 * published here cannot drift from the enforced one.
 */

import { RateTier, TIER_RATE_LIMITS, TIER_RATE_LIMIT_CEILINGS } from '../platform/limit-model';
import { PAGINATION_DEFAULTS } from './pagination';

/** Version of the estimate rule table. Bump on rule changes and document in docs/cost-estimates.md. */
export const COST_MODEL_VERSION = '1.0.0';

export const ESTIMATE_OPERATIONS = ['single_price', 'batch_prices', 'price_history'] as const;

export type EstimateOperation = (typeof ESTIMATE_OPERATIONS)[number];

/** Largest asset list a single batch request may carry — shares the constant the /prices/batch schemas enforce. */
export const BATCH_MAX_ASSETS = 50;

/** History pagination bounds: the default mirrors the shared pagination contract. */
export const HISTORY_LIMIT_DEFAULT = PAGINATION_DEFAULTS.PAGE_SIZE;
export const HISTORY_LIMIT_MAX = 1000;

export interface EstimateParams {
  operation: string;
  /** Proposed number of assets for a batch request (1..BATCH_MAX_ASSETS passes). */
  assetCount?: number;
  /** Proposed `limit` for a history request (1..HISTORY_LIMIT_MAX passes). */
  historyLimit?: number;
}

export interface CostEstimate {
  costModelVersion: string;
  operation: EstimateOperation | null;
  /** true when the query as parameterized would pass request validation. */
  accepted: boolean;
  rejection?: { code: string; message: string };
  /** Enforced quota dimension — one slot per request, per platform/tenant-window.ts. */
  quota: {
    dimension: 'requests';
    units: 1;
    enforcedBy: string;
    /** Enforced per-minute allowance per tier (platform/limit-model.ts). */
    tierAllowancePerMinute: Record<RateTier, number>;
    /** Highest value an operator override may reach for the tier. */
    tierOverrideCeilingPerMinute: Record<RateTier, number>;
    /** How many times this request shape fits in one minute at tier defaults. */
    fitsPerMinuteAtTierDefaults: Record<RateTier, number>;
  };
  /** Metered billing dimension — docs/fee-schedule.md § 3 (usage counters per key). */
  billing: {
    dimension: 'requests-per-key';
    meteredUnits: 1;
    meteredOnFailure: true;
    source: string;
  };
  /** Planned response size consequences of the proposed parameters. */
  data: {
    assets?: number;
    historyPoints?: number;
  };
  /** Static validation bounds the proposed request must respect. */
  bounds: {
    batchAssetsMax: number;
    historyLimitDefault: number;
    historyLimitMax: number;
  };
}

const tierAllowanceSnapshot = (): Record<RateTier, number> => ({ ...TIER_RATE_LIMITS });

/**
 * One slot is consumed per request regardless of operation size or outcome.
 * `fitsPerMinuteAtTierDefaults` derives from the enforced limit, not from this
 * module's own table, so a drift between the two is a test failure, not a
 * silent contract change.
 */
function quotaSnapshot(): CostEstimate['quota'] {
  const allowance = tierAllowanceSnapshot();
  const ceilings = {} as Record<RateTier, number>;
  const fits = {} as Record<RateTier, number>;
  for (const tier of Object.keys(allowance) as RateTier[]) {
    ceilings[tier] = TIER_RATE_LIMIT_CEILINGS[tier];
    fits[tier] = allowance[tier];
  }
  return {
    dimension: 'requests',
    units: 1,
    enforcedBy: 'governance auth middleware via platform/tenant-window.ts (one fixed-window slot per request)',
    tierAllowancePerMinute: allowance,
    tierOverrideCeilingPerMinute: ceilings,
    fitsPerMinuteAtTierDefaults: fits,
  };
}

function billingSnapshot(): CostEstimate['billing'] {
  return {
    dimension: 'requests-per-key',
    meteredUnits: 1,
    meteredOnFailure: true,
    source: 'docs/fee-schedule.md § 3 — usage counters per API key, reconciled monthly',
  };
}

function boundsSnapshot(): CostEstimate['bounds'] {
  return {
    batchAssetsMax: BATCH_MAX_ASSETS,
    historyLimitDefault: HISTORY_LIMIT_DEFAULT,
    historyLimitMax: HISTORY_LIMIT_MAX,
  };
}

/**
 * The deterministic core: identical inputs produce identical output, forever.
 */
export function estimateRequestCost(params: EstimateParams): CostEstimate {
  const base: CostEstimate = {
    costModelVersion: COST_MODEL_VERSION,
    operation: null,
    accepted: false,
    quota: quotaSnapshot(),
    billing: billingSnapshot(),
    data: {},
    bounds: boundsSnapshot(),
  };

  if (!ESTIMATE_OPERATIONS.includes(params.operation as EstimateOperation)) {
    return {
      ...base,
      rejection: {
        code: 'INVALID_OPERATION',
        message: `operation must be one of: ${ESTIMATE_OPERATIONS.join(', ')}`,
      },
    };
  }

  const operation = params.operation as EstimateOperation;

  if (operation === 'single_price') {
    if (params.assetCount !== undefined || params.historyLimit !== undefined) {
      return {
        ...base,
        operation,
        rejection: {
          code: 'INVALID_PARAMS',
          message: 'single_price takes no assetCount or historyLimit parameters',
        },
      };
    }
    return { ...base, accepted: true, operation, data: { assets: 1 } };
  }

  if (operation === 'batch_prices') {
    if (params.historyLimit !== undefined) {
      return {
        ...base,
        operation,
        rejection: {
          code: 'INVALID_PARAMS',
          message: 'batch_prices does not take a historyLimit parameter',
        },
      };
    }
    const assetCount = params.assetCount;
    if (assetCount === undefined) {
      return {
        ...base,
        operation,
        rejection: {
          code: 'INVALID_PARAMS',
          message: `batch_prices requires assetCount between 1 and ${BATCH_MAX_ASSETS}`,
        },
      };
    }
    if (!Number.isInteger(assetCount) || assetCount < 1 || assetCount > BATCH_MAX_ASSETS) {
      return {
        ...base,
        operation,
        rejection: {
          code: 'INVALID_PARAMS',
          message: `assetCount must be an integer between 1 and ${BATCH_MAX_ASSETS}; the executed request would be rejected with 400 VALIDATION_ERROR`,
        },
      };
    }
    return { ...base, accepted: true, operation, data: { assets: assetCount } };
  }

  if (params.assetCount !== undefined) {
    return {
      ...base,
      operation,
      rejection: {
        code: 'INVALID_PARAMS',
        message: 'price_history does not take an assetCount parameter',
      },
    };
  }

  const historyLimit = params.historyLimit ?? HISTORY_LIMIT_DEFAULT;
  if (!Number.isInteger(historyLimit) || historyLimit < 1 || historyLimit > HISTORY_LIMIT_MAX) {
    return {
      ...base,
      operation,
      rejection: {
        code: 'INVALID_PARAMS',
        message: `historyLimit must be an integer between 1 and ${HISTORY_LIMIT_MAX}; the executed request would be rejected with 400 VALIDATION_ERROR`,
      },
    };
  }

  return {
    ...base,
    accepted: true,
    operation,
    data: { historyPoints: Math.min(historyLimit, HISTORY_LIMIT_MAX) },
  };
}
