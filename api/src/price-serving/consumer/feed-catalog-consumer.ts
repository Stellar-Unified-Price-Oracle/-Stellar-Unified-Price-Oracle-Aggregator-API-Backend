import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { feedCatalogService } from '../../feeds/feed-service';
import { parseCanonicalAssetId } from '../../feeds/asset-identity';
import { optionalAuthMiddleware } from '../../governance/auth';
import { v2Ok, v2Fail } from '../../infrastructure/response';

const router = Router();

const FeedListQuerySchema = z.object({
  network: z.string().optional().describe('Filter by network: mainnet (public) or testnet'),
  quoteUnit: z.string().optional().describe('Filter by quote unit parsed from the feed id, e.g. USD'),
  sourceCoverage: z.coerce.number().int().min(1).max(64).optional().describe('Minimum number of eligible sources'),
  lifecycleState: z.string().optional().describe('Filter by lifecycle state: proposed, active, canary, retired...'),
  page: z.coerce.number().int().positive().default(1).describe('Page number'),
  limit: z.coerce.number().int().positive().max(100).default(20).describe('Page size'),
});

function deriveNetwork(canonicalAsset: string): string {
  const parsed = parseCanonicalAssetId(canonicalAsset);
  if (!parsed) return 'mainnet';
  return parsed.network === 'testnet' ? 'testnet' : 'mainnet';
}

function deriveQuoteUnit(feedId: string): string {
  const parts = feedId.split('-');
  if (parts.length < 2) return 'USD';
  return parts[parts.length - 1].toUpperCase();
}

function eligibleSourceCount(feedId: string): number {
  const policy = feedCatalogService.getPolicy(feedId);
  if (!policy || !Array.isArray(policy.sources)) return 0;
  return policy.sources.filter((s) => s.eligible).length;
}

router.get('/', optionalAuthMiddleware, (req: Request, res: Response) => {
  const parsed = FeedListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json(v2Fail({ code: 'VALIDATION_ERROR', message: 'Invalid query parameters' }));
  }

  const { network, quoteUnit, sourceCoverage, lifecycleState, page, limit } = parsed.data;

  const allPolicies = feedCatalogService.listFeeds();

  const decorated = allPolicies
    .map((policy) => {
      const lifecycle = feedCatalogService.getLifecycle(policy.feedId);
      return {
        policy,
        state: lifecycle?.state ?? 'active',
        network: deriveNetwork(policy.asset),
        quoteUnit: deriveQuoteUnit(policy.feedId),
        eligibleSources: eligibleSourceCount(policy.feedId),
      };
    })
    .filter((entry) => {
      if (network) {
        const wanted = network.toLowerCase() === 'public' ? 'mainnet' : network.toLowerCase();
        if (entry.network !== wanted) return false;
      }
      if (quoteUnit && entry.quoteUnit !== quoteUnit.toUpperCase()) return false;
      if (sourceCoverage !== undefined && entry.eligibleSources < sourceCoverage) return false;
      if (lifecycleState && entry.state !== lifecycleState) return false;
      return true;
    })
    .sort((a, b) => a.policy.feedId.localeCompare(b.policy.feedId));

  const total = decorated.length;
  const offset = (page - 1) * limit;
  const pageItems = decorated.slice(offset, offset + limit);

  const feeds = pageItems.map((entry) => ({
    feedId: entry.policy.feedId,
    asset: entry.policy.asset,
    version: entry.policy.version,
    state: entry.state,
    network: entry.network,
    quoteUnit: entry.quoteUnit,
    eligibleSources: entry.eligibleSources,
    quorum: entry.policy.quorum,
  }));

  return res.json(v2Ok({
    feeds,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      hasNext: offset + limit < total,
      hasPrev: page > 1,
    },
    filters: { network, quoteUnit, sourceCoverage, lifecycleState },
  }));
});

router.get('/:feedId', optionalAuthMiddleware, (req: Request, res: Response) => {
  const feedId = req.params.feedId;
  const policy = feedCatalogService.getPolicy(feedId);
  if (!policy) {
    return res.status(404).json(v2Fail({ code: 'FEED_NOT_FOUND', message: 'Unknown feed: ' + feedId }));
  }
  const lifecycle = feedCatalogService.getLifecycle(feedId);
  return res.json(v2Ok({
    feedId: policy.feedId,
    asset: policy.asset,
    version: policy.version,
    state: lifecycle?.state ?? 'active',
    network: deriveNetwork(policy.asset),
    quoteUnit: deriveQuoteUnit(policy.feedId),
    eligibleSources: eligibleSourceCount(policy.feedId),
    sources: policy.sources,
    quorum: policy.quorum,
  }));
});

export default router;
