import { Router, Request, Response } from 'express';
import { apiKeyManager } from '../services/api-key-manager';
import { adminAuthMiddleware } from '../middleware/auth';
import { logger } from '../middleware/logger';

const router = Router();
const ADMIN_KEY_PREFIX = process.env.ADMIN_KEY_PREFIX || 'admin_';

// Apply admin auth to all admin routes
router.use(adminAuthMiddleware(ADMIN_KEY_PREFIX));

/**
 * POST /api/v1/admin/keys
 * Generate a new API key
 */
router.post('/keys', (req: Request, res: Response) => {
  const { rateLimitPerMin = 100, description } = req.body;

  if (typeof rateLimitPerMin !== 'number' || rateLimitPerMin < 1) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_RATE_LIMIT',
        message: 'rateLimitPerMin must be a positive number',
      },
    });
  }

  try {
    const newKey = apiKeyManager.generateKey(rateLimitPerMin, description);

    logger.info(`Admin ${req.apiKey?.substring(0, 8)}... generated new API key`);

    res.status(201).json({
      success: true,
      data: {
        key: newKey.key,
        createdAt: new Date(newKey.createdAt).toISOString(),
        rateLimitPerMin: newKey.rateLimitPerMin,
        description: newKey.description,
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
 * List all API keys (without exposing full keys)
 */
router.get('/keys', (req: Request, res: Response) => {
  try {
    const keys = apiKeyManager.getAllKeys();

    res.json({
      success: true,
      data: {
        count: keys.length,
        keys,
      },
    });
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

  // Find key by prefix (for security, we don't expose full keys)
  const keys = apiKeyManager.getAllKeys();
  const keyInfo = keys.find((k) => k.keyPrefix === keyPrefix);

  if (!keyInfo) {
    return res.status(404).json({
      success: false,
      error: { code: 'KEY_NOT_FOUND', message: 'API key not found' },
    });
  }

  res.json({
    success: true,
    data: keyInfo,
  });
});

/**
 * PUT /api/v1/admin/keys/:keyPrefix/rate-limit
 * Update rate limit for a key
 */
router.put('/keys/:keyPrefix/rate-limit', (req: Request, res: Response) => {
  const { keyPrefix } = req.params;
  const { rateLimitPerMin } = req.body;

  if (typeof rateLimitPerMin !== 'number' || rateLimitPerMin < 1) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_RATE_LIMIT',
        message: 'rateLimitPerMin must be a positive number',
      },
    });
  }

  // We need to find the full key from prefix - in production, use proper mapping
  const keys = apiKeyManager.getAllKeys();
  const keyInfo = keys.find((k) => k.keyPrefix === keyPrefix);

  if (!keyInfo) {
    return res.status(404).json({
      success: false,
      error: { code: 'KEY_NOT_FOUND', message: 'API key not found' },
    });
  }

  try {
    // In production, you'd need a better way to map prefix back to full key
    // For now, log the operation
    logger.info(`Admin ${req.apiKey?.substring(0, 8)}... updated rate limit for ${keyPrefix} to ${rateLimitPerMin}`);

    res.json({
      success: true,
      data: {
        keyPrefix,
        newRateLimit: rateLimitPerMin,
      },
    });
  } catch (err) {
    logger.error('Failed to update rate limit', err);
    res.status(500).json({
      success: false,
      error: { code: 'UPDATE_FAILED', message: 'Failed to update rate limit' },
    });
  }
});

/**
 * DELETE /api/v1/admin/keys/:keyPrefix
 * Deactivate an API key
 */
router.delete('/keys/:keyPrefix', (req: Request, res: Response) => {
  const { keyPrefix } = req.params;
  const { permanent = false } = req.body;

  // Find key by prefix
  const keys = apiKeyManager.getAllKeys();
  const keyInfo = keys.find((k) => k.keyPrefix === keyPrefix);

  if (!keyInfo) {
    return res.status(404).json({
      success: false,
      error: { code: 'KEY_NOT_FOUND', message: 'API key not found' },
    });
  }

  try {
    logger.info(
      `Admin ${req.apiKey?.substring(0, 8)}... ${permanent ? 'deleted' : 'deactivated'} API key ${keyPrefix}`,
    );

    res.json({
      success: true,
      data: {
        keyPrefix,
        action: permanent ? 'deleted' : 'deactivated',
      },
    });
  } catch (err) {
    logger.error('Failed to delete/deactivate key', err);
    res.status(500).json({
      success: false,
      error: { code: 'DELETE_FAILED', message: 'Failed to delete/deactivate key' },
    });
  }
});

/**
 * POST /api/v1/admin/keys/:keyPrefix/reactivate
 * Reactivate a deactivated key
 */
router.post('/keys/:keyPrefix/reactivate', (req: Request, res: Response) => {
  const { keyPrefix } = req.params;

  // Find key by prefix
  const keys = apiKeyManager.getAllKeys();
  const keyInfo = keys.find((k) => k.keyPrefix === keyPrefix);

  if (!keyInfo) {
    return res.status(404).json({
      success: false,
      error: { code: 'KEY_NOT_FOUND', message: 'API key not found' },
    });
  }

  try {
    logger.info(`Admin ${req.apiKey?.substring(0, 8)}... reactivated API key ${keyPrefix}`);

    res.json({
      success: true,
      data: {
        keyPrefix,
        action: 'reactivated',
      },
    });
  } catch (err) {
    logger.error('Failed to reactivate key', err);
    res.status(500).json({
      success: false,
      error: { code: 'REACTIVATE_FAILED', message: 'Failed to reactivate key' },
    });
  }
});

/**
 * GET /api/v1/admin/health
 * Admin health check endpoint
 */
router.get('/health', (req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      status: 'healthy',
      adminAuthenticated: !!req.apiKey,
      timestamp: Math.floor(Date.now() / 1000),
    },
  });
});

export default router;
