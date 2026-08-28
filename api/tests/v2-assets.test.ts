import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fetch from 'node-fetch';

const API_BASE = process.env.API_URL || 'http://localhost:3000/api/v2';

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)('Asset Discovery Endpoint (Issue #229)', () => {
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

  it('should return asset metadata with status filter', async () => {
    const response = await fetch(`${API_BASE}/assets`, {
      headers: {
        'Authorization': `Bearer ${process.env.TEST_API_KEY || 'test-key'}`,
      },
    });
    expect(response.status).toBe(200);

    const data = await response.json() as any;
    expect(data.meta).toBeDefined();
    expect(data.meta.success).toBe(true);
    expect(data.data).toBeDefined();
    expect(data.data.assets).toBeDefined();
    expect(Array.isArray(data.data.assets)).toBe(true);
  });

  it('should return asset metadata for all assets by default', async () => {
    const response = await fetch(`${API_BASE}/assets`, {
      headers: {
        'Authorization': `Bearer ${process.env.TEST_API_KEY || 'test-key'}`,
      },
    });

    const data = await response.json() as any;
    expect(data.data.status).toBe('all');
    expect(data.data.count).toBeGreaterThanOrEqual(0);
  });

  it('should include proper asset metadata fields', async () => {
    const response = await fetch(`${API_BASE}/assets`, {
      headers: {
        'Authorization': `Bearer ${process.env.TEST_API_KEY || 'test-key'}`,
      },
    });

    const data = await response.json() as any;
    if (data.data.assets.length > 0) {
      const asset = data.data.assets[0];
      expect(asset.symbol).toBeDefined();
      expect(asset.decimals).toBeDefined();
      expect(asset.sources).toBeDefined();
      expect(asset.sourceCount).toBeDefined();
      expect(asset.status).toBe('active');
      expect(asset.lastUpdate).toBeDefined();
      expect(asset.confidence).toMatch(/^(low|medium|high)$/);
    }
  });

  it('should filter assets by status parameter', async () => {
    const response = await fetch(`${API_BASE}/assets?status=active`, {
      headers: {
        'Authorization': `Bearer ${process.env.TEST_API_KEY || 'test-key'}`,
      },
    });

    const data = await response.json() as any;
    expect(data.data.status).toBe('active');
    if (data.data.assets.length > 0) {
      data.data.assets.forEach((asset: any) => {
        expect(asset.status).toBe('active');
      });
    }
  });

  it('should return empty array for inactive status', async () => {
    const response = await fetch(`${API_BASE}/assets?status=inactive`, {
      headers: {
        'Authorization': `Bearer ${process.env.TEST_API_KEY || 'test-key'}`,
      },
    });

    const data = await response.json() as any;
    expect(data.meta.success).toBe(true);
    expect(data.data.assets).toEqual([]);
  });

  it('should return cached response on subsequent requests', async () => {
    const response1 = await fetch(`${API_BASE}/assets`, {
      headers: {
        'Authorization': `Bearer ${process.env.TEST_API_KEY || 'test-key'}`,
      },
    });
    const data1 = await response1.json() as any;

    const response2 = await fetch(`${API_BASE}/assets`, {
      headers: {
        'Authorization': `Bearer ${process.env.TEST_API_KEY || 'test-key'}`,
      },
    });
    const data2 = await response2.json() as any;

    expect(data2.meta.cached).toBe(true);
    expect(data1.data.count).toBe(data2.data.count);
  });
});
