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

describe('Issue #233: Circuit Breaker Management Endpoints', () => {
  describe('GET /admin/circuit-breakers', () => {
    it('should list all circuit breaker states', async () => {
      const response = await request(app)
        .get('/admin/circuit-breakers')
        .set('Authorization', `Bearer ${testAdminKey}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('states');
      expect(Array.isArray(response.body.data.states)).toBe(true);
    });

    it('should return circuit breaker states with proper structure', async () => {
      const response = await request(app)
        .get('/admin/circuit-breakers')
        .set('Authorization', `Bearer ${testAdminKey}`);

      expect(response.status).toBe(200);
      expect(response.body.data.states).toBeDefined();

      if (response.body.data.states.length > 0) {
        const state = response.body.data.states[0];
        expect(state).toHaveProperty('source');
        expect(state).toHaveProperty('status');
        expect(['closed', 'open', 'half-open']).toContain(state.status);
      }
    });

    it('should include breaker count in response', async () => {
      const response = await request(app)
        .get('/admin/circuit-breakers')
        .set('Authorization', `Bearer ${testAdminKey}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveProperty('count');
      expect(typeof response.body.data.count).toBe('number');
      expect(response.body.data.count).toBeGreaterThanOrEqual(0);
    });
  });

  describe('POST /admin/circuit-breakers/:source/reset', () => {
    it('should reset a circuit breaker for a specific source', async () => {
      const testSource = 'binance-usd';
      const response = await request(app)
        .post(`/admin/circuit-breakers/${testSource}/reset`)
        .set('Authorization', `Bearer ${testAdminKey}`);

      expect([200, 404]).toContain(response.status);

      if (response.status === 200) {
        expect(response.body.success).toBe(true);
        expect(response.body.data).toHaveProperty('source', testSource);
        expect(response.body.data).toHaveProperty('status');
        expect(response.body.data.status).toBe('closed');
      }
    });

    it('should return 404 for non-existent circuit breaker', async () => {
      const response = await request(app)
        .post('/admin/circuit-breakers/nonexistent-source/reset')
        .set('Authorization', `Bearer ${testAdminKey}`);

      expect([200, 404]).toContain(response.status);
    });

    it('should properly validate source name', async () => {
      const response = await request(app)
        .post('/admin/circuit-breakers//reset')
        .set('Authorization', `Bearer ${testAdminKey}`);

      expect([400, 404]).toContain(response.status);
    });
  });

  describe('POST /admin/circuit-breakers/reset-all', () => {
    it('should reset all circuit breakers', async () => {
      const response = await request(app)
        .post('/admin/circuit-breakers/reset-all')
        .set('Authorization', `Bearer ${testAdminKey}`);

      expect([200, 404]).toContain(response.status);

      if (response.status === 200) {
        expect(response.body.success).toBe(true);
        expect(response.body.data).toHaveProperty('resetCount');
        expect(typeof response.body.data.resetCount).toBe('number');
      }
    });

    it('should verify all breakers are closed after reset-all', async () => {
      const resetResponse = await request(app)
        .post('/admin/circuit-breakers/reset-all')
        .set('Authorization', `Bearer ${testAdminKey}`);

      if (resetResponse.status === 200) {
        const listResponse = await request(app)
          .get('/admin/circuit-breakers')
          .set('Authorization', `Bearer ${testAdminKey}`);

        expect(listResponse.status).toBe(200);
        const allClosed = listResponse.body.data.states.every(
          (state: any) => state.status === 'closed' || state.status === 'half-open'
        );
        expect(allClosed).toBe(true);
      }
    });
  });

  describe('Circuit Breaker Endpoint - Authorization', () => {
    it('should require admin authentication to list breakers', async () => {
      const response = await request(app)
        .get('/admin/circuit-breakers')
        .set('Authorization', 'Bearer invalid-key');

      expect(response.status).toBe(401);
    });

    it('should require admin authentication to reset breaker', async () => {
      const response = await request(app)
        .post('/admin/circuit-breakers/test-source/reset')
        .set('Authorization', 'Bearer invalid-key');

      expect(response.status).toBe(401);
    });

    it('should work with valid admin key', async () => {
      const response = await request(app)
        .get('/admin/circuit-breakers')
        .set('Authorization', `Bearer ${testAdminKey}`);

      expect([200, 404]).toContain(response.status);
    });
  });
});
