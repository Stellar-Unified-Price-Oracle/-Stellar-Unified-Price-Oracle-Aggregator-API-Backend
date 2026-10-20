/**
 * Reproducible pre-approval impact analysis (#775).
 *
 * Before a catalog policy proposal can complete review, the reviewer needs a
 * defensible answer to four questions: which feeds move, which consumers are
 * exposed, what the change costs, and how much safety headroom it gives up.
 * This module answers all four from explicit inputs only — the live policy, the
 * projected feed set, an injected consumer dependency index, and a cost model.
 *
 * Reproducibility: the report is a pure function of those inputs, and
 * `deterministicHash` is a SHA-256 over their canonical encoding. Running the
 * analysis twice on the same inputs (on different replicas, or a week later)
 * yields the same hash, so a reviewer can prove the numbers they approved are
 * the numbers activation will apply.
 */

import {
  CATALOG_GUARDRAILS,
  canonicalJson,
  digestOf,
  feedsDigest,
  type CatalogDiff,
  type CatalogImpactSummary,
  type CatalogPolicy,
  type FeedPolicy,
  type GuardrailFinding,
} from './catalog-policy';

export interface ConsumerDependency {
  id: string;
  assets: string[];
  tier?: string;
}

export interface ImpactCostModel {
  /** Seconds between aggregation polls. */
  pollIntervalSeconds: number;
  /** Cost of one upstream provider fetch, in `currency`. */
  perSourceFetchCost: number;
  /** Cost of one on-chain publish per feed, in `currency`. */
  perOnChainPublishCost: number;
  currency?: string;
}

export interface MarginSnapshot {
  /** Smallest declared minimum-source count across enabled feeds. */
  minSources: number;
  /** Smallest provider diversity headroom above the guard-rail floor. */
  sourceDiversity: number;
  /** Smallest distance to the deviation ceiling, in basis points. */
  deviationHeadroomBps: number;
  /** Smallest distance to the staleness ceiling, in seconds. */
  stalenessHeadroomSeconds: number;
}

export interface ImpactReport extends CatalogImpactSummary {
  affectedFeeds: CatalogDiff;
  affectedConsumers: {
    total: number;
    ids: string[];
    byTier: Record<string, number>;
    /** `partial` means the caller supplied no consumer index at all. */
    coverage: 'complete' | 'partial';
  };
  cost: {
    currency: string;
    currentPerDay: number;
    proposedPerDay: number;
    deltaPerDay: number;
    deltaPerMonth: number;
    deltaPercent: number;
  };
  safetyMargins: {
    current: MarginSnapshot | null;
    proposed: MarginSnapshot | null;
    reduced: string[];
  };
  highImpact: boolean;
}

export interface ImpactSimulationInputs {
  current: CatalogPolicy;
  nextFeeds: FeedPolicy[];
  diff: CatalogDiff;
  findings: GuardrailFinding[];
  highImpact: boolean;
  consumers: ConsumerDependency[];
  costModel: ImpactCostModel;
}

export class ImpactSimulationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 422,
  ) {
    super(message);
    this.name = 'ImpactSimulationError';
  }
}

