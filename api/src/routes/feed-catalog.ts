/**
 * Feed catalog admin routes (#671, #672, #673, #674).
 *
 * A dedicated router so the feed catalog can be mounted (and rolled back)
 * independently of the wider admin surface. Every route is guarded by the
 * existing RBAC helper with a feed-specific permission.
 */

import { Router, Request, Response } from 'express';
import { requireRole } from '../governance/rbac';
import { adminAuthMiddleware } from '../governance/auth';
import { feedCatalogService } from '../feeds/feed-service';
import type { FeedTransition } from '../feeds/feed-lifecycle';

const router = Router();
const ADMIN_KEY_PREFIX = process.env.ADMIN_KEY_PREFIX || 'admin_';

router.use(adminAuthMiddleware(ADMIN_KEY_PREFIX));

router.get('/feeds', requireRole('viewer', 'feeds:read'), (_req: Request, res: Response) => {
  const feeds = feedCatalogService.listFeeds().map((policy) => {
    const lifecycle = feedCatalogService.getLifecycle(policy.feedId);
    return {
      feedId: policy.feedId,
      asset: policy.asset,
      version: policy.version,
      state: lifecycle?.state ?? 'proposed',
      sources: policy.sources,
      quorum: policy.quorum,
      freshness: policy.freshness,
      quoteUnit: policy.quoteUnit,
    };
  });
  res.json({ success: true, data: { feeds } });
});

router.get('/feeds/:feedId', requireRole('viewer', 'feeds:read'), (req: Request, res: Response) => {
  const policy = feedCatalogService.getPolicy(req.params.feedId);
  if (!policy) {
    return res.status(404).json({
      success: false,
      error: { code: 'FEED_NOT_FOUND', message: `Unknown feed: ${req.params.feedId}` },
    });
  }
  const lifecycle = feedCatalogService.getLifecycle(policy.feedId);
  res.json({
    success: true,
    data: {
      feedId: policy.feedId,
      asset: policy.asset,
      version: policy.version,
      policy,
      state: lifecycle?.state ?? 'proposed',
      changeLog: lifecycle?.changeLog ?? [],
    },
  });
});

router.put('/feeds/:feedId/policy', requireRole('operator', 'feeds:write'), (req: Request, res: Response) => {
  const body = req.body ?? {};
  const result = feedCatalogService.savePolicy({
    feedId: req.params.feedId,
    asset: body.asset,
    version: typeof body.version === 'number' ? body.version : 1,
    sources: Array.isArray(body.sources) ? body.sources : [],
    quorum: body.quorum ?? { minSources: 1 },
    freshness: body.freshness,
    quoteUnit: body.quoteUnit,
  });
  if (!result.ok) {
    return res.status(422).json({
      success: false,
      error: { code: 'INVALID_FEED_POLICY', message: result.errors.join('; ') },
    });
  }
  res.json({ success: true, data: result.policy });
});

router.post('/feeds/:feedId/transitions', requireRole('operator', 'feeds:write'), (req: Request, res: Response) => {
  const { transition, reason, metadata } = req.body ?? {};
  const result = feedCatalogService.applyTransition({
    feedId: req.params.feedId,
    transition: transition as FeedTransition,
    actor: req.apiKey?.substring(0, 8) ?? 'unknown',
    role: req.userRole ?? 'viewer',
    reason,
    metadata,
  });
  if (!result.ok) {
    const status = result.error.code === 'FEED_NOT_FOUND' ? 404 : 409;
    return res.status(status).json({
      success: false,
      error: { code: result.error.code, message: result.error.message },
    });
  }
  res.json({ success: true, data: result.record });
});

router.post('/feeds/:feedId/aliases', requireRole('operator', 'feeds:write'), (req: Request, res: Response) => {
  const { alias, successor, kind, sunsetAt, notice } = req.body ?? {};
  const result = feedCatalogService.registerAlias({
    alias,
    successor: successor ?? null,
    kind,
    sunsetAt,
    notice,
    registeredAt: new Date().toISOString(),
    registeredBy: req.apiKey?.substring(0, 8) ?? 'unknown',
  });
  if (!result.ok) {
    return res.status(409).json({
      success: false,
      error: { code: result.error.code, message: result.error.message },
    });
  }
  res.status(201).json({ success: true, data: result.entry });
});

router.get('/feeds/:feedId/quorum', requireRole('viewer', 'feeds:read'), (req: Request, res: Response) => {
  const contributions = String(req.query.contributions ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => ({ source: entry }));
  const evaluation = feedCatalogService.evaluateQuorum(req.params.feedId, contributions);
  if (!evaluation) {
    return res.status(404).json({
      success: false,
      error: { code: 'FEED_NOT_FOUND', message: `Unknown feed: ${req.params.feedId}` },
    });
  }
  res.json({ success: true, data: evaluation });
});

router.get('/assets/:alias', requireRole('viewer', 'feeds:read'), (req: Request, res: Response) => {
  const resolution = feedCatalogService.resolveAsset(req.params.alias);
  if (!resolution.ok) {
    const status = resolution.reason === 'NOT_FOUND' ? 404 : 400;
    return res.status(status).json({
      success: false,
      error: { code: resolution.reason, message: resolution.message, candidates: resolution.candidates },
    });
  }
  res.json({
    success: true,
    data: {
      requestedAlias: req.params.alias,
      canonicalId: resolution.canonicalId,
      asset: resolution.asset,
      resolution: resolution.resolution,
    },
  });
});

export default router;
