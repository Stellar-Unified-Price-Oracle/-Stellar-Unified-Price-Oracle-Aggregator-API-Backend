import { Router, Request, Response } from 'express';
import { apiKeyManager, TIER_RATE_LIMITS, KeyTier, KeyRole } from '../services/api-key-manager';
import { corsManager } from '../services/cors-manager';
import { adminAuthMiddleware } from '../middleware/auth';
import { requireRole, ROLES, ROLE_PERMISSIONS } from '../middleware/rbac';
import { logger } from '../middleware/logger';
import { auditLog } from '../services/audit-logger';
import type { Role } from '../middleware/rbac';

const router = Router();
const ADMIN_KEY_PREFIX = process.env.ADMIN_KEY_PREFIX || 'admin_';

router.use(adminAuthMiddleware(ADMIN_KEY_PREFIX));

// ── API Key Management ────────────────────────────────────────────────────────

router.post('/keys', (req: Request, res: Response) => {
  const { rateLimitPerMin, description, tier = 'free', role = 'read-only' } = req.body;

  const validTiers: KeyTier[] = ['free', 'pro', 'enterprise', 'admin'];
  const validRoles: KeyRole[] = ['read-only', 'admin'];

  if (tier && !validTiers.includes(tier)) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_TIER', message: `tier must be one of: ${validTiers.join(', ')}` },
    });
  }

  if (role && !validRoles.includes(role)) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_ROLE', message: `role must be one of: ${validRoles.join(', ')}` },
    });
  }

  const limit = typeof rateLimitPerMin === 'number' && rateLimitPerMin >= 1
    ? rateLimitPerMin
    : TIER_RATE_LIMITS[tier as KeyTier];

  try {
    const newKey = apiKeyManager.generateKey(limit, description, tier as KeyTier, role as KeyRole);
    logger.info(`Admin ${req.apiKey?.substring(0, 8)}... generated API key tier=${tier} role=${role}`);

    res.status(201).json({
      success: true,
      data: {
        key: newKey.key,
        keyHash: newKey.keyHash,
        tier: newKey.tier,
        role: newKey.role,
        rateLimitPerMin: newKey.rateLimitPerMin,
        description: newKey.description,
        createdAt: new Date(newKey.createdAt).toISOString(),
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

router.get('/keys', (_req: Request, res: Response) => {
  const keys = apiKeyManager.getAllKeys();
  res.json({ success: true, data: { count: keys.length, keys } });
});

router.get('/keys/:keyHash', (req: Request, res: Response) => {
  const keyInfo = apiKeyManager.findByHash(req.params.keyHash);
  if (!keyInfo) {
    return res.status(404).json({
      success: false,
      error: { code: 'KEY_NOT_FOUND', message: 'API key not found' },
    });
  }
  const { key: _key, ...safeInfo } = keyInfo;
  res.json({ success: true, data: safeInfo });
});

router.post('/keys/:keyHash/rotate', (req: Request, res: Response) => {
  const existing = apiKeyManager.findByHash(req.params.keyHash);
  if (!existing) {
    return res.status(404).json({
      success: false,
      error: { code: 'KEY_NOT_FOUND', message: 'API key not found' },
    });
  }

  const rotated = apiKeyManager.rotateKey(existing.key);
  if (!rotated) {
    return res.status(500).json({
      success: false,
      error: { code: 'ROTATE_FAILED', message: 'Failed to rotate API key' },
    });
  }

  logger.info(`Admin ${req.apiKey?.substring(0, 8)}... rotated key ${req.params.keyHash}`);
  res.json({
    success: true,
    data: {
      key: rotated.key,
      keyHash: rotated.keyHash,
      tier: rotated.tier,
      role: rotated.role,
      rateLimitPerMin: rotated.rateLimitPerMin,
      message: 'Old key is now invalid. Store new key securely.',
    },
  });
});

router.put('/keys/:keyHash/tier', (req: Request, res: Response) => {
  const { tier } = req.body;
  const validTiers: KeyTier[] = ['free', 'pro', 'enterprise', 'admin'];

  if (!validTiers.includes(tier)) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_TIER', message: `tier must be one of: ${validTiers.join(', ')}` },
    });
  }

  const existing = apiKeyManager.findByHash(req.params.keyHash);
  if (!existing) {
    return res.status(404).json({
      success: false,
      error: { code: 'KEY_NOT_FOUND', message: 'API key not found' },
    });
  }

  apiKeyManager.updateTier(existing.key, tier as KeyTier);
  res.json({
    success: true,
    data: { keyHash: req.params.keyHash, tier, rateLimitPerMin: TIER_RATE_LIMITS[tier as KeyTier] },
  });
});

router.put('/keys/:keyHash/rate-limit', (req: Request, res: Response) => {
  const { rateLimitPerMin } = req.body;

  if (typeof rateLimitPerMin !== 'number' || rateLimitPerMin < 1) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_RATE_LIMIT', message: 'rateLimitPerMin must be a positive number' },
    });
  }

  const existing = apiKeyManager.findByHash(req.params.keyHash);
  if (!existing) {
    return res.status(404).json({
      success: false,
      error: { code: 'KEY_NOT_FOUND', message: 'API key not found' },
    });
  }

  apiKeyManager.updateRateLimit(existing.key, rateLimitPerMin);
  res.json({ success: true, data: { keyHash: req.params.keyHash, rateLimitPerMin } });
});

