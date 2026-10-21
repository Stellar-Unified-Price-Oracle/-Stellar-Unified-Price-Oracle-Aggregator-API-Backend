/**
 * Feed catalog service (issues #671, #672, #673, #674).
 *
 * Holds the process-wide catalog: the per-feed participation policies, the
 * lifecycle state machine, the alias registry and the asset alias registry.
 *
 * The service is the single entry point used by the admin routes, so the
 * rules that govern a feed (eligibility, quorum, lifecycle, aliases) are
 * applied consistently wherever the catalog is read or changed.
 */

import {
  AssetAliasRegistration,
  resolveAssetAlias,
  type AssetResolutionResult,
} from './asset-identity';
import {
  FeedAliasEntry,
  FeedAliasRegistry,
  createFeedAliasRegistry,
  expiredFeedAliases,
  resolveFeedAlias,
} from './feed-aliases';
import {
  FeedCatalogEntry,
  FeedLookupResult,
  createFeedCatalog,
  lookupFeed,
} from './feed-catalog';
import {
  FeedLifecycleEntry,
  FeedLifecycleResult,
  FeedLifecycleStore,
  FeedTransition,
  createFeedLifecycleStore,
  registerFeed,
  transitionFeed,
} from './feed-lifecycle';
import {
  FeedPolicy,
  QuorumEvaluation,
  SourceContribution,
  evaluateQuorum,
  validateFeedPolicy,
} from './feed-policy';
import { FeedCatalogSnapshotStore, CatalogReleaseManager, type FeedCatalogSnapshot } from './catalog-snapshots';
import {
  feedAliasHitsTotal,
  feedPolicySavedTotal,
  feedPolicyValidationErrorsTotal,
  feedQuorumEvaluatedTotal,
  feedQuorumReportingSources,
  feedTransitionDeniedTotal,
  feedTransitionsTotal,
} from '../observability/metrics';

export interface FeedPolicyStore {
  get(feedId: string): FeedPolicy | undefined;
  list(): FeedPolicy[];
  save(policy: FeedPolicy): void;
  remove(feedId: string): boolean;
}

function createPolicyStore(): FeedPolicyStore {
  const policies = new Map<string, FeedPolicy>();
  return {
    get: (feedId) => policies.get(feedId),
    list: () => [...policies.values()],
    save: (policy) => {
      policies.set(policy.feedId, policy);
    },
    remove: (feedId) => policies.delete(feedId),
  };
}

export class FeedCatalogService {
  readonly snapshots = new FeedCatalogSnapshotStore();
  readonly releases = new CatalogReleaseManager(process.env.CATALOG_SIGNING_KEY ?? '');
  readonly policies: FeedPolicyStore = createPolicyStore();
  readonly lifecycle: FeedLifecycleStore = createFeedLifecycleStore();
  readonly aliases: FeedAliasRegistry = createFeedAliasRegistry();
  /** Asset-level aliases (e.g. `USDC` -> canonical asset id). */
  readonly assetAliases = new Map<string, AssetAliasRegistration>();

  constructor() {
    this.captureSnapshot();
  }

  captureSnapshot(): FeedCatalogSnapshot {
    return this.snapshots.create({
      policies: this.policies.list(),
      lifecycle: (feedId) => this.lifecycle.get(feedId),
      aliases: this.aliases.list(),
      assetAliases: [...this.assetAliases.values()],
    });
  }

  private catalog() {
    return createFeedCatalog(
      this.policies.list().map((policy) => this.entryFor(policy)),
      [...this.assetAliases.values()],
      this.lifecycle,
      this.aliases,
    );
  }

  private entryFor(policy: FeedPolicy): FeedCatalogEntry {
    return { feedId: policy.feedId, asset: policy.asset, policy };
  }

  listFeeds(): FeedPolicy[] {
    return this.policies.list();
  }

  getPolicy(feedId: string): FeedPolicy | undefined {
    return this.policies.get(feedId);
  }

  getLifecycle(feedId: string): FeedLifecycleEntry | undefined {
    return this.lifecycle.get(feedId);
  }

