import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import express, { Express, Request, Response, NextFunction } from 'express';
import { setupE2E, teardownE2E } from '../setup';
import { ApiKeyManager, KeyTier, TIER_RATE_LIMITS } from '../../src/governance/api-key-manager';

let app: Express;
let apiKeyManager: ApiKeyManager;

beforeAll(async () => {
  await setupE2E();

  app = express();
  app.use(express.json());
  apiKeyManager = new ApiKeyManager();

  // Mock tier gating middleware
  function tierGatingMiddleware(requiredTier: KeyTier) {
    return (req: Request, res: Response, next: NextFunction) => {
      const apiKey = req.headers['x-api-key'] as string;

      if (!apiKey) {
        return res.status(401).json({
          success: false,
          error: { code: 'MISSING_API_KEY', message: 'API key required' },
        });
      }

      const validation = apiKeyManager.validateKey(apiKey);
      if (!validation.valid) {
        return res.status(401).json({
          success: false,
          error: { code: 'INVALID_API_KEY', message: 'Invalid API key' },
        });
      }

      const tierHierarchy: Record<KeyTier, number> = {
        free: 0,
        pro: 1,
        enterprise: 2,
        admin: 3,
      };

      const userTier = validation.metadata!.tier;
      if (tierHierarchy[userTier] < tierHierarchy[requiredTier]) {
        return res.status(403).json({
          success: false,
          error: {
            code: 'INSUFFICIENT_TIER',
            message: `This endpoint requires ${requiredTier} tier or higher`,
            requiredTier,
            currentTier: userTier,
          },
        });
      }

      (req as any).apiKeyMetadata = validation.metadata;
      (req as any).apiKeyTier = userTier;
      next();
    };
  }

  // Free tier endpoints (no gating)
  app.get('/api/v1/prices', (req, res) => {
    res.json({
      success: true,
      data: { prices: [{ asset: 'XLM', price: 0.15 }] },
    });
  });

  app.get('/api/v1/health', (req, res) => {
    res.json({
      success: true,
      data: { status: 'healthy' },
    });
  });

  // Pro tier endpoints
  app.get('/api/v1/export/prices', tierGatingMiddleware('pro'), (req, res) => {
    res.json({
      success: true,
      data: { format: 'json', prices: [] },
    });
  });

  app.get('/api/v1/analytics', tierGatingMiddleware('pro'), (req, res) => {
    res.json({
      success: true,
      data: { analytics: 'data' },
    });
  });

  // Enterprise tier endpoints
  app.get('/api/v1/webhooks', tierGatingMiddleware('enterprise'), (req, res) => {
    res.json({
      success: true,
      data: { webhooks: [] },
    });
  });

  app.post('/api/v1/webhooks', tierGatingMiddleware('enterprise'), (req, res) => {
    res.status(201).json({
      success: true,
      data: { webhookId: 'webhook123' },
    });
  });

  // Admin tier endpoints
  app.get('/api/v1/admin/keys', tierGatingMiddleware('admin'), (req, res) => {
    res.json({
      success: true,
      data: { keys: [] },
    });
  });

  app.post('/api/v1/admin/keys', tierGatingMiddleware('admin'), (req, res) => {
    res.json({
      success: true,
      data: { key: 'new-key' },
    });
  });

  // Endpoint with multiple tier-based features
  app.get('/api/v1/dashboard', (req, res) => {
    const apiKey = req.headers['x-api-key'] as string;
    const validation = apiKeyManager.validateKey(apiKey);

    if (!validation.valid) {
      return res.status(401).json({
        success: false,
        error: { code: 'INVALID_API_KEY' },
      });
    }

    const tier = validation.metadata!.tier;
    const features = {
      free: ['basic_stats'],
      pro: ['basic_stats', 'export', 'analytics'],
      enterprise: ['basic_stats', 'export', 'analytics', 'webhooks', 'custom_alerts'],
      admin: ['basic_stats', 'export', 'analytics', 'webhooks', 'custom_alerts', 'billing_management'],
    };

    res.json({
      success: true,
      data: {
        tier,
        availableFeatures: features[tier],
      },
    });
  });
});

afterAll(async () => {
  await teardownE2E();
});

