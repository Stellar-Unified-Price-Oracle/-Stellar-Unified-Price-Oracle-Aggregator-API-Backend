import { Router, Request, Response } from 'express';
import { apiKeyManager } from '../services/api-key-manager';
import { adminAuthMiddleware } from '../middleware/auth';
import { requireRole, ROLES, ROLE_PERMISSIONS } from '../middleware/rbac';
import { logger } from '../middleware/logger';
import { auditLog } from '../services/audit-logger';
import type { Role } from '../middleware/rbac';

const router = Router();
const ADMIN_KEY_PREFIX = process.env.ADMIN_KEY_PREFIX || 'admin_';

router.use(adminAuthMiddleware(ADMIN_KEY_PREFIX));

function reqCtx(req: Request) {
  return {
    ip: req.ip || 'unknown',
    userAgent: (req.headers['user-agent'] as string) || 'unknown',
    apiKeyPrefix: req.apiKey?.substring(0, 8) || 'unknown',
  };
}

/**
 * POST /api/v1/admin/keys
 * Generate a new API key
 */
router.post('/keys', requireRole('admin'), (req: Request, res: Response) => {
  const { rateLimitPerMin = 100, description, role = 'viewer' } = req.body;

  if (typeof rateLimitPerMin !== 'number' || rateLimitPerMin < 1) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_RATE_LIMIT', message: 'rateLimitPerMin must be a positive number' },
    });
  }

  if (!ROLES.includes(role as Role)) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_ROLE', message: `role must be one of: ${ROLES.join(', ')}` },
    });
  }

  try {
    const newKey = apiKeyManager.generateKey(rateLimitPerMin, description, role as Role);

    auditLog('admin.key_created', {
      ...reqCtx(req),
      newState: { keyPrefix: newKey.key.substring(0, 8), rateLimitPerMin, role },
    });

    logger.info(`Admin ${req.apiKey?.substring(0, 8)}... generated new API key`);

    res.status(201).json({
      success: true,
      data: {
        key: newKey.key,
        createdAt: new Date(newKey.createdAt).toISOString(),
        rateLimitPerMin: newKey.rateLimitPerMin,
        description: newKey.description,
        role: newKey.role,
        message: 'Store this key securely. It will not be shown again.',
      },
    });
  } catch (err) {
    logger.error('Failed to generate API key', err);
    res.status(500).json({
      success: false,
      error: { code: 'KEY_GENERATION_FAILED', message: 'Failed to generate API key' },
    });
  }
});

/**
 * GET /api/v1/admin/keys
 * List all API keys
 */
router.get('/keys', (req: Request, res: Response) => {
  try {
    const keys = apiKeyManager.getAllKeys();
    res.json({ success: true, data: { count: keys.length, keys } });
  } catch (err) {
    logger.error('Failed to list API keys', err);
    res.status(500).json({
      success: false,
      error: { code: 'KEY_LIST_FAILED', message: 'Failed to list API keys' },
    });
  }
});

/**
 * GET /api/v1/admin/keys/:keyPrefix
 * Get details for a specific API key
 */
router.get('/keys/:keyPrefix', (req: Request, res: Response) => {
  const { keyPrefix } = req.params;
  const keys = apiKeyManager.getAllKeys();
  const keyInfo = keys.find((k) => k.keyPrefix.startsWith(keyPrefix));

  if (!keyInfo) {
    return res.status(404).json({
      success: false,
      error: { code: 'KEY_NOT_FOUND', message: 'API key not found' },
    });
  }

  res.json({ success: true, data: keyInfo });
});

/**
 * PUT /api/v1/admin/keys/:keyPrefix/rate-limit
 * Update rate limit for a key
 */
router.put('/keys/:keyPrefix/rate-limit', requireRole('operator'), (req: Request, res: Response) => {
  const { keyPrefix } = req.params;
  const { rateLimitPerMin } = req.body;

  if (typeof rateLimitPerMin !== 'number' || rateLimitPerMin < 1) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_RATE_LIMIT', message: 'rateLimitPerMin must be a positive number' },
    });
  }

  const fullKey = apiKeyManager.findKeyByPrefix(keyPrefix);
  if (!fullKey) {
    return res.status(404).json({
      success: false,
      error: { code: 'KEY_NOT_FOUND', message: 'API key not found' },
    });
  }

  const prev = apiKeyManager.getKeyMetadata(fullKey);
  apiKeyManager.updateRateLimit(fullKey, rateLimitPerMin);

  auditLog('admin.rate_limit_updated', {
    ...reqCtx(req),
    details: { keyPrefix },
    prevState: { rateLimitPerMin: prev?.rateLimitPerMin },
    newState: { rateLimitPerMin },
  });

  logger.info(`Admin ${req.apiKey?.substring(0, 8)}... updated rate limit for ${keyPrefix} to ${rateLimitPerMin}`);

  res.json({ success: true, data: { keyPrefix, newRateLimit: rateLimitPerMin } });
});

/**
 * PUT /api/v1/admin/keys/:keyPrefix/role
 * Update role for a key (RBAC: issue #34)
 */
