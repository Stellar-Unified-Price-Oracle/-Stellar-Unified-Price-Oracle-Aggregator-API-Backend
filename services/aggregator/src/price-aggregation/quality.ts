import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { NormalizedPrice } from '../infrastructure/types';
import { medianOnCommonScale, toScale } from './median';

export interface FeedQualityPolicy {
  version: string;
  maxAgeSeconds: number;
  staleWeight: number;
  excludeAfterSeconds: number;
}

export interface QualityObservation extends NormalizedPrice {
  denomination?: string;
  venue?: string;
  providerError?: string;
}

export type DisagreementCause = 'timing' | 'denomination' | 'market_venue' | 'provider_error' | 'unclassified';

export interface SourceDisagreement {
  source: string;
  cause: DisagreementCause;
  evidence: Record<string, string | number | null>;
}

export interface ReplayPolicy {
  version: string;
  maxAgeSeconds: number;
  staleWeight: number;
  excludeAfterSeconds: number;
  disagreementThresholdPercent: number;
}

export interface ReplayResult {
  asset: string;
  windowStart: number;
  windowEnd: number;
  policyVersion: string;
  price: string;
  decimals: number;
  includedSources: string[];
  excludedSources: string[];
  staleSources: string[];
  staleImpact: { freshOnlyPrice: string | null; absoluteDelta: string | null; relativeDeltaPercent: number | null };
  disagreements: SourceDisagreement[];
  resultHash: string;
}

const DEFAULT_POLICY: ReplayPolicy = {
  version: 'feed-quality-v1',
  maxAgeSeconds: 60,
  staleWeight: 0.5,
  excludeAfterSeconds: 180,
  disagreementThresholdPercent: 2,
};

function observationTime(price: QualityObservation): number {
  return price.observedAt ?? price.timestamp;
}

export function classifyDisagreement(
  observations: QualityObservation[],
  thresholdPercent = 2,
): SourceDisagreement[] {
  if (observations.length < 2) return [];
  const { value: median, decimals } = medianOnCommonScale(observations);
  if (median.isZero()) return [];
  return observations.flatMap((item) => {
    const value = toScale(item, decimals);
    const deviation = value.minus(median).abs().dividedBy(median).multipliedBy(100).toNumber();
    if (deviation <= thresholdPercent) return [];
    const peers = observations.filter((peer) => peer.source !== item.source);
    let cause: DisagreementCause = 'unclassified';
    if (item.providerError) cause = 'provider_error';
    else if (item.denomination && peers.some((peer) => peer.denomination && peer.denomination !== item.denomination)) cause = 'denomination';
    else if (item.venue && peers.some((peer) => peer.venue && peer.venue !== item.venue)) cause = 'market_venue';
    else if (Math.abs(observationTime(item) - medianObservationTime(peers)) > 30) cause = 'timing';
    return [{
      source: item.source,
      cause,
      evidence: {
        deviationPercent: Number(deviation.toFixed(8)),
        observedAt: item.observedAt ?? null,
        peerMedianObservedAt: medianObservationTime(peers),
        denomination: item.denomination ?? null,
        venue: item.venue ?? null,
        providerError: item.providerError ?? null,
      },
    }];
  });
}

function medianObservationTime(prices: QualityObservation[]): number {
  const times = prices.map(observationTime).sort((a, b) => a - b);
  return times.length ? times[Math.floor(times.length / 2)] : 0;
}