export function simulateCatalogImpact(inputs: ImpactSimulationInputs): ImpactReport {
  const consumers = normalizeConsumers(inputs.consumers);
  const costModel = validateCostModel(inputs.costModel);
  const affectedFeeds = sortDiff(inputs.diff);
  const affectedAssets = new Set([
    ...affectedFeeds.added,
    ...affectedFeeds.removed,
    ...affectedFeeds.modified,
  ]);

  const exposedIds = new Set(
    consumers
      .filter((consumer) => consumer.assets.some((asset) => affectedAssets.has(asset)))
      .map((consumer) => consumer.id),
  );
  const byTier: Record<string, number> = {};
  for (const consumer of consumers) {
    if (!exposedIds.has(consumer.id)) continue;
    const tier = consumer.tier ?? 'unclassified';
    byTier[tier] = (byTier[tier] ?? 0) + 1;
  }
  const sortedTiers = Object.fromEntries(
    Object.keys(byTier)
      .sort()
      .map((tier) => [tier, byTier[tier]]),
  );

  const currentCost = dailyCost(inputs.current.feeds, costModel);
  const proposedCost = dailyCost(inputs.nextFeeds, costModel);
  const deltaPerDay = round(proposedCost - currentCost, 6);
  const deltaPercent = currentCost === 0 ? (proposedCost === 0 ? 0 : 100) : round((deltaPerDay / currentCost) * 100, 4);

  const currentMargins = marginSnapshot(inputs.current.feeds);
  const proposedMargins = marginSnapshot(inputs.nextFeeds);
  const reduced = compareMargins(currentMargins, proposedMargins);

  const warnings = inputs.findings
    .filter((finding) => finding.severity === 'warning')
    .map((finding) => (finding.asset ? `${finding.code} (${finding.asset})` : finding.code))
    .sort();

  if (consumers.length === 0) warnings.push('NO_CONSUMER_DATA');
  if (deltaPercent > 5) warnings.push('COST_INCREASE_ABOVE_5_PERCENT');
  if (proposedCost > 0 && deltaPercent > 25) warnings.push('COST_INCREASE_ABOVE_25_PERCENT');
  if (exposedIds.size > 0 && consumers.length > 0 && exposedIds.size * 4 >= consumers.length) {
    warnings.push('CONSUMER_COVERAGE_AT_LEAST_25_PERCENT');
  }

  const unreachable = unreachableFeeds(inputs.nextFeeds);
  const approvalBlocked = unreachable.length > 0;
  const broadConsumerExposure =
    exposedIds.size > 0 && consumers.length > 0 && exposedIds.size * 4 >= consumers.length;
  const risk: CatalogImpactSummary['risk'] = approvalBlocked
    ? 'critical'
    : inputs.highImpact || deltaPercent > 25 || broadConsumerExposure
      ? 'high'
      : warnings.length > 0 || exposedIds.size > 0 || deltaPerDay !== 0
        ? 'medium'
        : 'low';

  const deterministicHash = digestOf({
    policy: feedsDigest(inputs.current),
    nextFeeds: sortFeeds(inputs.nextFeeds),
    consumers,
    costModel: {
      pollIntervalSeconds: costModel.pollIntervalSeconds,
      perSourceFetchCost: costModel.perSourceFetchCost,
      perOnChainPublishCost: costModel.perOnChainPublishCost,
      currency: costModel.currency,
    },
  });

  const report: ImpactReport = {
    generatedAt: new Date().toISOString(),
    deterministicHash,
    risk,
    approvalBlocked,
    warnings: [...new Set(warnings)].sort(),
    affectedFeeds,
    affectedConsumers: {
      total: exposedIds.size,
      ids: [...exposedIds].sort(),
      byTier: sortedTiers,
      coverage: consumers.length === 0 ? 'partial' : 'complete',
    },
    cost: {
      currency: costModel.currency,
      currentPerDay: round(currentCost, 6),
      proposedPerDay: round(proposedCost, 6),
      deltaPerDay,
      deltaPerMonth: round(deltaPerDay * 30, 6),
      deltaPercent,
    },
    safetyMargins: {
      current: currentMargins,
      proposed: proposedMargins,
      reduced,
    },
    highImpact: inputs.highImpact,
  };

  return report;
}

/** Canonical encoding used to compare two reports for equivalence. */
export function impactReportDigest(report: ImpactReport): string {
  const { generatedAt: _generatedAt, ...stable } = report;
  return digestOf(stable);
}

