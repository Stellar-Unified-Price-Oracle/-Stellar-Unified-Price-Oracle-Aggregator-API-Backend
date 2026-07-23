// Cost estimates in USD per 1000 API calls. Adjust per actual contract terms.
const COST_PER_1K_CALLS: Record<string, number> = {
  chainlink: 0.0,    // free public feeds
  redstone:  0.0,    // free public feeds
  band:      0.0,    // free public feeds
  reflector: 0.0,    // free public feeds
};

// Daily call budget per source (set to 0 to disable budget tracking).
const DAILY_BUDGET_CALLS: Record<string, number> = {
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
    for (const k of Object.keys(dailyCounts)) dailyCounts[k] = 0;
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
