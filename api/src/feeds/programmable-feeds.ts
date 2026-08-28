export type BuiltInSource = 'chainlink' | 'redstone' | 'band' | 'reflector';
export type AggregationStrategy = 'median' | 'arithmetic-mean' | 'geometric-mean' | 'harmonic-mean' | 'trimmed-mean' | 'vwap' | 'ema' | 'median-of-medians' | 'wasm-plugin';
export type TriggerCondition = 'interval' | 'source-update' | 'price-change' | 'deviation-bound';

export interface FeedSourceDeclaration {
  name: BuiltInSource | string;
  weight?: number;
  timeoutMs?: number;
  fallback?: string[];
}

export interface FeedGuards {
  minSources: number;
  stalenessSeconds: number;
  lowerBound?: number;
  upperBound?: number;
  maxDeviationBps?: number;
}

export interface FeedTransform {
  kind: 'scale' | 'unit-conversion' | 'sma' | 'ema' | 'outlier-clipping';
  value?: number | string;
}

export interface ProgrammableFeedDefinition {
  name: string;
  version: string;
  sources: FeedSourceDeclaration[];
  aggregation: { strategy: AggregationStrategy; trimRate?: number; wasmPluginId?: string };
  triggers: Array<{ condition: TriggerCondition; value?: number }>;
  guards: FeedGuards;
  transforms: FeedTransform[];
  conditionals?: string[];
}

export interface FeedDeploymentPlan {
  contractName: string;
  estimatedGas: number;
  warnings: string[];
  definition: ProgrammableFeedDefinition;
}

export function validateFeedDefinition(definition: ProgrammableFeedDefinition): string[] {
  const errors: string[] = [];
  if (!definition.name) errors.push('feed name is required');
  if (!/^\d+\.\d+\.\d+$/.test(definition.version)) errors.push('version must be semver');
  if (definition.sources.length === 0) errors.push('at least one source is required');
  if (definition.guards.minSources > definition.sources.length) errors.push('minSources exceeds declared sources');
  if (definition.aggregation.strategy === 'wasm-plugin' && !definition.aggregation.wasmPluginId) {
    errors.push('wasmPluginId is required for wasm-plugin aggregation');
  }
  return errors;
}

export function estimateFeedGas(definition: ProgrammableFeedDefinition): FeedDeploymentPlan {
  const estimatedGas = 25000
    + definition.sources.length * 3500
    + definition.transforms.length * 1200
    + (definition.conditionals?.length ?? 0) * 1800
    + (definition.aggregation.strategy === 'wasm-plugin' ? 12000 : 0);
  return {
    contractName: `feed_${definition.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${definition.version.replace(/\./g, '_')}`,
    estimatedGas,
    warnings: estimatedGas > Number(process.env.FEED_GAS_LIMIT || 75000) ? ['estimated gas exceeds configured limit'] : [],
    definition,
  };
}

export interface MarketplaceListing {
  id: string;
  creator: string;
  usageCount: number;
  rating: number;
  gasPerSubmission: number;
  definition: ProgrammableFeedDefinition;
}

export class FeedMarketplace {
  private listings = new Map<string, MarketplaceListing>();

  publish(listing: MarketplaceListing): void {
    this.listings.set(listing.id, listing);
  }

  list(): MarketplaceListing[] {
    return [...this.listings.values()];
  }
}

export interface FeedHealth {
  feedId: string;
  submissionLatencyMs: number;
  uptimePct: number;
  referenceDeviationBps: number;
  gasCostTrend: number[];
  alert: boolean;
}

export function evaluateFeedHealth(health: FeedHealth): FeedHealth {
  const deviationLimit = Number(process.env.FEED_DEVIATION_ALERT_BPS || 100);
  return {
    ...health,
    alert: health.referenceDeviationBps > deviationLimit || health.uptimePct < 99,
  };
}

export function meteredTier(feedCount: number): 'free' | 'paid' {
  return feedCount <= Number(process.env.FEED_FREE_TIER_COUNT || 3) ? 'free' : 'paid';
}