function normalizeConsumers(consumers: ConsumerDependency[]): ConsumerDependency[] {
  const seen = new Set<string>();
  return consumers
    .map((consumer) => {
      const id = typeof consumer.id === 'string' ? consumer.id.trim() : '';
      if (!id) {
        throw new ImpactSimulationError('INVALID_CONSUMER', 'Every consumer dependency needs a non-empty id');
      }
      if (seen.has(id)) {
        throw new ImpactSimulationError('DUPLICATE_CONSUMER', `Consumer ${id} appears more than once`);
      }
      seen.add(id);
      return {
        id,
        assets: [...new Set((consumer.assets ?? []).map((asset) => asset.trim().toUpperCase()))].sort(),
        tier: consumer.tier?.trim() || undefined,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

function validateCostModel(model: ImpactCostModel): Required<ImpactCostModel> {
  const pollIntervalSeconds = Number(model?.pollIntervalSeconds);
  const perSourceFetchCost = Number(model?.perSourceFetchCost);
  const perOnChainPublishCost = Number(model?.perOnChainPublishCost);

  if (!Number.isFinite(pollIntervalSeconds) || pollIntervalSeconds <= 0) {
    throw new ImpactSimulationError('INVALID_COST_MODEL', 'pollIntervalSeconds must be a positive number');
  }
  for (const [name, value] of [
    ['perSourceFetchCost', perSourceFetchCost],
    ['perOnChainPublishCost', perOnChainPublishCost],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new ImpactSimulationError('INVALID_COST_MODEL', `${name} must be a finite, non-negative number`);
    }
  }

  return {
    pollIntervalSeconds,
    perSourceFetchCost,
    perOnChainPublishCost,
    currency: model.currency?.trim() || 'USD',
  };
}

function dailyCost(feeds: FeedPolicy[], model: Required<ImpactCostModel>): number {
  const pollsPerDay = 86_400 / model.pollIntervalSeconds;
  const perPoll = feeds
    .filter((feed) => feed.enabled)
    .reduce(
      (total, feed) =>
        total + feed.sources.length * model.perSourceFetchCost + model.perOnChainPublishCost,
      0,
    );
  return perPoll * pollsPerDay;
}

function marginSnapshot(feeds: FeedPolicy[]): MarginSnapshot | null {
  const enabled = feeds.filter((feed) => feed.enabled);
  if (enabled.length === 0) return null;

  return {
    minSources: Math.min(...enabled.map((feed) => feed.minSources)),
    sourceDiversity: Math.min(
      ...enabled.map((feed) => feed.sources.length - CATALOG_GUARDRAILS.minSourceCount),
    ),
    deviationHeadroomBps: Math.min(
      ...enabled.map((feed) => CATALOG_GUARDRAILS.maxDeviationBps - feed.maxDeviationBps),
    ),
    stalenessHeadroomSeconds: Math.min(
      ...enabled.map((feed) => CATALOG_GUARDRAILS.maxStalenessSeconds - feed.stalenessSeconds),
    ),
  };
}

function compareMargins(
  current: MarginSnapshot | null,
  proposed: MarginSnapshot | null,
): string[] {
  if (!current || !proposed) return [];
  const reduced: string[] = [];
  for (const key of Object.keys(current) as Array<keyof MarginSnapshot>) {
    if (proposed[key] < current[key]) reduced.push(key);
  }
  return reduced.sort();
}

/** Feeds that could not publish under their own declared guard rails. */
function unreachableFeeds(feeds: FeedPolicy[]): string[] {
  return feeds
    .filter(
      (feed) =>
        feed.enabled &&
        (feed.sources.length < feed.minSources ||
          feed.minSources < CATALOG_GUARDRAILS.minSourceCount ||
          feed.sources.length < CATALOG_GUARDRAILS.minSourceCount),
    )
    .map((feed) => feed.asset)
    .sort();
}

function sortDiff(diff: CatalogDiff): CatalogDiff {
  return {
    added: [...diff.added].sort(),
    removed: [...diff.removed].sort(),
    modified: [...diff.modified].sort(),
    unchanged: [...diff.unchanged].sort(),
  };
}

function sortFeeds(feeds: FeedPolicy[]): FeedPolicy[] {
  return [...feeds]
    .sort((a, b) => a.asset.localeCompare(b.asset))
    .map((feed) => ({ ...feed, sources: [...feed.sources].sort() }));
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/** Exposed for tests: the canonical byte encoding a report digest covers. */
export function impactInputsDigest(inputs: ImpactSimulationInputs): string {
  return digestOf(canonicalJson(sortFeeds(inputs.nextFeeds)));
}
