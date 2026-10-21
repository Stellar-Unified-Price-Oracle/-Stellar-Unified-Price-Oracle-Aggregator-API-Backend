import { z } from 'zod';

const evidenceLink = z.string().trim().min(1);
const feedSchema = z.object({
  asset: evidenceLink,
  shadowReport: evidenceLink,
  shadowDurationHours: z.number().finite().nonnegative(),
  pairedSamples: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  staleSamples: z.number().int().nonnegative(),
  maxDeviationBps: z.number().finite().nonnegative(),
  p99LatencyMs: z.number().finite().nonnegative(),
  requiredQuorum: z.number().int().positive(),
  healthyIndependentSourcesAfter: z.number().int().nonnegative(),
  healthyIndependentSourcesWithoutCandidate: z.number().int().nonnegative(),
}).strict();

export const cutoverEvidenceSchema = z.object({
  version: z.literal(1),
  provider: z.enum(['chainlink', 'redstone', 'band', 'reflector']),
  fromVersion: evidenceLink,
  toVersion: evidenceLink,
  owner: evidenceLink,
  reviewer: evidenceLink,
  reviewedAt: z.number().int().nonnegative(),
  decision: z.enum(['go', 'no-go']),
  fixtureReport: evidenceLink,
  upstreamContractEvidence: evidenceLink,
  sandboxIsolationReport: evidenceLink,
  monitoringDashboard: evidenceLink,
  rollback: z.object({ owner: evidenceLink, steps: evidenceLink, rehearsalReport: evidenceLink, recoverySeconds: z.number().finite().nonnegative() }).strict(),
  feeds: z.array(feedSchema).min(1),
}).strict();

export type CutoverEvidence = z.infer<typeof cutoverEvidenceSchema>;

export function reviewProviderCutover(input: unknown, now = Date.now()): { allowed: boolean; reasons: string[] } {
  const parsed = cutoverEvidenceSchema.safeParse(input);
  if (!parsed.success) return { allowed: false, reasons: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) };
  const e = parsed.data;
  const reasons: string[] = [];
  if (e.decision !== 'go') reasons.push('Explicit go decision required');
  if (e.owner === e.reviewer) reasons.push('Independent reviewer required');
  if (e.fromVersion === e.toVersion) reasons.push('Distinct transport versions required');
  if (now < e.reviewedAt || now - e.reviewedAt > 86_400_000) reasons.push('Review must be within the last 24 hours');
  if (e.rollback.recoverySeconds > 300) reasons.push('Rollback rehearsal exceeds 300 seconds');
  if (new Set(e.feeds.map(f => f.asset.toUpperCase())).size !== e.feeds.length) reasons.push('Duplicate feed evidence');
  for (const f of e.feeds) {
    if (f.shadowDurationHours < 24 || f.pairedSamples < 1000) reasons.push(`${f.asset}: insufficient shadow evidence`);
    if (f.errors > f.pairedSamples || f.errors / Math.max(f.pairedSamples, 1) > 0.001) reasons.push(`${f.asset}: error rate exceeds 0.1%`);
    if (f.staleSamples !== 0) reasons.push(`${f.asset}: stale or unverified observation times`);
    if (f.maxDeviationBps > 50) reasons.push(`${f.asset}: deviation exceeds 50 bps`);
    if (f.p99LatencyMs > 5000) reasons.push(`${f.asset}: latency exceeds 5000ms`);
    if (Math.min(f.healthyIndependentSourcesAfter, f.healthyIndependentSourcesWithoutCandidate) < f.requiredQuorum) reasons.push(`${f.asset}: quorum cannot survive candidate loss`);
  }
  return { allowed: reasons.length === 0, reasons };
}
