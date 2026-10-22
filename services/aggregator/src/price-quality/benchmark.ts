import { createHash } from 'node:crypto';
import BigNumber from 'bignumber.js';
import { z } from 'zod';
import { FreshnessPolicy, freshnessBudget, isFresh, realizedVolatility } from './freshness';

const positiveDecimal = z.string().max(128).regex(/^\d+(\.\d+)?$/).refine(v => new BigNumber(v).gt(0));
const timestamp = z.number().int().nonnegative().safe();
export const referenceSchema = z.object({
  asset: z.enum(['BTC', 'ETH']), timestamp, price: positiveDecimal,
  reference: z.literal('coinmetrics-price-usd'),
}).strict();
export const predictionSchema = z.object({
  asset: z.enum(['BTC', 'ETH']), timestamp, price: positiveDecimal,
  confidence: z.number().finite().min(0).max(1),
  observedAt: timestamp.nullable(),
}).strict().refine(p => p.observedAt === null || p.observedAt <= p.timestamp, 'Observation cannot be after the output');
export const manifestSchema = z.object({
  version: z.literal('1'), owner: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  start: timestamp, end: timestamp,
  intervalSeconds: z.literal(86400), assets: z.array(z.enum(['BTC', 'ETH'])).length(2),
  provenance: z.array(z.object({ url: z.string().url(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).length(2),
  selection: z.string().min(1), coverageNotes: z.string().min(1), license: z.string().min(1),
}).strict().refine(m => m.end > m.start && new Set(m.assets).size === 2);
export type Prediction = z.infer<typeof predictionSchema>;
export type Reference = z.infer<typeof referenceSchema>;
const key = (r: { asset: string; timestamp: number }) => `${r.asset}:${r.timestamp}`;

export function loadCorpus(raw: string, manifestInput: unknown): Reference[] {
  const manifest = manifestSchema.parse(manifestInput);
  if (createHash('sha256').update(raw).digest('hex') !== manifest.sha256) throw new Error('Corpus checksum mismatch');
  const rows = raw.trim().split('\n').map(line => referenceSchema.parse(JSON.parse(line)));
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(key(row))) throw new Error('Duplicate reference');
    seen.add(key(row));
    if (!manifest.assets.includes(row.asset) || row.timestamp < manifest.start || row.timestamp >= manifest.end
      || (row.timestamp - manifest.start) % manifest.intervalSeconds !== 0) throw new Error('Reference outside declared grid');
  }
  const expected = (manifest.end - manifest.start) / manifest.intervalSeconds * manifest.assets.length;
  if (rows.length !== expected) throw new Error('Incomplete reference coverage');
  return rows;
}

export function scoreWindow(references: Reference[], input: unknown[], start: number, end: number,
  acceptableErrorBps = 100, minSamples = 30) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start
    || !Number.isFinite(acceptableErrorBps) || acceptableErrorBps <= 0
    || !Number.isSafeInteger(minSamples) || minSamples < 1) throw new Error('Invalid scoring window or bounds');
  const referenceMap = new Map<string, Reference>();
  for (const value of references) {
    const reference = referenceSchema.parse(value);
    if (referenceMap.has(key(reference))) throw new Error('Duplicate reference');
    referenceMap.set(key(reference), reference);
  }
  const seen = new Set<string>();
  const bins = Array.from({ length: 5 }, (_, i) => ({ lower: i / 5, upper: (i + 1) / 5, errors: [] as number[], scores: [] as number[] }));
  let unmatched = 0;
  let outsideWindow = 0;
  let unverifiedAge = 0;
  for (const value of input) {
    const p = predictionSchema.parse(value);
    if (seen.has(key(p))) throw new Error('Duplicate prediction');
    seen.add(key(p));
    if (p.timestamp < start || p.timestamp >= end) { outsideWindow++; continue; }
    const reference = referenceMap.get(key(p));
    if (!reference) { unmatched++; continue; }
    const error = new BigNumber(p.price).minus(reference.price).abs().div(reference.price).times(10000).toNumber();
    if (!Number.isFinite(error)) throw new Error('Error overflow');
    const bin = bins[Math.min(4, Math.floor(p.confidence * 5))];
    bin.errors.push(error);
    bin.scores.push(p.confidence);
    if (p.observedAt === null) unverifiedAge++;
  }
  const eligibleReferences = references.filter(r => r.timestamp >= start && r.timestamp < end).length;
  const curve = bins.map(bin => {
    const sorted = bin.errors.sort((a, b) => a - b);
    const count = sorted.length;
    const within = sorted.filter(e => e <= acceptableErrorBps).length;
    const rate = count ? within / count : null;
    const z = 1.96;
    const wilsonLower = count ? (rate! + z * z / (2 * count) - z * Math.sqrt(rate! * (1 - rate!) / count + z * z / (4 * count * count))) / (1 + z * z / count) : null;
    return { lower: bin.lower, upper: bin.upper, count,
      meanConfidence: count ? bin.scores.reduce((a, b) => a + b, 0) / count : null,
      meanErrorBps: count ? sorted.reduce((a, b) => a + b, 0) / count : null,
      p95ErrorBps: count ? sorted[Math.ceil(count * 0.95) - 1] : null,
      withinBoundRate: rate, wilsonLower95: wilsonLower,
      status: count < minSamples ? 'insufficient-data' : sorted[Math.ceil(count * 0.95) - 1] <= acceptableErrorBps ? 'pass' : 'fail' };
  });
  const matched = curve.reduce((n, b) => n + b.count, 0);
  return { version: '1', confidenceVersion: 'source-count-ratio-v1', start, end, acceptableErrorBps, minSamples,
    eligibleReferences, matched, unmatched, outsideWindow, unverifiedAge,
    coverage: eligibleReferences ? matched / eligibleReferences : 0, curve };
}

export function backtestFreshness(references: Reference[], policy: FreshnessPolicy) {
  freshnessBudget(policy, 0);
  const previous = new Map<string, Reference>();
  let comparisons = 0;
  let adaptiveAccepted = 0;
  let fixedAccepted = 0;
  let hardLimitViolations = 0;
  for (const row of [...references].sort((a, b) => a.timestamp - b.timestamp || a.asset.localeCompare(b.asset))) {
    const prior = previous.get(row.asset);
    if (prior) {
      const budget = freshnessBudget(policy, realizedVolatility(prior.price, row.price));
      for (const age of [0, policy.minAgeMs - 1, policy.minAgeMs, policy.baseAgeMs - 1, policy.baseAgeMs, policy.hardMaxAgeMs, policy.hardMaxAgeMs + 1]) {
        comparisons++;
        const nowMs = row.timestamp * 1000 + age;
        const accepted = isFresh(row.timestamp, nowMs, budget);
        adaptiveAccepted += Number(accepted);
        fixedAccepted += Number(isFresh(row.timestamp, nowMs, policy.baseAgeMs));
        hardLimitViolations += Number(accepted && age >= policy.hardMaxAgeMs);
      }
    }
    previous.set(row.asset, row);
  }
  return { policy, comparisons, adaptiveAccepted, fixedAccepted, hardLimitViolations,
    limitation: 'Daily historical volatility with synthetic age probes; not an intraday latency or trading backtest.' };
}
