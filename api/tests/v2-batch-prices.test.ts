import { describe, it, expect, beforeAll } from 'vitest';
import fetch from 'node-fetch';

const API_BASE = process.env.API_URL || 'http://localhost:3000/api/v2';

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)('Batch Price Query Endpoint (Issue #230)', () => {
  async function waitForService(url: string, maxAttempts = 30): Promise<void> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const response = await fetch(url, { timeout: 2000 });
        if (response.ok || response.status === 404 || response.status === 401) {
          return;
        }
      } catch {
        // Service not ready yet
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error(`Service ${url} not ready after ${maxAttempts} attempts`);
  }

  beforeAll(async () => {
    await waitForService(API_BASE, 5);
  }, { timeout: 30000 });

  const authHeaders = {
    'Authorization': `Bearer ${process.env.TEST_API_KEY || 'test-key'}`,
  };

  it('should accept batch prices via POST with array of assets', async () => {
    const response = await fetch(`${API_BASE}/prices/batch`, {
      method: 'POST',
      headers: {
        ...authHeaders,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ assets: ['BTC', 'ETH', 'XLM'] }),
    });
    expect(response.status).toBe(200);

    const data = await response.json() as any;
    expect(data.meta).toBeDefined();
    expect(data.meta.success).toBe(true);
    expect(data.data).toBeDefined();
    expect(data.data.results).toBeDefined();
    expect(Array.isArray(data.data.results)).toBe(true);
  });

  it('should accept batch prices via GET with query parameter', async () => {
    const response = await fetch(`${API_BASE}/prices/batch?assets=BTC,ETH,XLM`, {
      headers: authHeaders,
    });
    expect(response.status).toBe(200);

    const data = await response.json() as any;
    expect(data.meta.success).toBe(true);
    expect(data.data.results).toBeDefined();
    expect(Array.isArray(data.data.results)).toBe(true);
  });

  it('should handle comma-separated assets in GET request', async () => {
    const response = await fetch(`${API_BASE}/prices/batch?assets=BTC,ETH`, {
      headers: authHeaders,
    });
    expect(response.status).toBe(200);

    const data = await response.json() as any;
    expect(data.data.requested).toBe(2);
  });

  it('should validate maximum assets per request (50)', async () => {
    const assets = Array.from({ length: 51 }, (_, i) => `ASSET${i}`).join(',');
    const response = await fetch(`${API_BASE}/prices/batch?assets=${assets}`, {
      headers: authHeaders,
    });
    expect(response.status).toBe(400);
  });

  it('should return error for missing assets parameter in GET', async () => {
    const response = await fetch(`${API_BASE}/prices/batch`, {
      headers: authHeaders,
    });
    expect(response.status).toBe(400);

    const data = await response.json() as any;
    expect(data.meta.success).toBe(false);
    expect(data.error).toBeDefined();
  });

  it('should handle empty array in POST request', async () => {
    const response = await fetch(`${API_BASE}/prices/batch`, {
      method: 'POST',
      headers: {
        ...authHeaders,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ assets: [] }),
    });
    expect(response.status).toBe(400);
  });

  it('should include proper response format with requested and found counts', async () => {
    const response = await fetch(`${API_BASE}/prices/batch`, {
      method: 'POST',
      headers: {
        ...authHeaders,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ assets: ['BTC', 'ETH'] }),
    });

    const data = await response.json() as any;
    expect(data.data.timestamp).toBeDefined();
    expect(data.data.requested).toBeDefined();
    expect(data.data.found).toBeDefined();
    expect(data.data.requested).toBeGreaterThanOrEqual(0);
    expect(data.data.found).toBeLessThanOrEqual(data.data.requested);
  });

  it('should include error info for not found assets', async () => {
    const response = await fetch(`${API_BASE}/prices/batch`, {
      method: 'POST',
      headers: {
        ...authHeaders,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ assets: ['NONEXISTENT'] }),
    });

    const data = await response.json() as any;
    const notFoundResult = data.data.results.find((r: any) => r.asset === 'NONEXISTENT');
    if (notFoundResult) {
      expect(notFoundResult.error).toBeDefined();
    }
  });

  it('should cache batch responses', async () => {
    const response1 = await fetch(`${API_BASE}/prices/batch`, {
      method: 'POST',
      headers: {
        ...authHeaders,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ assets: ['BTC', 'ETH'] }),
    });
    const data1 = await response1.json() as any;

    const response2 = await fetch(`${API_BASE}/prices/batch`, {
      method: 'POST',
      headers: {
        ...authHeaders,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ assets: ['BTC', 'ETH'] }),
    });
    const data2 = await response2.json() as any;

    expect(data2.meta.cached).toBe(true);
  });
});