router.put('/keys/:keyPrefix/role', requireRole('admin'), (req: Request, res: Response) => {
  const { keyPrefix } = req.params;
  const { role } = req.body;

  if (!ROLES.includes(role as Role)) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_ROLE', message: `role must be one of: ${ROLES.join(', ')}` },
    });
  }

  const fullKey = apiKeyManager.findKeyByPrefix(keyPrefix);
  if (!fullKey) {
    return res.status(404).json({
      success: false,
      error: { code: 'KEY_NOT_FOUND', message: 'API key not found' },
    });
  }

  const prev = apiKeyManager.getKeyMetadata(fullKey);
  const updated = apiKeyManager.updateRole(fullKey, role as Role);
  if (!updated) {
    return res.status(500).json({
      success: false,
      error: { code: 'UPDATE_FAILED', message: 'Failed to update role' },
    });
  }

  auditLog('admin.role_assigned', {
    ...reqCtx(req),
    details: { keyPrefix },
    prevState: { role: prev?.role },
    newState: { role },
  });

  res.json({ success: true, data: { keyPrefix, role } });
});

/**
 * POST /api/v1/admin/keys/:keyPrefix/rotate
 * Zero-downtime key rotation (issue #32)
 */
router.post('/keys/:keyPrefix/rotate', requireRole('admin'), (req: Request, res: Response) => {
  const { keyPrefix } = req.params;
  const gracePeriodHours = Number(req.body?.gracePeriodHours) || 24;
  const gracePeriodMs = Math.min(gracePeriodHours, 72) * 60 * 60 * 1000;

  const fullKey = apiKeyManager.findKeyByPrefix(keyPrefix);
  if (!fullKey) {
    return res.status(404).json({
      success: false,
      error: { code: 'KEY_NOT_FOUND', message: 'API key not found' },
    });
  }

  const newMeta = apiKeyManager.rotateKey(fullKey, gracePeriodMs);
  if (!newMeta) {
    return res.status(400).json({
      success: false,
      error: { code: 'ROTATION_FAILED', message: 'Key is already inactive or not found' },
    });
  }

  auditLog('key.rotation_started', {
    ...reqCtx(req),
    details: {
      oldKeyPrefix: keyPrefix,
      newKeyPrefix: newMeta.key.substring(0, 8),
      gracePeriodHours,
    },
  });

  logger.info(`Admin ${req.apiKey?.substring(0, 8)}... rotated key ${keyPrefix}`);

  res.status(201).json({
    success: true,
    data: {
      newKey: newMeta.key,
      newKeyPrefix: newMeta.key.substring(0, 8) + '...',
      role: newMeta.role,
      rateLimitPerMin: newMeta.rateLimitPerMin,
      gracePeriodHours,
      message: 'Old key remains valid during grace period. Store new key securely.',
    },
  });
});

/**
 * DELETE /api/v1/admin/keys/:keyPrefix
 * Deactivate an API key
 */
router.delete('/keys/:keyPrefix', requireRole('admin'), (req: Request, res: Response) => {
  const { keyPrefix } = req.params;
  const { permanent = false } = req.body;

  const fullKey = apiKeyManager.findKeyByPrefix(keyPrefix);
  if (!fullKey) {
    return res.status(404).json({
      success: false,
      error: { code: 'KEY_NOT_FOUND', message: 'API key not found' },
    });
  }

  if (permanent) {
    apiKeyManager.deleteKey(fullKey);
    auditLog('admin.key_deleted', { ...reqCtx(req), details: { keyPrefix } });
  } else {
    apiKeyManager.deactivateKey(fullKey);
    auditLog('admin.key_deactivated', { ...reqCtx(req), details: { keyPrefix } });
  }

  logger.info(`Admin ${req.apiKey?.substring(0, 8)}... ${permanent ? 'deleted' : 'deactivated'} API key ${keyPrefix}`);

  res.json({ success: true, data: { keyPrefix, action: permanent ? 'deleted' : 'deactivated' } });
});

/**
 * POST /api/v1/admin/keys/:keyPrefix/reactivate
 * Reactivate a deactivated key
 */
router.post('/keys/:keyPrefix/reactivate', requireRole('operator'), (req: Request, res: Response) => {
  const { keyPrefix } = req.params;

  const fullKey = apiKeyManager.findKeyByPrefix(keyPrefix);
  if (!fullKey) {
    return res.status(404).json({
      success: false,
      error: { code: 'KEY_NOT_FOUND', message: 'API key not found' },
    });
  }

  apiKeyManager.reactivateKey(fullKey);
  auditLog('admin.key_reactivated', { ...reqCtx(req), details: { keyPrefix } });
  logger.info(`Admin ${req.apiKey?.substring(0, 8)}... reactivated API key ${keyPrefix}`);

  res.json({ success: true, data: { keyPrefix, action: 'reactivated' } });
});

/**
 * GET /api/v1/admin/roles
 * List role definitions (issue #34)
 */
router.get('/roles', (req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      roles: ROLES,
      permissions: ROLE_PERMISSIONS,
      default: 'viewer',
    },
  });
});

/**
 * GET /api/v1/admin/health
 * Admin health check
 */
router.get('/health', (req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      status: 'healthy',
      adminAuthenticated: !!req.apiKey,
      role: req.userRole,
      timestamp: Math.floor(Date.now() / 1000),
    },
  });
});

export default router;
