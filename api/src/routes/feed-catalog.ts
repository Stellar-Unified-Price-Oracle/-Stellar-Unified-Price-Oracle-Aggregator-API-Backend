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

router.get('/snapshots', (req: Request, res: Response) => {
  const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit ?? '25'), 10) || 25));
  const snapshots = feedCatalogService.snapshots.list();
  const cursor = typeof req.query.cursor === 'string' ? snapshots.findIndex((item) => item.id === req.query.cursor) : -1;
  if (req.query.cursor && cursor < 0) return res.status(400).json({ success: false, error: { code: 'INVALID_CURSOR', message: 'Unknown snapshot cursor' } });
  const start = cursor < 0 ? 0 : cursor + 1;
  const page = snapshots.slice(start, start + limit);
  res.json({ success: true, data: { snapshots: page, nextCursor: start + limit < snapshots.length ? page[page.length - 1]?.id ?? null : null } });
});

router.get('/snapshots/:snapshotId', (req: Request, res: Response) => {
  const snapshot = feedCatalogService.snapshots.get(req.params.snapshotId);
  if (!snapshot) return res.status(404).json({ success: false, error: { code: 'SNAPSHOT_NOT_FOUND', message: 'Unknown catalog snapshot' } });
  const etag = `\"${snapshot.id}\"`;
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  res.json({ success: true, data: snapshot });
});

router.get('/releases', (_req: Request, res: Response) => {
  res.json({ success: true, data: feedCatalogService.releases.state() });
});

router.get('/releases/stable', (req: Request, res: Response) => {
  const release = feedCatalogService.releases.state().stable;
  const snapshot = release && feedCatalogService.snapshots.get(release.snapshotId);
  if (!snapshot) return res.status(404).json({ success: false, error: { code: 'NO_STABLE_RELEASE', message: 'No stable catalog release is available' } });
  const etag = `"${snapshot.id}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'public, max-age=60');
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  return res.json({ success: true, data: snapshot, release });
});

router.get('/releases/compare/:snapshotId', (req: Request, res: Response) => {
  if (!feedCatalogService.snapshots.get(req.params.snapshotId)) return res.status(404).json({ success: false, error: { code: 'SNAPSHOT_NOT_FOUND', message: 'Unknown catalog snapshot' } });
  const candidate = feedCatalogService.snapshots.get(req.params.snapshotId)!;
  const stableRelease = feedCatalogService.releases.state().stable;
  const stable = stableRelease ? feedCatalogService.snapshots.get(stableRelease.snapshotId) : undefined;
  res.json({ success: true, data: feedCatalogService.releases.compare(req.params.snapshotId, candidate, stable) });
});

router.use(adminAuthMiddleware(ADMIN_KEY_PREFIX));

router.post('/releases/canary', requireRole('operator', 'feeds:write'), (req: Request, res: Response) => {
  const snapshotId = req.body?.snapshotId;
  if (typeof snapshotId !== 'string' || !feedCatalogService.snapshots.get(snapshotId)) return res.status(404).json({ success: false, error: { code: 'SNAPSHOT_NOT_FOUND', message: 'Unknown catalog snapshot' } });
  try {
    const release = feedCatalogService.releases.sign(snapshotId);
    if (!feedCatalogService.releases.stageCanary(release)) return res.status(422).json({ success: false, error: { code: 'INVALID_SIGNATURE', message: 'Catalog release signature is invalid' } });
    return res.status(201).json({ success: true, data: release });
  } catch (error) {
    return res.status(503).json({ success: false, error: { code: 'SIGNING_UNAVAILABLE', message: error instanceof Error ? error.message : 'Signing unavailable' } });
  }
});

router.post('/releases/promote', requireRole('admin', 'feeds:write'), (_req: Request, res: Response) => {
  if (!feedCatalogService.releases.promoteCanary()) return res.status(409).json({ success: false, error: { code: 'NO_VALID_CANARY', message: 'No verified canary release is staged' } });
  res.json({ success: true, data: feedCatalogService.releases.state() });
});

router.post('/releases/rollback', requireRole('admin', 'feeds:write'), (req: Request, res: Response) => {
  const { snapshotId, signature } = req.body ?? {};
  if (typeof snapshotId !== 'string' || typeof signature !== 'string' || !feedCatalogService.releases.rollback(snapshotId, signature)) {
    return res.status(422).json({ success: false, error: { code: 'ROLLBACK_NOT_VERIFIED', message: 'Rollback requires a previously promoted signed snapshot' } });
  }
  res.json({ success: true, data: feedCatalogService.releases.state() });
});

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
