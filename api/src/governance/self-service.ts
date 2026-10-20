import { Router, type Request, type Response } from 'express';
import { apiKeyManager, TIER_RATE_LIMITS, type KeyTier, type GeneratedApiKey } from './api-key-manager';
import { keyMutation } from './key-mutation';
import { authMiddleware } from './auth';
import {
  CREDENTIAL_SCOPE_VOCABULARY,
  validateCredentialPolicy,
  type CredentialPolicy,
} from './credential-policy';

const router = Router();

/**
 * Supported policy-scope vocabulary for self-service consumer credentials.
 *
 * A policy restricts a credential along four independent dimensions:
 * - feeds:        data feeds the credential may read (e.g. "feeds:read").
 * - operations:   operations the credential may invoke (e.g. "operations:read").
 * - environments: deployment environments the credential is valid in
 *                 (e.g. "environments:production").
 * - expiresAt:    ISO-8601 timestamp after which the credential is rejected.
 *
 * Requests may supply a `policy` object with any subset of these fields.
 * Unknown values, empty lists, and non-future expiry timestamps are rejected
 * with a 400 INVALID_CREDENTIAL_POLICY response.
 */
router.get('/keys/policy-vocabulary', (_req: Request, res: Response) => {
  return res.json({ success: true, data: CREDENTIAL_SCOPE_VOCABULARY });
});

router.use(authMiddleware);

router.get('/keys', (req: Request, res: Response) => {
  const currentKeyHash = apiKeyManager.hashKey(req.apiKey!);
  const key = apiKeyManager.getKeyMetadata(currentKeyHash);

  if (!key) {
    return res.status(404).json({ success: false, error: { code: 'KEY_NOT_FOUND', message: 'API key not found' } });
  }

  return res.json({ success: true, data: { ...key, keyPrefix: key.keyPrefix } });
});

router.post('/keys', keyMutation(async (req: Request, res: Response) => {
  const { description, tier = 'free', role = 'viewer', scopes, rateLimitPerMin, policy } = req.body ?? {};
  const resolvedTier = (tier ?? 'free') as KeyTier;
  const limit = typeof rateLimitPerMin === 'number' && rateLimitPerMin > 0
    ? rateLimitPerMin
    : TIER_RATE_LIMITS[resolvedTier];

  const validation = validateCredentialPolicy(policy);
  if (!validation.valid) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_CREDENTIAL_POLICY',
        message: validation.message,
        details: validation.details,
      },
    });
  }

  const resolvedPolicy: CredentialPolicy | undefined = validation.policy;
  const combinedScopes = resolvedPolicy
    ? Array.from(new Set([...(Array.isArray(scopes) ? scopes : []), ...resolvedPolicy.toScopeStrings()]))
    : (Array.isArray(scopes) ? scopes : undefined);

  const key = await apiKeyManager.transact(() =>
    apiKeyManager.generateKey(limit, description, resolvedTier, role, combinedScopes, resolvedPolicy),
  );

  return res.status(201).json({
    success: true,
    data: {
      key: key.key,
      keyHash: key.keyHash,
      keyPrefix: key.keyPrefix,
      tier: key.tier,
      role: key.role,
      scopes: key.scopes,
      policy: key.policy ?? null,
      rateLimitPerMin: key.rateLimitPerMin,
      description: key.description,
      createdAt: new Date(key.createdAt).toISOString(),
    },
  });
}));

router.post('/keys/rotate', keyMutation(async (req: Request, res: Response) => {
  const currentKeyHash = apiKeyManager.hashKey(req.apiKey!);
  const current = apiKeyManager.findByHash(currentKeyHash);

  if (!current) {
    return res.status(404).json({ success: false, error: { code: 'KEY_NOT_FOUND', message: 'API key not found' } });
  }

  const rotated: GeneratedApiKey | null = await apiKeyManager.transact(() => apiKeyManager.rotateKey(currentKeyHash));
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
      policy: rotated.policy ?? null,
      rateLimitPerMin: rotated.rateLimitPerMin,
    },
  });
}));

router.post('/keys/revoke', keyMutation(async (req: Request, res: Response) => {
  const currentKeyHash = apiKeyManager.hashKey(req.apiKey!);
  const current = apiKeyManager.findByHash(currentKeyHash);

  if (!current) {
    return res.status(404).json({ success: false, error: { code: 'KEY_NOT_FOUND', message: 'API key not found' } });
  }

  await apiKeyManager.transact(() => apiKeyManager.revokeKey(currentKeyHash));
  return res.json({ success: true, data: { keyHash: currentKeyHash, action: 'revoked' } });
}));

export default router;
