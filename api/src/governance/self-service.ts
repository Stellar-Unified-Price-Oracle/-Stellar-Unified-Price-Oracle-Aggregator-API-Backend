import { Router, type Request, type Response } from 'express';
import { apiKeyManager, TIER_RATE_LIMITS, type KeyTier } from './api-key-manager';
import { authMiddleware } from './auth';

const router = Router();

router.use(authMiddleware);

router.get('/keys', (req: Request, res: Response) => {
  const currentKeyHash = apiKeyManager.hashKey(req.apiKey!);
  const key = apiKeyManager.getKeyMetadata(currentKeyHash);

  if (!key) {
    return res.status(404).json({ success: false, error: { code: 'KEY_NOT_FOUND', message: 'API key not found' } });
  }

  return res.json({ success: true, data: { ...key, keyPrefix: key.keyPrefix } });
});

router.post('/keys', (req: Request, res: Response) => {
  const { description, tier = 'free', role = 'viewer', scopes, rateLimitPerMin } = req.body ?? {};
  const resolvedTier = (tier ?? 'free') as KeyTier;
  const limit = typeof rateLimitPerMin === 'number' && rateLimitPerMin > 0
    ? rateLimitPerMin
    : TIER_RATE_LIMITS[resolvedTier];

  const key = apiKeyManager.generateKey(limit, description, resolvedTier, role, Array.isArray(scopes) ? scopes : undefined);

  return res.status(201).json({
    success: true,
    data: {
      key: key.key,
      keyHash: key.keyHash,
      keyPrefix: key.keyPrefix,
      tier: key.tier,
      role: key.role,
      scopes: key.scopes,
      rateLimitPerMin: key.rateLimitPerMin,
      description: key.description,
      createdAt: new Date(key.createdAt).toISOString(),
    },
  });
});

router.post('/keys/rotate', (req: Request, res: Response) => {
  const currentKeyHash = apiKeyManager.hashKey(req.apiKey!);
  const current = apiKeyManager.findByHash(currentKeyHash);

  if (!current) {
    return res.status(404).json({ success: false, error: { code: 'KEY_NOT_FOUND', message: 'API key not found' } });
  }

  const rotated = apiKeyManager.rotateKey(currentKeyHash);
  if (!rotated) {
    return res.status(500).json({ success: false, error: { code: 'ROTATE_FAILED', message: 'Failed to rotate API key' } });
  }

  return res.json({
    success: true,
    data: {
      key: rotated.key,
      keyHash: rotated.keyHash,
      keyPrefix: rotated.keyPrefix,
      tier: rotated.tier,
      role: rotated.role,
      scopes: rotated.scopes,
      rateLimitPerMin: rotated.rateLimitPerMin,
    },
  });
});

router.post('/keys/revoke', (req: Request, res: Response) => {
  const currentKeyHash = apiKeyManager.hashKey(req.apiKey!);
  const current = apiKeyManager.findByHash(currentKeyHash);

  if (!current) {
    return res.status(404).json({ success: false, error: { code: 'KEY_NOT_FOUND', message: 'API key not found' } });
  }

  apiKeyManager.revokeKey(currentKeyHash);
  return res.json({ success: true, data: { keyHash: currentKeyHash, action: 'revoked' } });
});

export default router;
