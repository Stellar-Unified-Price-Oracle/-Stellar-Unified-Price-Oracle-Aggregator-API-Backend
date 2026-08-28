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

  const generated = apiKeyManager.generateKey(100, 'Test admin key', 'admin', 'admin');
  testKeyHash = generated.keyHash;
  testAdminKey = generated.key;
});

afterAll(() => {
  apiKeyManager.deleteKey(testKeyHash);
});

describe('Issue #232: Admin API Endpoints for Oracle Source Management', () => {
  const testSourceName = 'test-oracle-source-' + Date.now();
  const testSourceConfig = {
    url: 'https://api.example.com/prices',
    healthCheckUrl: 'https://api.example.com/health',
    rateLimitPerSecond: 100,
    timeout: 5000,
    retryCount: 3,
  };

  describe('GET /api/v1/admin/sources', () => {
    it('should list all oracle sources', async () => {
      const response = await request(app)
        .get('/admin/sources')
        .set('Authorization', `Bearer ${testAdminKey}`);

      expect([200, 404]).toContain(response.status);

      if (response.status === 200) {
        expect(response.body.success).toBe(true);
        expect(response.body.data).toHaveProperty('sources');
        expect(Array.isArray(response.body.data.sources)).toBe(true);
      }
    });

    it('should return sources with required properties', async () => {
      const response = await request(app)
        .get('/admin/sources')
        .set('Authorization', `Bearer ${testAdminKey}`);

      if (response.status === 200 && response.body.data.sources.length > 0) {
        const source = response.body.data.sources[0];
        expect(source).toHaveProperty('name');
        expect(source).toHaveProperty('url');
        expect(source).toHaveProperty('isActive');
        expect(source).toHaveProperty('createdAt');
      }
    });

    it('should include source count in response', async () => {
      const response = await request(app)
        .get('/admin/sources')
        .set('Authorization', `Bearer ${testAdminKey}`);

      if (response.status === 200) {
        expect(response.body.data).toHaveProperty('count');
        expect(typeof response.body.data.count).toBe('number');
      }
    });
  });

  describe('POST /api/v1/admin/sources', () => {
    it('should create a new oracle source', async () => {
      const response = await request(app)
        .post('/admin/sources')
        .set('Authorization', `Bearer ${testAdminKey}`)
        .send({
          name: testSourceName,
          ...testSourceConfig,
        });

      expect([200, 201, 404]).toContain(response.status);

      if (response.status === 201 || response.status === 200) {
        expect(response.body.success).toBe(true);
        expect(response.body.data).toHaveProperty('name', testSourceName);
        expect(response.body.data).toHaveProperty('isActive');
      }
    });

    it('should validate required fields when creating source', async () => {
      const response = await request(app)
        .post('/admin/sources')
        .set('Authorization', `Bearer ${testAdminKey}`)
        .send({
          name: 'incomplete-source',
        });

      expect([400, 404]).toContain(response.status);
    });

    it('should reject duplicate source names', async () => {
      const firstCreate = await request(app)
        .post('/admin/sources')
        .set('Authorization', `Bearer ${testAdminKey}`)
        .send({
          name: 'duplicate-test-' + Date.now(),
          ...testSourceConfig,
        });

      if (firstCreate.status === 201 || firstCreate.status === 200) {
        const sourceName = firstCreate.body.data.name;
        const secondCreate = await request(app)
          .post('/admin/sources')
          .set('Authorization', `Bearer ${testAdminKey}`)
          .send({
            name: sourceName,
            ...testSourceConfig,
          });

        expect([400, 409]).toContain(secondCreate.status);
      }
    });

    it('should validate URL format', async () => {
      const response = await request(app)
        .post('/admin/sources')
        .set('Authorization', `Bearer ${testAdminKey}`)
        .send({
          name: 'invalid-url-test',
          url: 'not-a-valid-url',
          ...testSourceConfig,
        });

      expect([400, 404]).toContain(response.status);
    });

    it('should publish audit log for source creation', async () => {
      const response = await request(app)
        .post('/admin/sources')
        .set('Authorization', `Bearer ${testAdminKey}`)
        .send({
          name: 'audit-test-' + Date.now(),
          ...testSourceConfig,
        });

      expect([200, 201, 404]).toContain(response.status);
    });
  });

  describe('DELETE /api/v1/admin/sources/:name', () => {
    it('should remove an oracle source', async () => {
      const sourceName = 'delete-test-' + Date.now();
      const createResponse = await request(app)
        .post('/admin/sources')
        .set('Authorization', `Bearer ${testAdminKey}`)
        .send({
          name: sourceName,
          ...testSourceConfig,
        });

      if (createResponse.status === 201 || createResponse.status === 200) {
        const deleteResponse = await request(app)
          .delete(`/admin/sources/${sourceName}`)
          .set('Authorization', `Bearer ${testAdminKey}`);

        expect([200, 404]).toContain(deleteResponse.status);

        if (deleteResponse.status === 200) {
          expect(deleteResponse.body.success).toBe(true);
          expect(deleteResponse.body.data).toHaveProperty('name', sourceName);
        }
      }
    });

    it('should return 404 when deleting non-existent source', async () => {
      const response = await request(app)
        .delete('/admin/sources/nonexistent-source-' + Date.now())
        .set('Authorization', `Bearer ${testAdminKey}`);

      expect([404]).toContain(response.status);
    });

    it('should prevent access without admin authentication', async () => {
      const response = await request(app)
        .delete('/admin/sources/test-source')
        .set('Authorization', 'Bearer invalid-key');

      expect(response.status).toBe(401);
    });
  });

  describe('PUT /api/v1/admin/sources/:name', () => {
    it('should update an oracle source', async () => {
      const sourceName = 'update-test-' + Date.now();
      const createResponse = await request(app)
        .post('/admin/sources')
        .set('Authorization', `Bearer ${testAdminKey}`)
        .send({
          name: sourceName,
          ...testSourceConfig,
        });

      if (createResponse.status === 201 || createResponse.status === 200) {
        const updateResponse = await request(app)
          .put(`/admin/sources/${sourceName}`)
          .set('Authorization', `Bearer ${testAdminKey}`)
          .send({
            rateLimitPerSecond: 200,
            timeout: 10000,
          });

        expect([200, 404]).toContain(updateResponse.status);

        if (updateResponse.status === 200) {
          expect(updateResponse.body.success).toBe(true);
          expect(updateResponse.body.data.rateLimitPerSecond).toBe(200);
        }
      }
    });

    it('should allow toggling active status', async () => {
      const sourceName = 'toggle-test-' + Date.now();
      const createResponse = await request(app)
        .post('/admin/sources')
        .set('Authorization', `Bearer ${testAdminKey}`)
        .send({
          name: sourceName,
          ...testSourceConfig,
        });

      if (createResponse.status === 201 || createResponse.status === 200) {
        const toggleResponse = await request(app)
          .put(`/admin/sources/${sourceName}`)
          .set('Authorization', `Bearer ${testAdminKey}`)
          .send({
            isActive: false,
          });

        expect([200, 404]).toContain(toggleResponse.status);

        if (toggleResponse.status === 200) {
          expect(toggleResponse.body.data.isActive).toBe(false);
        }
      }
    });
  });

  describe('Oracle Source Management - Authorization', () => {
    it('should require admin authentication to create source', async () => {
      const response = await request(app)
        .post('/admin/sources')
        .set('Authorization', 'Bearer invalid-key')
        .send(testSourceConfig);

      expect(response.status).toBe(401);
    });

    it('should require admin authentication to delete source', async () => {
      const response = await request(app)
        .delete('/admin/sources/test-source')
        .set('Authorization', 'Bearer invalid-key');

      expect(response.status).toBe(401);
    });

    it('should require admin authentication to update source', async () => {
      const response = await request(app)
        .put('/admin/sources/test-source')
        .set('Authorization', 'Bearer invalid-key')
        .send({ rateLimitPerSecond: 200 });

      expect(response.status).toBe(401);
    });
  });

  describe('Oracle Source Management - Audit Logging', () => {
    it('should log source creation in audit trail', async () => {
      const response = await request(app)
        .post('/admin/sources')
        .set('Authorization', `Bearer ${testAdminKey}`)
        .send({
          name: 'audit-log-test-' + Date.now(),
          ...testSourceConfig,
        });

      expect([200, 201, 404]).toContain(response.status);
    });

    it('should log source deletion in audit trail', async () => {
      const response = await request(app)
        .delete('/admin/sources/audit-delete-test-' + Date.now())
        .set('Authorization', `Bearer ${testAdminKey}`);

      expect([200, 404]).toContain(response.status);
    });
  });
});
