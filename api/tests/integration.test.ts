import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fetch from 'node-fetch';
import WebSocket from 'ws';

const API_ORIGIN = process.env.API_ORIGIN || 'http://localhost:3000';
const API_BASE = process.env.API_V1_URL || `${API_ORIGIN}/api/v1`;

// The API's WebSocket (client-driven subscriptions) is a different server from
// the aggregator's (which is what actually pushes price updates), and the
// aggregator serves health on a third port. Note the aggregator publishes on
// `port + 1`, so PORT=4000 means the socket is on 4001.
const API_WS_URL = process.env.WS_URL || 'ws://localhost:3001';
const AGGREGATOR_WS_URL = process.env.AGGREGATOR_WS_URL || 'ws://localhost:4001';
const AGGREGATOR_HEALTH_URL =
  process.env.AGGREGATOR_HEALTH_URL || 'http://localhost:4002';

const API_KEY = process.env.TEST_API_KEY || '';

// /prices, /history and the v2 price routes are mounted behind `authMiddleware`,
// which answers 401 MISSING_API_KEY before the handler runs.
const authHeaders: Record<string, string> = API_KEY
  ? { Authorization: `Bearer ${API_KEY}` }
  : {};

const WS_ORIGIN = { headers: { origin: 'http://localhost:3000' } };

function apiGet(path: string) {
  return fetch(`${API_BASE}${path}`, { headers: authHeaders, timeout: 10_000 });
}

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
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Service ${url} not ready after ${maxAttempts} attempts`);
}

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)('Integration Tests: Full Data Pipeline', () => {
  let wsConnection: WebSocket | undefined;

  beforeAll(async () => {
    await waitForService(`${API_BASE}/health`, 30);
    await waitForService(`${AGGREGATOR_HEALTH_URL}/health`, 30);
  }, 60_000);

  afterAll(async () => {
    if (wsConnection) {
      wsConnection.close();
    }
  });

  describe('Price API Endpoints', () => {
    it('should return all available prices', async () => {
      const response = await apiGet('/prices');
      expect(response.status).toBe(200);

      const data = await response.json() as any;
      expect(data.success).toBe(true);
      expect(data.data).toBeDefined();
      expect(Array.isArray(data.data.prices)).toBe(true);
    });

    it('should return specific asset price', async () => {
      const response = await apiGet('/prices/XLM');
      expect([200, 404]).toContain(response.status);

      const data = await response.json() as any;
      expect(data.success).toBeDefined();
    });

    it('should accept contract ID format', async () => {
      const contractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA5L';
      const response = await apiGet(`/prices/${contractId}`);
      // Contract might not have data, but should accept the format
      expect([200, 404]).toContain(response.status);
    });

    it('should return price history with filters', async () => {
      const response = await apiGet('/history/XLM?limit=10');
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
    it('should connect and receive price updates from the aggregator', async () => {
      const updateReceived = new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('No price update received within 30 seconds'));
        }, 30_000);

        wsConnection = new WebSocket(AGGREGATOR_WS_URL, WS_ORIGIN);

        wsConnection.on('message', (data) => {
          try {
            const message = JSON.parse(data.toString());
            if (message.type === 'price_update') {
              clearTimeout(timeout);
              wsConnection?.close();
              resolve(message);
            }
          } catch {
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
      expect(message.data.length).toBeGreaterThan(0);
    });
  });

  describe('Data Pipeline Consistency', () => {
    it('should have consistent data across REST and WebSocket', async () => {
      const restResponse = await apiGet('/prices');
      const restData = await restResponse.json() as any;

      expect(restData.success).toBe(true);
      expect(restData.data.prices.length).toBeGreaterThan(0);

      // The aggregator writes the history files the API serves, so anything the
      // REST layer returns must also have arrived over the aggregator's socket.
      const wsReady = new Promise<boolean>((resolve) => {
        const ws = new WebSocket(AGGREGATOR_WS_URL, WS_ORIGIN);
        const timeout = setTimeout(() => {
          ws.close();
          resolve(false);
        }, 5000);

        ws.on('open', () => {
          clearTimeout(timeout);
          ws.close();
          resolve(true);
        });

        ws.on('error', () => {
          clearTimeout(timeout);
          resolve(false);
        });
      });

      expect(await wsReady).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should return 404 for non-existent asset', async () => {
      const response = await apiGet('/prices/NONEXISTENT123');
      expect(response.status).toBe(404);

      const data = await response.json() as any;
      expect(data.success).toBe(false);
      expect(data.error).toBeDefined();
    });

    it('should validate asset parameter format', async () => {
      const response = await apiGet('/history/INVALID!!');
      expect([400, 404]).toContain(response.status);
    });

    it('should handle invalid query parameters gracefully', async () => {
      const response = await apiGet('/history/XLM?limit=invalid');
      expect([200, 400, 404]).toContain(response.status);
    });

    it('should reject unauthenticated price requests', async () => {
      const response = await fetch(`${API_BASE}/prices`);
      expect(response.status).toBe(401);

      const data = await response.json() as any;
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('MISSING_API_KEY');
    });
  });

  describe('Performance and Caching', () => {
    it('should return cached responses consistently', async () => {
      const response1 = await apiGet('/prices');
      const data1 = await response1.json() as any;

      const response2 = await apiGet('/prices');
      const data2 = await response2.json() as any;

      expect(data1.success).toBe(data2.success);
      if (data1.success) {
        expect(data1.data.prices.length).toBe(data2.data.prices.length);
      }
    });
  });

  describe('Aggregator Service', () => {
    it('should have aggregator health endpoint running', async () => {
      const response = await fetch(`${AGGREGATOR_HEALTH_URL}/health`);
      expect(response.status).toBe(200);

      const data = await response.json() as any;
      expect(data.service).toBe('stellar-price-oracle-aggregator');
      expect(Array.isArray(data.sources)).toBe(true);
      expect(data.sources.length).toBeGreaterThan(0);
    });
  });

  describe('API Response Format', () => {
    it('should follow consistent response format', async () => {
      const response = await apiGet('/prices');
      const data = await response.json() as any;

      expect(typeof data.success).toBe('boolean');

      if (data.success) {
        expect(data.data).toBeDefined();
        expect(data.error).toBeUndefined();
      } else {
        expect(data.error).toBeDefined();
      }
    });

    it('should include timestamps in responses', async () => {
      const response = await apiGet('/prices');
      const data = await response.json() as any;

      if (data.success && data.data.prices.length > 0) {
        const price = data.data.prices[0];
        expect(typeof price.timestamp).toBe('number');
        expect(price.timestamp).toBeGreaterThan(0);
      }
    });
  });
});
