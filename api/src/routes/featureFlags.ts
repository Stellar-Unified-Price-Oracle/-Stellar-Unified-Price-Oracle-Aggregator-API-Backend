/**
 * #117 — Feature Flag API routes
 *
 * GET  /api/feature-flags          — list all flags and their runtime status
 * GET  /api/feature-flags/:key     — evaluate a single flag for the caller
 * POST /api/feature-flags/:key/reset — (admin) re-enable an auto-disabled flag
 */

import { Router, Request, Response } from 'express';
import { evaluateFlag, getAllFlagStatuses, resetFlag } from '../services/featureFlags';

const router = Router();

/** List all feature flags and their current runtime status. */
router.get('/', (_req: Request, res: Response) => {
  res.json({
    flags: getAllFlagStatuses(),
    generatedAt: new Date().toISOString(),
  });
});

/**
 * Evaluate a single flag for the calling entity.
 * The entity ID is derived from the API key header or the caller's IP,
 * enabling stable percentage-based bucket assignment.
 */
router.get('/:key', (req: Request, res: Response) => {
  const { key } = req.params;
  const entityId =
    (req.headers['x-api-key'] as string | undefined) ??
    (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
    req.socket.remoteAddress ??
    '';

  const result = evaluateFlag(key, entityId);
  res.json(result);
});

/**
 * Admin endpoint: reset a flag that was auto-disabled due to errors.
 * In production this should be protected by an admin auth middleware.
 */
router.post('/:key/reset', (req: Request, res: Response) => {
  const { key } = req.params;
  const ok = resetFlag(key);
  if (!ok) {
    res.status(404).json({ error: 'Flag not found', flagKey: key });
    return;
  }
  res.json({ success: true, flagKey: key, message: `Flag "${key}" reset successfully` });
});

export default router;
