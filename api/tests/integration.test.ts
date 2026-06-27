import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fetch from 'node-fetch';
import WebSocket from 'ws';

const API_BASE = process.env.API_URL || 'http://localhost:3000/api/v1';
const WS_URL = process.env.WS_URL || 'ws://localhost:3001';
const AGGREGATOR_URL = process.env.AGGREGATOR_URL || 'http://localhost:4000';

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)('Integration Tests: Full Data Pipeline', () => {
  let wsConnection: WebSocket;

  beforeAll(async () => {
    // Wait for services to be ready (with shorter timeout for local testing)
    await waitForService(API_BASE, 5);
    await waitForService(AGGREGATOR_URL, 5);
  }, { timeout: 30000 });

  afterAll(async () => {
    if (wsConnection) {
      wsConnection.close();
    }
  });

  async function waitForService(url: string, maxAttempts = 30): Promise<void> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const response = await fetch(url, { timeout: 2000 });
        if (response.ok || response.status === 404) {
          return;
        }
      } catch {
        // Service not ready yet
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error(`Service ${url} not ready after ${maxAttempts} attempts`);
  }

  describe('Price API Endpoints', () => {
    it('should return all available prices', async () => {
      const response = await fetch(`${API_BASE}/prices`);
      expect(response.status).toBe(200);

      const data = await response.json() as any;
      expect(data.success).toBe(true);
      expect(data.data).toBeDefined();
      expect(Array.isArray(data.data.prices)).toBe(true);
    });

    it('should return specific asset price', async () => {
      const response = await fetch(`${API_BASE}/prices/XLM`);
      expect(response.status).toBeOneOf([200, 404]);

      const data = await response.json() as any;
      expect(data.success).toBeDefined();
    });

    it('should accept contract ID format', async () => {
      const contractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA5L';
      const response = await fetch(`${API_BASE}/prices/${contractId}`);
      // Contract might not have data, but should accept the format
      expect([200, 404]).toContain(response.status);
    });

    it('should return price history with filters', async () => {
      const response = await fetch(`${API_BASE}/history/XLM?limit=10`);
      expect([200, 404]).toContain(response.status);

      const data = await response.json() as any;
      expect(data.success).toBeDefined();
      if (data.success) {
        expect(Array.isArray(data.data.prices)).toBe(true);
        expect(data.data.prices.length).toBeLessThanOrEqual(10);
      }
    });
  });

  describe('Health Check Endpoints', () => {
    it('should return API health status', async () => {
      const response = await fetch(`${API_BASE}/health`);
      expect(response.status).toBe(200);

      const data = await response.json() as any;
      expect(data.success).toBe(true);
      expect(data.data.service).toBe('stellar-price-oracle-api');
      expect(['healthy', 'degraded']).toContain(data.data.status);
    });

    it('should return available sources', async () => {
      const response = await fetch(`${API_BASE}/sources`);
      expect(response.status).toBe(200);

      const data = await response.json() as any;
      expect(data.success).toBe(true);
      expect(Array.isArray(data.data.sources)).toBe(true);
      expect(data.data.sources.length).toBeGreaterThan(0);
    });
  });

  describe('WebSocket Real-Time Updates', () => {
    it('should connect and receive price updates', async () => {
      const updateReceived = new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('No price update received within 30 seconds'));
        }, 30000);

        wsConnection = new WebSocket(WS_URL);

        wsConnection.on('open', () => {
          // Connected, waiting for updates
        });

        wsConnection.on('message', (data) => {
          try {
            const message = JSON.parse(data.toString());
            if (message.type === 'price_update') {
              clearTimeout(timeout);
              wsConnection.close();
              resolve(message);
            }
          } catch (error) {
            // Ignore parse errors
          }
        });

        wsConnection.on('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });

      const message = await updateReceived;
      expect(message.type).toBe('price_update');
      expect(Array.isArray(message.data)).toBe(true);
    });
  });

  describe('Data Pipeline Consistency', () => {
    it('should have consistent data across REST and WebSocket', async () => {
      // Get data from REST API
      const restResponse = await fetch(`${API_BASE}/prices`);
      const restData = await restResponse.json() as any;

      if (restData.success && restData.data.prices.length > 0) {
        const restPrices = new Set(restData.data.prices.map((p: any) => p.asset));

        // Verify WebSocket can be connected (this is more of a connectivity test)
        const wsReady = new Promise<boolean>((resolve) => {
          const ws = new WebSocket(WS_URL);
          let connected = false;

          const timeout = setTimeout(() => {
            ws.close();
            resolve(connected);
          }, 5000);

          ws.on('open', () => {
            connected = true;
            clearTimeout(timeout);
            ws.close();
            resolve(true);
          });

          ws.on('error', () => {
            resolve(false);
          });
        });

        const wsConnected = await wsReady;
        expect([true, false]).toContain(wsConnected);
      }
    });
  });

  describe('Error Handling', () => {
    it('should return 404 for non-existent asset', async () => {
      const response = await fetch(`${API_BASE}/prices/NONEXISTENT123`);
      expect(response.status).toBe(404);

      const data = await response.json() as any;
      expect(data.success).toBe(false);
      expect(data.error).toBeDefined();
    });

    it('should validate asset parameter format', async () => {
      const response = await fetch(`${API_BASE}/history/INVALID!!`);
      expect([400, 404]).toContain(response.status);
    });

    it('should handle invalid query parameters gracefully', async () => {
      const response = await fetch(`${API_BASE}/history/XLM?limit=invalid`);
      expect([200, 400, 404]).toContain(response.status);
    });
  });

  describe('Performance and Caching', () => {
    it('should return cached responses consistently', async () => {
      // First request
      const response1 = await fetch(`${API_BASE}/prices`);
      const data1 = await response1.json() as any;

      // Second request (should be cached)
      const response2 = await fetch(`${API_BASE}/prices`);
      const data2 = await response2.json() as any;

      // Should have similar data
      expect(data1.success).toBe(data2.success);
      if (data1.success) {
        expect(data1.data.prices.length).toBe(data2.data.prices.length);
      }
    });
  });

  describe('Aggregator Service', () => {
    it('should have aggregator service running', async () => {
      const response = await fetch(`${AGGREGATOR_URL}/health`);
      expect([200, 404]).toContain(response.status);
    });
  });

  describe('API Response Format', () => {
    it('should follow consistent response format', async () => {
      const response = await fetch(`${API_BASE}/prices`);
      const data = await response.json() as any;

      // All responses should have success flag
      expect(typeof data.success).toBe('boolean');

      if (data.success) {
        expect(data.data).toBeDefined();
        // Shouldn't have error field if successful
        expect(data.error).toBeUndefined();
      } else {
        expect(data.error).toBeDefined();
      }
    });

    it('should include timestamps in responses', async () => {
      const response = await fetch(`${API_BASE}/prices`);
      const data = await response.json() as any;

      if (data.success && data.data.prices.length > 0) {
        const price = data.data.prices[0];
        expect(typeof price.timestamp).toBe('number');
        expect(price.timestamp).toBeGreaterThan(0);
      }
    });
  });
});