export function replayAggregation(
  asset: string,
  observations: QualityObservation[],
  windowStart: number,
  windowEnd: number,
  policy: ReplayPolicy = DEFAULT_POLICY,
): ReplayResult {
  if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd) || windowStart > windowEnd) {
    throw new Error('Invalid replay window');
  }
  if (!policy.version || policy.maxAgeSeconds < 0 || policy.excludeAfterSeconds < policy.maxAgeSeconds ||
      policy.staleWeight < 0 || policy.staleWeight > 1 || policy.disagreementThresholdPercent < 0) {
    throw new Error('Invalid replay policy');
  }
  const normalizedAsset = asset.toUpperCase();
  const window = observations.filter((p) => p.asset.toUpperCase() === normalizedAsset &&
    observationTime(p) >= windowStart && observationTime(p) <= windowEnd)
    .slice().sort((a, b) => a.source.localeCompare(b.source) || observationTime(a) - observationTime(b));
  const bySource = new Map<string, QualityObservation>();
  for (const item of window) bySource.set(item.source, item);
  const candidates = [...bySource.values()];
  const stale = candidates.filter((p) => windowEnd - observationTime(p) > policy.maxAgeSeconds);
  const included = candidates.filter((p) => windowEnd - observationTime(p) <= policy.excludeAfterSeconds);
  if (!included.length) throw new Error('Replay has no eligible observations');
  // Stale observations are deterministically down-weighted by repeating fresh
  // inputs according to the policy's integer percentage weight.
  const weighted = included.flatMap((p) => {
    const isStale = windowEnd - observationTime(p) > policy.maxAgeSeconds;
    const weight = isStale ? policy.staleWeight : 1;
    const copies = Math.round(weight * 100);
    return Array.from({ length: copies }, () => p);
  });
  if (!weighted.length) throw new Error('Replay policy assigned zero weight to all eligible observations');
  const { value, decimals } = medianOnCommonScale(weighted);
  const fresh = included.filter((p) => windowEnd - observationTime(p) <= policy.maxAgeSeconds);
  const freshMedian = fresh.length ? medianOnCommonScale(fresh).value : null;
  const delta = freshMedian === null ? null : value.minus(freshMedian).abs();
  const disagreements = classifyDisagreement(candidates, policy.disagreementThresholdPercent);
  const payload = {
    asset: normalizedAsset,
    windowStart,
    windowEnd,
    policyVersion: policy.version,
    price: value.toFixed(0),
    decimals,
    includedSources: included.map((p) => p.source).sort(),
    excludedSources: candidates.filter((p) => !included.includes(p)).map((p) => p.source).sort(),
    staleSources: stale.map((p) => p.source).sort(),
    staleImpact: {
      freshOnlyPrice: freshMedian?.toFixed(0) ?? null,
      absoluteDelta: delta?.toFixed(0) ?? null,
      relativeDeltaPercent: delta && freshMedian && !freshMedian.isZero()
        ? Number(delta.dividedBy(freshMedian.abs()).multipliedBy(100).toFixed(8))
        : null,
    },
    disagreements,
  };
  const resultHash = crypto.createHash('sha256').update(stableJson(payload)).digest('hex');
  return { ...payload, resultHash };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export interface HistoricalCorrection {
  revisionId: string;
  asset: string;
  originalTimestamp: number;
  correctedAt: number;
  reason: string;
  sourceEvidence: string[];
  previousValue: { price: string; decimals: number; source: string; timestamp: number };
  correctedValue: { price: string; decimals: number; source: string; timestamp: number };
  previousRevisionHash: string | null;
  revisionHash: string;
}

export function recordHistoricalCorrection(
  correction: Omit<HistoricalCorrection, 'revisionId' | 'previousRevisionHash' | 'revisionHash'>,
  directory: string,
): HistoricalCorrection {
  if (!correction.reason.trim() || !correction.sourceEvidence.length) throw new Error('Correction requires a reason and source evidence');
  const file = path.join(directory, `corrections-${correction.asset.toLowerCase()}.json`);
  fs.mkdirSync(directory, { recursive: true });
  const revisions: HistoricalCorrection[] = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as HistoricalCorrection[] : [];
  const body = { ...correction, revisionId: crypto.randomUUID(), previousRevisionHash: revisions.at(-1)?.revisionHash ?? null };
  const revision: HistoricalCorrection = { ...body, revisionHash: crypto.createHash('sha256').update(stableJson(body)).digest('hex') };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify([...revisions, revision]));
  fs.renameSync(tmp, file);
  return revision;
}

export function getHistoricalCorrections(asset: string, directory: string): HistoricalCorrection[] {
  const file = path.join(directory, `corrections-${asset.toLowerCase()}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as HistoricalCorrection[] : [];
}
