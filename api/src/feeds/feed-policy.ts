/**
 * Per-feed participation policy (issue #674).
 *
 * Every feed declares which sources may contribute to it and how many of
 * those sources must actually report before the aggregated price may be
 * published. Both the eligibility rule and the quorum rule live in the feed
 * policy (instead of being implied by global configuration), so the
 * participation requirement of a feed is auditable from the catalog alone.
 */

import { isCanonicalAssetId } from './asset-identity';
import { DEFAULT_QUOTE_UNIT, FRESHNESS_PROFILES, validateQuoteUnit, type FreshnessProfileName, type QuoteUnit } from '@stellar-oracle/types';

export type FeedSourceName = 'chainlink' | 'redstone' | 'band' | 'reflector';

export interface FeedSourceEligibility {
  /** Source identifier as used by the aggregator. */
  name: string;
  /** Sources that are not eligible can never contribute to this feed. */
  eligible: boolean;
  /** Optional relative weight; used for weighted quorum accounting. */
  weight?: number;
  /** Reason recorded in the change log when eligibility is switched off. */
  disabledReason?: string;
}

export interface FeedQuorumPolicy {
  /** Minimum number of eligible sources that must report. */
  minSources: number;
  /**
   * Minimum share of the total eligible weight that must report, in basis
   * points (1..10000). Optional; when absent only `minSources` applies.
   */
  minWeightBps?: number;
  /** When true, two reports from the same issuer do not count twice. */
  distinctIssuersOnly?: boolean;
}

export interface FeedPolicy {
  feedId: string;
  /** Canonical asset id — see `asset-identity.ts`. */
  asset: string;
  sources: FeedSourceEligibility[];
  quorum: FeedQuorumPolicy;
  /** Feed version, bumped whenever the policy changes. */
  version: number;
  freshness?: { profile: FreshnessProfileName; warnSeconds: number; maxAgeSeconds: number };
  quoteUnit?: QuoteUnit;
}

export interface FeedPolicyValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export const MAX_MIN_SOURCES = 64;
export const MIN_WEIGHT_BPS = 1;
export const MAX_WEIGHT_BPS = 10000;