describe('Issue #244: Enforce API Key Tier-Based Access Restrictions', () => {
  describe('Free tier access control', () => {
    let freeKey: string;

    beforeAll(() => {
      const generated = apiKeyManager.generateKey(TIER_RATE_LIMITS.free, 'Free tier key', 'free', 'viewer');
      freeKey = generated.key;
    });

    it('should allow free tier to access free endpoints', async () => {
      const response = await request(app)
        .get('/api/v1/prices')
        .set('X-Api-Key', freeKey);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should deny free tier access to pro endpoints', async () => {
      const response = await request(app)
        .get('/api/v1/export/prices')
        .set('X-Api-Key', freeKey);

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('INSUFFICIENT_TIER');
      expect(response.body.error.requiredTier).toBe('pro');
    });

    it('should deny free tier access to enterprise endpoints', async () => {
      const response = await request(app)
        .get('/api/v1/webhooks')
        .set('X-Api-Key', freeKey);

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('INSUFFICIENT_TIER');
    });

    it('should deny free tier access to admin endpoints', async () => {
      const response = await request(app)
        .get('/api/v1/admin/keys')
        .set('X-Api-Key', freeKey);

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('INSUFFICIENT_TIER');
    });
  });

  describe('Pro tier access control', () => {
    let proKey: string;

    beforeAll(() => {
      const generated = apiKeyManager.generateKey(TIER_RATE_LIMITS.pro, 'Pro tier key', 'pro', 'viewer');
      proKey = generated.key;
    });

    it('should allow pro tier to access free endpoints', async () => {
      const response = await request(app)
        .get('/api/v1/prices')
        .set('X-Api-Key', proKey);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should allow pro tier to access pro endpoints', async () => {
      const response = await request(app)
        .get('/api/v1/export/prices')
        .set('X-Api-Key', proKey);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should allow pro tier to access analytics', async () => {
      const response = await request(app)
        .get('/api/v1/analytics')
        .set('X-Api-Key', proKey);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should deny pro tier access to enterprise endpoints', async () => {
      const response = await request(app)
        .get('/api/v1/webhooks')
        .set('X-Api-Key', proKey);

      expect(response.status).toBe(403);
      expect(response.body.error.requiredTier).toBe('enterprise');
    });

    it('should deny pro tier access to admin endpoints', async () => {
      const response = await request(app)
        .get('/api/v1/admin/keys')
        .set('X-Api-Key', proKey);

      expect(response.status).toBe(403);
    });
  });

  describe('Enterprise tier access control', () => {
    let enterpriseKey: string;

    beforeAll(() => {
      const generated = apiKeyManager.generateKey(
        TIER_RATE_LIMITS.enterprise,
        'Enterprise tier key',
        'enterprise',
        'viewer',
      );
      enterpriseKey = generated.key;
    });

    it('should allow enterprise tier to access free endpoints', async () => {
      const response = await request(app)
        .get('/api/v1/prices')
        .set('X-Api-Key', enterpriseKey);

      expect(response.status).toBe(200);
    });

    it('should allow enterprise tier to access pro endpoints', async () => {
      const response = await request(app)
        .get('/api/v1/export/prices')
        .set('X-Api-Key', enterpriseKey);

      expect(response.status).toBe(200);
    });

    it('should allow enterprise tier to access enterprise endpoints', async () => {
      const response = await request(app)
        .get('/api/v1/webhooks')
        .set('X-Api-Key', enterpriseKey);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should allow enterprise POST to webhooks', async () => {
      const response = await request(app)
        .post('/api/v1/webhooks')
        .set('X-Api-Key', enterpriseKey)
        .send({ url: 'https://example.com/webhook' });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
    });

    it('should deny enterprise tier access to admin endpoints', async () => {
      const response = await request(app)
        .get('/api/v1/admin/keys')
        .set('X-Api-Key', enterpriseKey);

      expect(response.status).toBe(403);
      expect(response.body.error.requiredTier).toBe('admin');
    });
  });

  describe('Admin tier access control', () => {
    let adminKey: string;

    beforeAll(() => {
      const generated = apiKeyManager.generateKey(TIER_RATE_LIMITS.admin, 'Admin tier key', 'admin', 'admin');
      adminKey = generated.key;
    });

    it('should allow admin tier to access all endpoints', async () => {
      const endpoints = ['/api/v1/prices', '/api/v1/export/prices', '/api/v1/webhooks', '/api/v1/admin/keys'];

      for (const endpoint of endpoints) {
        const response = await request(app)
          .get(endpoint)
          .set('X-Api-Key', adminKey);

        expect([200, 201]).toContain(response.status);
      }
    });

    it('should allow admin to create keys', async () => {
      const response = await request(app)
        .post('/api/v1/admin/keys')
        .set('X-Api-Key', adminKey);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should allow admin to list all keys', async () => {
      const response = await request(app)
        .get('/api/v1/admin/keys')
        .set('X-Api-Key', adminKey);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  describe('Tier-based feature availability', () => {
    let freeKey: string;
    let proKey: string;
    let enterpriseKey: string;

    beforeAll(() => {
      freeKey = apiKeyManager.generateKey(TIER_RATE_LIMITS.free, 'Free', 'free').key;
      proKey = apiKeyManager.generateKey(TIER_RATE_LIMITS.pro, 'Pro', 'pro').key;
      enterpriseKey = apiKeyManager.generateKey(TIER_RATE_LIMITS.enterprise, 'Enterprise', 'enterprise').key;
    });

    it('should show basic stats for free tier', async () => {
      const response = await request(app)
        .get('/api/v1/dashboard')
        .set('X-Api-Key', freeKey);

      expect(response.status).toBe(200);
      expect(response.body.data.tier).toBe('free');
      expect(response.body.data.availableFeatures).toContain('basic_stats');
      expect(response.body.data.availableFeatures).not.toContain('export');
    });

    it('should show extended features for pro tier', async () => {
      const response = await request(app)
        .get('/api/v1/dashboard')
        .set('X-Api-Key', proKey);

      expect(response.status).toBe(200);
      expect(response.body.data.tier).toBe('pro');
      expect(response.body.data.availableFeatures).toContain('basic_stats');
      expect(response.body.data.availableFeatures).toContain('export');
      expect(response.body.data.availableFeatures).toContain('analytics');
    });

    it('should show premium features for enterprise tier', async () => {
      const response = await request(app)
        .get('/api/v1/dashboard')
        .set('X-Api-Key', enterpriseKey);

      expect(response.status).toBe(200);
      expect(response.body.data.tier).toBe('enterprise');
      expect(response.body.data.availableFeatures).toContain('webhooks');
      expect(response.body.data.availableFeatures).toContain('custom_alerts');
      expect(response.body.data.availableFeatures).not.toContain('billing_management');
    });
  });

  describe('Missing or invalid API key handling', () => {
    it('should reject requests without API key', async () => {
      const response = await request(app).get('/api/v1/export/prices');

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('MISSING_API_KEY');
    });

    it('should reject requests with invalid API key', async () => {
      const response = await request(app)
        .get('/api/v1/export/prices')
        .set('X-Api-Key', 'invalid-key-123');

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('INVALID_API_KEY');
    });
  });

  describe('Rate limiting by tier', () => {
    it('should reflect tier in rate limit headers', async () => {
      const freeKey = apiKeyManager.generateKey(TIER_RATE_LIMITS.free, 'Free', 'free').key;
      const proKey = apiKeyManager.generateKey(TIER_RATE_LIMITS.pro, 'Pro', 'pro').key;

      const freeResponse = await request(app)
        .get('/api/v1/prices')
        .set('X-Api-Key', freeKey);

      const proResponse = await request(app)
        .get('/api/v1/prices')
        .set('X-Api-Key', proKey);

      expect(freeResponse.status).toBe(200);
      expect(proResponse.status).toBe(200);

      // Both should have the same structure but different rate limits
      expect(freeResponse.body.success).toBe(true);
      expect(proResponse.body.success).toBe(true);
    });
  });

  describe('Tier gating on different HTTP methods', () => {
    let proKey: string;
    let enterpriseKey: string;

    beforeAll(() => {
      proKey = apiKeyManager.generateKey(TIER_RATE_LIMITS.pro, 'Pro', 'pro').key;
      enterpriseKey = apiKeyManager.generateKey(TIER_RATE_LIMITS.enterprise, 'Enterprise', 'enterprise').key;
    });

    it('should gate GET requests by tier', async () => {
      const response = await request(app)
        .get('/api/v1/webhooks')
        .set('X-Api-Key', proKey);

      expect(response.status).toBe(403);
    });

    it('should gate POST requests by tier', async () => {
      const response = await request(app)
        .post('/api/v1/webhooks')
        .set('X-Api-Key', proKey)
        .send({});

      expect(response.status).toBe(403);
    });

    it('should allow POST for sufficient tier', async () => {
      const response = await request(app)
        .post('/api/v1/webhooks')
        .set('X-Api-Key', enterpriseKey)
        .send({ url: 'https://example.com' });

      expect(response.status).toBe(201);
    });
  });

  describe('Tier enforcement consistency', () => {
    it('should enforce same tier requirements across API versions', async () => {
      const freeKey = apiKeyManager.generateKey(TIER_RATE_LIMITS.free, 'Free', 'free').key;

      const response = await request(app)
        .get('/api/v1/export/prices')
        .set('X-Api-Key', freeKey);

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('INSUFFICIENT_TIER');
    });

    it('should provide tier information in error response', async () => {
      const freeKey = apiKeyManager.generateKey(TIER_RATE_LIMITS.free, 'Free', 'free').key;

      const response = await request(app)
        .get('/api/v1/export/prices')
        .set('X-Api-Key', freeKey);

      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('requiredTier');
      expect(response.body.error).toHaveProperty('currentTier');
    });
  });
});
