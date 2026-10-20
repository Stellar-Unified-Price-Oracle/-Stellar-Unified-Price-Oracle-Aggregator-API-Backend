/**
 * Feed catalog (issue #671, #672, #673, #674).
 *
 * The catalog ties the four pieces of the feed-catalog workstream together:
 *
 *   - `asset-identity.ts`  canonical asset ids and alias resolution (#671)
 *   - `feed-policy.ts`     per-feed eligibility and quorum rules (#674)
 *   - `feed-lifecycle.ts`  governed onboarding state machine (#672)
 *   - `feed-aliases.ts`    rename / merge / retirement semantics (#673)
 *
 * A catalog lookup answers one question: "which feed serves this request, and
 * under which participation rule?" The answer carries the canonical feed id,
 * the policy, the lifecycle state and any alias metadata the caller must
 * surface to its own consumers.
 */

import {
  AssetAliasRegistration,
  CanonicalAsset,
  formatCanonicalAssetId,
  parseCanonicalAssetId,
  resolveAssetAlias,
  type AssetResolutionResult,
} from './asset-identity';
import {
  FeedAliasMetadata,
  FeedAliasRegistry,
  aliasMetadata,
  resolveFeedAlias,
} from './feed-aliases';
import {
  FeedLifecycleState,
  FeedLifecycleStore,
  isCanaryState,
  isPublishableState,
} from './feed-lifecycle';
import { FeedPolicy, validateFeedPolicy } from './feed-policy';

export interface FeedCatalogEntry {
  /** Canonical feed identifier, e.g. `btc-usd`. */
  feedId: string;
  /** Canonical asset id the feed prices. */
  asset: string;
  policy: FeedPolicy;
}

export interface FeedCatalog {
  entries: Map<string, FeedCatalogEntry>;
  assetRegistry: AssetAliasRegistration[];
  lifecycle: FeedLifecycleStore;
  aliases: FeedAliasRegistry;
}

export function createFeedCatalog(
  entries: FeedCatalogEntry[] = [],
  assetRegistry: AssetAliasRegistration[] = [],
  lifecycle: FeedLifecycleStore,
  aliases: FeedAliasRegistry,
): FeedCatalog {
  const map = new Map<string, FeedCatalogEntry>();
  for (const entry of entries) {
    map.set(entry.feedId, entry);
  }
  return { entries: map, assetRegistry, lifecycle, aliases };
}

export type FeedLookupErrorCode =
  | 'FEED_NOT_FOUND'
  | 'INVALID_ASSET'
  | 'AMBIGUOUS_ASSET'
  | 'INVALID_POLICY'
  | 'FEED_NOT_PUBLISHABLE';

export interface FeedLookupError {
  code: FeedLookupErrorCode;
  message: string;
  candidates?: string[];
}

export interface FeedLookupSuccess {
  ok: true;
  feed: FeedCatalogEntry;
  state: FeedLifecycleState;
  publishable: boolean;
  canary: boolean;
  alias: FeedAliasMetadata | null;
  asset: CanonicalAsset;
}

export type FeedLookupResult = FeedLookupSuccess | { ok: false; error: FeedLookupError };

/**
 * Look up a feed by id or by asset alias.
 *
 * The requested value is first matched against the feed ids and the alias
 * registry; a bare asset alias (e.g. `USDC`) resolves to the feed that prices
 * that canonical asset.
 */
export function lookupFeed(
  catalog: FeedCatalog,
  requested: string,
  options: { allowNonPublishable?: boolean; now?: Date } = {},
): FeedLookupResult {
  const requestedId = requested.trim();
  if (requestedId.length === 0) {
    return { ok: false, error: { code: 'FEED_NOT_FOUND', message: 'feed identifier must not be empty' } };
  }

  const direct = catalog.entries.get(requestedId);
  if (direct) {
    return describeFeed(catalog, direct.feedId, null, options);
  }

  const aliasResolution = resolveFeedAlias(catalog.aliases, requestedId, options.now);
  if (aliasResolution.known && aliasResolution.resolvedFeed !== null) {
    const successor = catalog.entries.get(aliasResolution.resolvedFeed);
    if (successor) {
      return describeFeed(catalog, successor.feedId, aliasMetadata(aliasResolution), options);
    }
  }

  const assetResolution: AssetResolutionResult = resolveAssetAlias(requestedId, catalog.assetRegistry);
  if (!assetResolution.ok) {
    if (assetResolution.reason === 'AMBIGUOUS') {
      return {
        ok: false,
        error: {
          code: 'AMBIGUOUS_ASSET',
          message: assetResolution.message,
          candidates: assetResolution.candidates,
        },
      };
    }
    if (assetResolution.reason === 'NOT_FOUND') {
      return {
        ok: false,
        error: { code: 'FEED_NOT_FOUND', message: assetResolution.message },
      };
    }
    return { ok: false, error: { code: 'INVALID_ASSET', message: assetResolution.message } };
  }

  const canonicalId = assetResolution.canonicalId;
  const match = [...catalog.entries.values()].find((entry) => entry.asset === canonicalId);
  if (!match) {
    return {
      ok: false,
      error: { code: 'FEED_NOT_FOUND', message: `no feed prices ${canonicalId}` },
    };
  }
  return describeFeed(catalog, match.feedId, null, options);
}

function describeFeed(
  catalog: FeedCatalog,
  feedId: string,
  alias: FeedAliasMetadata | null,
  options: { allowNonPublishable?: boolean; now?: Date },
): FeedLookupResult {
  const feed = catalog.entries.get(feedId);
  if (!feed) {
    return { ok: false, error: { code: 'FEED_NOT_FOUND', message: `unknown feed ${feedId}` } };
  }

  const validation = validateFeedPolicy(feed.policy);
  if (!validation.valid) {
    return {
      ok: false,
      error: { code: 'INVALID_POLICY', message: validation.errors.join('; ') },
    };
  }

  const lifecycle = catalog.lifecycle.get(feedId);
  const state: FeedLifecycleState = lifecycle?.state ?? 'active';
  const publishable = isPublishableState(state);
  const canary = isCanaryState(state);

  if (!publishable && !canary && !options.allowNonPublishable) {
    return {
      ok: false,
      error: {
        code: 'FEED_NOT_PUBLISHABLE',
        message: `feed ${feedId} is in state ${state} and does not serve prices`,
      },
    };
  }

  const asset = parseCanonicalAssetId(feed.asset);
  if (asset === null) {
    return {
      ok: false,
      error: { code: 'INVALID_ASSET', message: `feed ${feedId} has an invalid asset id` },
    };
  }

  return {
    ok: true,
    feed,
    state,
    publishable,
    canary,
    alias,
    asset,
  };
}

/** Convenience helper: the canonical id of the asset a feed prices. */
export function feedAssetId(feed: FeedCatalogEntry): string {
  return formatCanonicalAssetId(parseCanonicalAssetId(feed.asset) as CanonicalAsset);
}
