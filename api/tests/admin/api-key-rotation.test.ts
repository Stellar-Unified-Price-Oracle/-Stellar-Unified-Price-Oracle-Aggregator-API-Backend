import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import adminRouter from '../../src/governance/admin';
import { apiKeyManager } from '../../src/governance/api-key-manager';

let app: Express;
let testAdminKey: string;
let testKeyHash: string;

beforeAll(() => {
  app = express();
  app.use(express.json());

  app.use('/admin', adminRouter);

  testAdminKey = process.env.ADMIN_API_KEY || 'sk_admin_test_' + Math.random().toString(36).slice(2);
  const generated = apiKeyManager.generateKey(100, 'Test admin key', 'admin', 'admin');
  testKeyHash = generated.keyHash;
  testAdminKey = generated.key;
});

afterAll(() => {
  apiKeyManager.deleteKey(testKeyHash);
});

describe('Issue #234: API Key Rotation Endpoint', () => {
  describe('POST /admin/keys/:keyHash/rotate', () => {
    it('should rotate an API key successfully', async () => {
      const testKey = apiKeyManager.generateKey(60, 'Key to rotate', 'pro', 'viewer');
      const response = await request(app)
        .post(`/admin/keys/${testKey.keyHash}/rotate`)
        .set('Authorization', `Bearer ${testAdminKey}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('key');
      expect(response.body.data).toHaveProperty('keyHash');
      expect(response.body.data.key).not.toBe(testKey.key);
      expect(response.body.data.keyHash).not.toBe(testKey.keyHash);
      expect(response.body.data.tier).toBe(testKey.tier);
      expect(response.body.data.role).toBe(testKey.role);
      expect(response.body.data.rateLimitPerMin).toBe(testKey.rateLimitPerMin);
      expect(response.body.data).toHaveProperty('message');
    });

    it('should return 404 when rotating non-existent key', async () => {
      const response = await request(app)
        .post('/admin/keys/nonexistent/rotate')
        .set('Authorization', `Bearer ${testAdminKey}`);

      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('KEY_NOT_FOUND');
    });

    it('should invalidate old key after rotation', async () => {
      const testKey = apiKeyManager.generateKey(60, 'Key for invalidation test', 'pro', 'viewer');
      const oldKeyHash = testKey.keyHash;
      const oldKey = testKey.key;

      const rotateResponse = await request(app)
        .post(`/admin/keys/${oldKeyHash}/rotate`)
        .set('Authorization', `Bearer ${testAdminKey}`);

      expect(rotateResponse.status).toBe(200);

      const validation = apiKeyManager.validateKey(oldKey);
      expect(validation.valid).toBe(false);
      expect(validation.error).toBe('Invalid API key');
    });

    it('should preserve key tier during rotation', async () => {
      const testKey = apiKeyManager.generateKey(500, 'Enterprise key', 'enterprise', 'operator');
      const response = await request(app)
        .post(`/admin/keys/${testKey.keyHash}/rotate`)
        .set('Authorization', `Bearer ${testAdminKey}`);

      expect(response.status).toBe(200);
      expect(response.body.data.tier).toBe('enterprise');
      expect(response.body.data.role).toBe('operator');
    });

    it('should reset request count and last used timestamp after rotation', async () => {
      const testKey = apiKeyManager.generateKey(60, 'Key for stats test', 'free', 'viewer');
      const metadata = apiKeyManager.findByHash(testKey.keyHash);

      expect(metadata?.requestCount).toBe(0);
      expect(metadata?.lastUsed).toBeNull();

      const response = await request(app)
        .post(`/admin/keys/${testKey.keyHash}/rotate`)
        .set('Authorization', `Bearer ${testAdminKey}`);

      expect(response.status).toBe(200);
      const newKeyHash = response.body.data.keyHash;
      const newMetadata = apiKeyManager.findByHash(newKeyHash);

      expect(newMetadata?.requestCount).toBe(0);
      expect(newMetadata?.lastUsed).toBeNull();
    });
  });

  describe('POST /admin/keys/:keyHash/rotate - Error Cases', () => {
    it('should handle rotation of already rotated key correctly', async () => {
      const testKey = apiKeyManager.generateKey(60, 'Double rotation test', 'free', 'viewer');
      const firstRotate = await request(app)
        .post(`/admin/keys/${testKey.keyHash}/rotate`)
        .set('Authorization', `Bearer ${testAdminKey}`);

      expect(firstRotate.status).toBe(200);
      const firstNewHash = firstRotate.body.data.keyHash;

      const secondRotate = await request(app)
        .post(`/admin/keys/${firstNewHash}/rotate`)
        .set('Authorization', `Bearer ${testAdminKey}`);

      expect(secondRotate.status).toBe(200);
      expect(secondRotate.body.data.keyHash).not.toBe(firstNewHash);
    });
  });
});
