import { OracleSourceName } from '../infrastructure/types';
import { logger } from '../observability/logger';

/**
 * Issue #684 — Provider capability negotiation.
 *
 * Each oracle provider publishes an explicit capability profile (supported
 * assets, update cadence, precision, historical availability). The aggregator
 * negotiates feed assignments against these profiles and rejects any
 * assignment a provider cannot satisfy, instead of fetching and silently
 * discarding incompatible quotes.
 *
 * Capabilities are declared statically per provider and can be overridden at
 * runtime through the registry, which keeps the feed-assignment decision
 * independent of the transport layer.
 */

export interface Precision {
  /** The scale the provider reports / the aggregator normalizes to. */
  decimals: number;
  /** Minimum acceptable decimals; a provider reporting below this is incompatible. */
  minDecimals: number;
  /** Maximum acceptable decimals; the Soroban contract caps at 18. */
  maxDecimals: number;
}

export interface HistoricalAvailability {
  /** Earliest observation the provider can serve (null = unknown). */
  earliestUnixSeconds: number | null;
  /** How long the provider retains history (null = unknown). */
  retentionDays: number | null;
  /** Whether the provider can serve historical snapshots, not just latest. */
  snapshots: boolean;
}

export interface ProviderCapabilities {
  source: OracleSourceName;
  /** Shared upstream or operator dependency; providers in one group are not independent. */
  dependencyGroup?: string;
  /** Assets this provider is configured to quote. */
  supportedAssets: string[];
  /** Expected update interval in milliseconds. */
  updateCadenceMs: number;
  precision: Precision;
  historicalAvailability: HistoricalAvailability;
}

export interface FeedAssignment {
  source: OracleSourceName;
  asset: string;
}

export type CompatibilityOutcome =
  | { compatible: true }
  | { compatible: false; reason: string };

/**
 * Registry of provider capability profiles. Lookup is by source name; the
 * registry is the single owner of the compatibility decision so adapters and
 * the poll loop never duplicate it.
 */
export class CapabilityRegistry {
  private capabilities = new Map<OracleSourceName, ProviderCapabilities>();

  register(capabilities: ProviderCapabilities): void {
    this.capabilities.set(capabilities.source, capabilities);
    logger.info('[Capabilities] Registered profile', {
      source: capabilities.source,
      supportedAssets: capabilities.supportedAssets,
      updateCadenceMs: capabilities.updateCadenceMs,
    });
  }

  getCapabilities(source: OracleSourceName): ProviderCapabilities | undefined {
    return this.capabilities.get(source);
  }

  supportsAsset(source: OracleSourceName, asset: string): boolean {
    const capabilities = this.capabilities.get(source);
    if (!capabilities) return false;
    return capabilities.supportedAssets.includes(asset);
  }

  isAssignmentCompatible(assignment: FeedAssignment): CompatibilityOutcome {
    const capabilities = this.capabilities.get(assignment.source);
    if (!capabilities) {
      return {
        compatible: false,
        reason: `no capability profile registered for source ${assignment.source}`,
      };
    }
    if (!capabilities.supportedAssets.includes(assignment.asset)) {
      return {
        compatible: false,
        reason: `source ${assignment.source} does not carry asset ${assignment.asset}`,
      };
    }
    return { compatible: true };
  }
}

/**
 * Validates a batch of feed assignments against the capability registry and
 * returns the subset that is safe to poll, logging the rejections so an
 * operator can correct the feed configuration.
 */
export class FeedAssignmentValidator {
  constructor(private readonly registry: CapabilityRegistry) {}

  validate(assignments: FeedAssignment[]): {
    valid: FeedAssignment[];
    rejected: Array<FeedAssignment & { reason: string }>;
  } {
    const valid: FeedAssignment[] = [];
    const rejected: Array<FeedAssignment & { reason: string }> = [];

    for (const assignment of assignments) {
      const outcome = this.registry.isAssignmentCompatible(assignment);
      if (outcome.compatible) {
        valid.push(assignment);
      } else {
        rejected.push({ ...assignment, reason: outcome.reason ?? 'incompatible' });
        logger.warn('[Capabilities] Rejected incompatible feed assignment', {
          source: assignment.source,
          asset: assignment.asset,
          reason: outcome.reason,
        });
      }
    }

    return { valid, rejected };
  }
}

// ── Default capability profiles ──────────────────────────────────────────────

const DEFAULT_PRECISION = { decimals: 8, minDecimals: 0, maxDecimals: 18 };
const DEFAULT_HISTORY = { earliestUnixSeconds: null, retentionDays: 7, snapshots: false };

const WATCHED_ASSETS = ['XLM', 'USDC', 'BTC', 'ETH', 'USDT'];

export const DEFAULT_CAPABILITIES: ProviderCapabilities[] = [
  {
    source: 'chainlink',
    dependencyGroup: 'chainlink',
    supportedAssets: [...WATCHED_ASSETS],
    updateCadenceMs: 10_000,
    precision: DEFAULT_PRECISION,
    historicalAvailability: DEFAULT_HISTORY,
  },
  {
    source: 'redstone',
    dependencyGroup: 'redstone',
    supportedAssets: [...WATCHED_ASSETS],
    updateCadenceMs: 15_000,
    precision: DEFAULT_PRECISION,
    historicalAvailability: DEFAULT_HISTORY,
  },
  {
    source: 'band',
    dependencyGroup: 'band',
    supportedAssets: [...WATCHED_ASSETS],
    updateCadenceMs: 20_000,
    precision: DEFAULT_PRECISION,
    historicalAvailability: DEFAULT_HISTORY,
  },
  {
    source: 'reflector',
    dependencyGroup: 'reflector',
    supportedAssets: [...WATCHED_ASSETS],
    updateCadenceMs: 12_000,
    precision: DEFAULT_PRECISION,
    historicalAvailability: DEFAULT_HISTORY,
  },
];

/**
 * Singleton registry seeded with the default provider profiles. Tests and the
 * poll loop share this instance so the compatibility decision is consistent.
 */
export const capabilityRegistry = new CapabilityRegistry();
for (const caps of DEFAULT_CAPABILITIES) {
  capabilityRegistry.register(caps);
}