  /**
   * Create or replace a feed policy.
   *
   * The policy must validate; an invalid policy is rejected and never
   * stored. Replacing a policy bumps its version, so the change is
   * visible in the catalog snapshot.
   */
  savePolicy(policy: FeedPolicy): { ok: true; policy: FeedPolicy } | { ok: false; errors: string[] } {
    const validation = validateFeedPolicy(policy);
    if (!validation.valid) {
      feedPolicySavedTotal.inc({ result: 'rejected' });
      feedPolicyValidationErrorsTotal.inc({ feed: policy.feedId });
      return { ok: false, errors: validation.errors };
    }
    const existing = this.policies.get(policy.feedId);
    const stored: FeedPolicy = existing
      ? { ...policy, version: Math.max(existing.version + 1, policy.version) }
      : policy;
    this.policies.save(stored);
    feedPolicySavedTotal.inc({ result: 'accepted' });

    if (!existing) {
      registerFeed(this.lifecycle, {
        feedId: stored.feedId,
        actor: 'catalog',
        role: 'operator',
        reason: 'policy registered',
        metadata: { asset: stored.asset, version: stored.version },
      });
    }
    this.captureSnapshot();
    return { ok: true, policy: stored };
  }

  removePolicy(feedId: string): boolean {
    const removed = this.policies.remove(feedId);
    if (removed) this.captureSnapshot();
    return removed;
  }

  registerAssetAlias(alias: string, canonicalId: string): { ok: true } | { ok: false; message: string } {
    const resolution = resolveAssetAlias(canonicalId, []);
    if (!resolution.ok) {
      return { ok: false, message: resolution.message };
    }
    this.assetAliases.set(alias.trim().toUpperCase(), {
      alias: alias.trim().toUpperCase(),
      canonicalId: resolution.canonicalId,
    });
    this.captureSnapshot();
    return { ok: true };
  }

  resolveAsset(alias: string): AssetResolutionResult {
    return resolveAssetAlias(alias, [...this.assetAliases.values()]);
  }

  lookup(requested: string, allowNonPublishable = false): FeedLookupResult {
    return lookupFeed(this.catalog(), requested, { allowNonPublishable });
  }

  resolveAlias(alias: string) {
    const resolution = resolveFeedAlias(this.aliases, alias);
    if (resolution.known && resolution.kind) {
      feedAliasHitsTotal.inc({ kind: resolution.kind, expired: resolution.expired ? 'true' : 'false' });
    }
    return resolution;
  }

  registerAlias(entry: FeedAliasEntry) {
    const result = this.aliases.register(entry);
    if (result.ok) this.captureSnapshot();
    return result;
  }

  expiredAliases(now: Date = new Date()): FeedAliasEntry[] {
    return expiredFeedAliases(this.aliases, now);
  }

  applyTransition(input: {
    feedId: string;
    transition: FeedTransition;
    actor: string;
    role: 'admin' | 'operator' | 'viewer';
    reason: string;
    metadata?: Record<string, unknown>;
  }): FeedLifecycleResult {
    const result = transitionFeed(this.lifecycle, input);
    if (result.ok) {
      this.captureSnapshot();
      feedTransitionsTotal.inc({ transition: input.transition, to: result.record.to });
    } else {
      feedTransitionDeniedTotal.inc({ code: result.error.code });
    }
    return result;
  }

  /** Evaluate whether reported contributions satisfy a feed's quorum. */
  evaluateQuorum(feedId: string, contributions: SourceContribution[]): QuorumEvaluation | null {
    const policy = this.policies.get(feedId);
    if (!policy) return null;
    const evaluation = evaluateQuorum(policy, contributions);
    feedQuorumEvaluatedTotal.inc({ feed: feedId, result: evaluation.satisfied ? 'satisfied' : 'unsatisfied' });
    feedQuorumReportingSources.set({ feed: feedId }, evaluation.reportingSources);
    return evaluation;
  }
}

export const feedCatalogService = new FeedCatalogService();
