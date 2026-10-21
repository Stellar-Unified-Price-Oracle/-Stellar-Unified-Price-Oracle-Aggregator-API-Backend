import BigNumber from 'bignumber.js';
import { z } from 'zod';

export const freshnessPolicySchema = z.object({
  hardMaxAgeMs: z.number().finite().positive(),
  minAgeMs: z.number().finite().positive(),
  baseAgeMs: z.number().finite().positive(),
  sensitivity: z.number().finite().nonnegative(),
}).strict().refine(p => p.minAgeMs <= p.baseAgeMs && p.baseAgeMs <= p.hardMaxAgeMs,
  'Require minAgeMs <= baseAgeMs <= hardMaxAgeMs');
export type FreshnessPolicy = z.infer<typeof freshnessPolicySchema>;

export function freshnessBudget(policy: FreshnessPolicy, volatilityBps: number): number {
  freshnessPolicySchema.parse(policy);
  if (!Number.isFinite(volatilityBps) || volatilityBps < 0) throw new Error('Invalid volatility');
  return Math.min(policy.hardMaxAgeMs, Math.max(policy.minAgeMs,
    policy.baseAgeMs / (1 + policy.sensitivity * volatilityBps / 10000)));
}

export function realizedVolatility(previous: string, current: string): number {
  const before = new BigNumber(previous);
  const after = new BigNumber(current);
  if (!before.isFinite() || !after.isFinite() || before.lte(0) || after.lte(0)) {
    throw new Error('Volatility prices must be finite and positive');
  }
  const result = after.minus(before).abs().div(before).times(10000).toNumber();
  if (!Number.isFinite(result)) throw new Error('Volatility overflow');
  return result;
}

export function isFresh(observedAt: number | null | undefined, nowMs: number, budgetMs: number): boolean {
  return observedAt != null && Number.isFinite(observedAt) && observedAt >= 0 && Number.isFinite(nowMs)
    && Number.isFinite(budgetMs) && budgetMs > 0
    && observedAt * 1000 <= nowMs && nowMs - observedAt * 1000 < budgetMs;
}