router.post('/keys/:keyHash/revoke', (req: Request, res: Response) => {
  const existing = apiKeyManager.findByHash(req.params.keyHash);
  if (!existing) {
    return res.status(404).json({
      success: false,
      error: { code: 'KEY_NOT_FOUND', message: 'API key not found' },
    });
  }

  apiKeyManager.revokeKey(existing.key);
  logger.info(`Admin ${req.apiKey?.substring(0, 8)}... revoked key ${req.params.keyHash}`);
  res.json({ success: true, data: { keyHash: req.params.keyHash, action: 'revoked' } });
});

router.post('/keys/:keyHash/reactivate', (req: Request, res: Response) => {
  const existing = apiKeyManager.findByHash(req.params.keyHash);
  if (!existing) {
    return res.status(404).json({
      success: false,
      error: { code: 'KEY_NOT_FOUND', message: 'API key not found' },
    });
  }

  apiKeyManager.reactivateKey(existing.key);
  logger.info(`Admin ${req.apiKey?.substring(0, 8)}... reactivated key ${req.params.keyHash}`);
  res.json({ success: true, data: { keyHash: req.params.keyHash, action: 'reactivated' } });
});

router.delete('/keys/:keyHash', (req: Request, res: Response) => {
  const existing = apiKeyManager.findByHash(req.params.keyHash);
  if (!existing) {
    return res.status(404).json({
      success: false,
      error: { code: 'KEY_NOT_FOUND', message: 'API key not found' },
    });
  }

  apiKeyManager.deleteKey(existing.key);
  logger.info(`Admin ${req.apiKey?.substring(0, 8)}... deleted key ${req.params.keyHash}`);
  res.json({ success: true, data: { keyHash: req.params.keyHash, action: 'deleted' } });
});

// ── CORS Management ───────────────────────────────────────────────────────────

router.get('/cors/origins', (_req: Request, res: Response) => {
  res.json({ success: true, data: { origins: corsManager.listOrigins() } });
});

router.post('/cors/origins', (req: Request, res: Response) => {
  const { origin } = req.body;

  if (!origin || typeof origin !== 'string') {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_ORIGIN', message: "'origin' must be a non-empty string (e.g. https://example.com or *.example.com)" },
    });
  }

  const added = corsManager.addOrigin(origin);
  const status = added ? 201 : 200;
  res.status(status).json({
    success: true,
    data: { origin, added, origins: corsManager.listOrigins() },
  });
});

router.delete('/cors/origins', (req: Request, res: Response) => {
  const { origin } = req.body;

  if (!origin || typeof origin !== 'string') {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_ORIGIN', message: "'origin' must be a non-empty string" },
    });
  }

  const removed = corsManager.removeOrigin(origin);
  if (!removed) {
    return res.status(404).json({
      success: false,
      error: { code: 'ORIGIN_NOT_FOUND', message: `Origin '${origin}' not found in whitelist` },
    });
  }

  res.json({ success: true, data: { origin, removed: true, origins: corsManager.listOrigins() } });
});

// ── Admin Health ──────────────────────────────────────────────────────────────

router.get('/health', (req: Request, res: Response) => {
  const tierLimits = TIER_RATE_LIMITS;
  res.json({
    success: true,
    data: {
      status: 'healthy',
      adminAuthenticated: !!req.apiKey,
      role: req.userRole,
      timestamp: Math.floor(Date.now() / 1000),
      tiers: tierLimits,
      corsOriginsCount: corsManager.listOrigins().length,
    },
  });
});

export default router;
