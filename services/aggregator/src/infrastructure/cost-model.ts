import fs from 'fs';
import path from 'path';

// Cost estimates in USD per 1000 API calls. Adjust per actual contract terms.
export const COST_PER_1K_CALLS: Record<string, number> = {
  chainlink: 0.0,    // free public feeds
  redstone:  0.0,    // free public feeds
  band:      0.0,    // free public feeds
  reflector: 0.0,    // free public feeds
};

// Daily call budget per source (set to 0 to disable budget tracking).
export const DAILY_BUDGET_CALLS: Record<string, number> = {
  chainlink: 10000,
  redstone:  10000,
  band:      10000,
  reflector: 10000,
};

// Running daily call counts reset at midnight UTC.
const dailyCounts: Record<string, number> = {};
let lastResetDate = new Date().toISOString().slice(0, 10);

function maybeReset(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== lastResetDate) {
    // Drop entries entirely so a fresh day reports an empty map.
    for (const k of Object.keys(dailyCounts)) delete dailyCounts[k];
    lastResetDate = today;
  }
}

export function estimateCostUsd(source: string): number {
  const rate = COST_PER_1K_CALLS[source.toLowerCase()] ?? 0;
  return rate / 1000;
}

export function recordCall(source: string): void {
  maybeReset();
  const key = source.toLowerCase();
  dailyCounts[key] = (dailyCounts[key] ?? 0) + 1;
}

export function getBudgetUtilization(source: string): number {
  maybeReset();
  const key = source.toLowerCase();
  const budget = DAILY_BUDGET_CALLS[key];
  if (!budget) return 0;
  return (dailyCounts[key] ?? 0) / budget;
}

export function getDailyCount(source: string): number {
  maybeReset();
  return dailyCounts[source.toLowerCase()] ?? 0;
}

export function getDailyCounts(): Record<string, number> {
  maybeReset();
  return { ...dailyCounts };
}

/**
 * Clear all tracked call counts. Intended for tests and for operators who
 * need to zero the counters without waiting for the UTC rollover.
 */
export function resetDailyCounts(): void {
  for (const k of Object.keys(dailyCounts)) delete dailyCounts[k];
  lastResetDate = new Date().toISOString().slice(0, 10);
}

export interface CostModelIntegrityResult {
  valid: boolean;
  driftDetected: boolean;
  maxDriftPct: number;
  tolerancePct: number;
  discrepancies: string[];
}

/**
 * Reconciles runtime oracle call costs and daily budgets against config/cost-model.json (#555).
 * Alerts if runtime assumptions diverge from the approved capacity model beyond tolerance.
 */
export function verifyRuntimeCostModelIntegrity(customModelPath?: string): CostModelIntegrityResult {
  const defaultPath = path.resolve(__dirname, '../../../../config/cost-model.json');
  const targetPath = customModelPath || defaultPath;

  if (!fs.existsSync(targetPath)) {
    return {
      valid: true,
      driftDetected: false,
      maxDriftPct: 0,
      tolerancePct: 10,
      discrepancies: [`Warning: Cost model configuration not found at ${targetPath}`],
    };
  }

  try {
    const raw = fs.readFileSync(targetPath, 'utf8');
    const model = JSON.parse(raw);
    const tolerancePct = model.varianceThresholds?.runtimeCallCostTolerancePct ?? 10.0;
    const discrepancies: string[] = [];
    let maxDriftPct = 0;

    const modeledRates = model.runtimeOracleCallModel?.ratesPer1kCalls || {};
    const modeledBudgets = model.runtimeOracleCallModel?.dailyBudgetCalls || {};

    for (const [source, rate] of Object.entries(COST_PER_1K_CALLS)) {
      const modeledRate = modeledRates[source];
      if (modeledRate !== undefined && modeledRate !== rate) {
        const drift = modeledRate === 0 ? 100 : Math.abs(((rate - modeledRate) / modeledRate) * 100);
        maxDriftPct = Math.max(maxDriftPct, drift);
        discrepancies.push(
          `Runtime rate for source '${source}' ($${rate}/1k) differs from modeled rate ($${modeledRate}/1k) by ${drift.toFixed(1)}%`,
        );
      }
    }

    for (const [source, budget] of Object.entries(DAILY_BUDGET_CALLS)) {
      const modeledBudget = modeledBudgets[source];
      if (modeledBudget !== undefined && modeledBudget !== budget) {
        const drift = modeledBudget === 0 ? 100 : Math.abs(((budget - modeledBudget) / modeledBudget) * 100);
        maxDriftPct = Math.max(maxDriftPct, drift);
        discrepancies.push(
          `Runtime daily budget for '${source}' (${budget}) differs from modeled budget (${modeledBudget}) by ${drift.toFixed(1)}%`,
        );
      }
    }

    const driftDetected = maxDriftPct > tolerancePct;

    return {
      valid: !driftDetected,
      driftDetected,
      maxDriftPct,
      tolerancePct,
      discrepancies,
    };
  } catch (err) {
    return {
      valid: false,
      driftDetected: true,
      maxDriftPct: 100,
      tolerancePct: 10,
      discrepancies: [`Failed to parse cost model: ${(err as Error).message}`],
    };
  }
}