export function validateFeedPolicy(policy: FeedPolicy): FeedPolicyValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!policy.feedId || policy.feedId.trim().length === 0) {
    errors.push('feedId is required');
  }
  if (!isCanonicalAssetId(policy.asset)) {
    errors.push(`asset "${policy.asset}" is not a canonical asset id (<network>:<CODE>:<ISSUER>)`);
  }
  if (!Number.isInteger(policy.version) || policy.version < 1) {
    errors.push('version must be a positive integer');
  }
  const freshness = policy.freshness ?? { profile: 'standard' as const, ...FRESHNESS_PROFILES.standard };
  if (!(freshness.profile in FRESHNESS_PROFILES)) errors.push('freshness profile must be realtime, standard, or delayed');
  if (!Number.isInteger(freshness.maxAgeSeconds) || freshness.maxAgeSeconds < 5 || freshness.maxAgeSeconds > 3600) errors.push('freshness maxAgeSeconds must be an integer between 5 and 3600');
  if (!Number.isInteger(freshness.warnSeconds) || freshness.warnSeconds < 1 || freshness.warnSeconds >= freshness.maxAgeSeconds) errors.push('freshness warnSeconds must be an integer between 1 and maxAgeSeconds - 1');
  const quoteErrors = validateQuoteUnit(policy.quoteUnit ?? DEFAULT_QUOTE_UNIT);
  errors.push(...quoteErrors.map((message) => `quoteUnit ${message}`));
  if (policy.sources.length === 0) {
    errors.push('at least one source declaration is required');
  }

  const names = new Set<string>();
  for (const source of policy.sources) {
    const name = (source.name ?? '').trim().toLowerCase();
    if (name.length === 0) {
      errors.push('source name is required');
      continue;
    }
    if (names.has(name)) {
      errors.push(`duplicate source declaration: ${name}`);
    }
    names.add(name);
    if (source.weight !== undefined && (!Number.isFinite(source.weight) || source.weight <= 0)) {
      errors.push(`source ${name} must have a positive weight`);
    }
    if (!source.eligible && !source.disabledReason) {
      warnings.push(`source ${name} is ineligible without a recorded reason`);
    }
  }

  const eligible = policy.sources.filter((s) => s.eligible);
  if (policy.sources.length > 0 && eligible.length === 0) {
    errors.push('at least one source must be eligible');
  }

  const { minSources, minWeightBps } = policy.quorum;
  if (!Number.isInteger(minSources) || minSources < 1) {
    errors.push('quorum.minSources must be a positive integer');
  } else if (minSources > MAX_MIN_SOURCES) {
    errors.push(`quorum.minSources must not exceed ${MAX_MIN_SOURCES}`);
  } else if (eligible.length > 0 && minSources > eligible.length) {
    errors.push('quorum.minSources exceeds the number of eligible sources');
  }

  if (minWeightBps !== undefined) {
    if (!Number.isInteger(minWeightBps) || minWeightBps < MIN_WEIGHT_BPS || minWeightBps > MAX_WEIGHT_BPS) {
      errors.push(`quorum.minWeightBps must be an integer between ${MIN_WEIGHT_BPS} and ${MAX_WEIGHT_BPS}`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

export interface SourceContribution {
  /** Source name that reported a price. */
  source: string;
  /** Issuer of the underlying asset as reported by the source. */
  issuer?: string | null;
  /** Weight used for the contribution; defaults to the policy weight. */
  weight?: number;
}

export interface QuorumEvaluation {
  /** Whether the reported contributions satisfy the policy quorum. */
  satisfied: boolean;
  /** Number of eligible sources that reported. */
  reportingSources: number;
  /** Number of eligible sources declared by the policy. */
  eligibleSources: number;
  /** Contributions that were counted towards the quorum. */
  counted: string[];
  /** Contributions that were ignored, with the reason. */
  rejected: Array<{ source: string; reason: string }>;
  /** Total weight of the counted contributions, in policy weight units. */
  totalWeight: number;
  /** Total weight of all eligible sources. */
  eligibleWeight: number;
  /** Reporting weight in basis points of the eligible weight. */
  weightBps: number;
  /** Human-readable reasons why the quorum was not met. */
  failures: string[];
}

/**
 * Evaluate whether the reported contributions satisfy the feed's quorum.
 *
 * Only sources declared eligible by the policy can contribute. When
 * `distinctIssuersOnly` is set, a second contribution from an issuer that
 * already reported is ignored — a single issuer cannot manufacture quorum.
 */
export function evaluateQuorum(
  policy: FeedPolicy,
  contributions: SourceContribution[],
): QuorumEvaluation {
  const eligible = new Map<string, FeedSourceEligibility>();
  for (const source of policy.sources) {
    if (source.eligible) {
      eligible.set(source.name.trim().toLowerCase(), source);
    }
  }

  const counted: string[] = [];
  const rejected: Array<{ source: string; reason: string }> = [];
  const seenIssuers = new Set<string>();
  let totalWeight = 0;

  for (const contribution of contributions) {
    const name = (contribution.source ?? '').trim().toLowerCase();
    const declaration = eligible.get(name);
    if (!declaration) {
      rejected.push({ source: contribution.source, reason: 'source is not eligible for this feed' });
      continue;
    }
    if (counted.includes(name)) {
      rejected.push({ source: contribution.source, reason: 'duplicate contribution from the same source' });
      continue;
    }
    if (policy.quorum.distinctIssuersOnly) {
      const issuer = contribution.issuer ?? null;
      if (issuer !== null) {
        if (seenIssuers.has(issuer)) {
          rejected.push({ source: contribution.source, reason: 'issuer already counted towards quorum' });
          continue;
        }
        seenIssuers.add(issuer);
      }
    }
    counted.push(name);
    totalWeight += contribution.weight ?? declaration.weight ?? 1;
  }

  const eligibleWeight = [...eligible.values()].reduce(
    (sum, source) => sum + (source.weight ?? 1),
    0,
  );
  const weightBps = eligibleWeight > 0 ? Math.round((totalWeight / eligibleWeight) * 10000) : 0;

  const failures: string[] = [];
  if (counted.length < policy.quorum.minSources) {
    failures.push(
      `only ${counted.length} of the required ${policy.quorum.minSources} eligible sources reported`,
    );
  }
  if (policy.quorum.minWeightBps !== undefined && weightBps < policy.quorum.minWeightBps) {
    failures.push(
      `reporting weight ${weightBps} bps is below the required ${policy.quorum.minWeightBps} bps`,
    );
  }

  return {
    satisfied: failures.length === 0,
    reportingSources: counted.length,
    eligibleSources: eligible.size,
    counted,
    rejected,
    totalWeight,
    eligibleWeight,
    weightBps,
    failures,
  };
}
