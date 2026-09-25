import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fetch from 'node-fetch';

const API_ORIGIN = process.env.API_ORIGIN || 'http://localhost:3000';
const API_BASE = process.env.API_V1_URL || `${API_ORIGIN}/api/v1`;
const TEST_API_KEY = process.env.TEST_API_KEY || 'test-key';

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)('Cursor-based Pagination (Issue #536)', () => {
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
    await waitForService(`${API_BASE}/prices`, 5);
  }, 30_000);

  it('should return pagination metadata with cursor information', async () => {
    const response = await fetch(`${API_BASE}/prices`, {
      headers: {
        'Authorization': `Bearer ${TEST_API_KEY}`,
      },
    });

    expect(response.status).toBe(200);
    const data = await response.json() as any;
    expect(data.pagination).toBeDefined();
    expect(data.pagination.cursor).toBeDefined();
    expect(data.pagination.hasMore).toBeDefined();
  });

  it('should support cursor-based navigation', async () => {
    const response1 = await fetch(`${API_BASE}/prices?limit=2`, {
      headers: {
        'Authorization': `Bearer ${TEST_API_KEY}`,
      },
    });

    expect(response1.status).toBe(200);
    const data1 = await response1.json() as any;
    expect(Array.isArray(data1.data)).toBe(true);
    expect(data1.pagination.cursor).toBeDefined();

    if (data1.pagination.hasMore) {
      const response2 = await fetch(
        `${API_BASE}/prices?limit=2&cursor=${encodeURIComponent(data1.pagination.cursor)}`,
        {
          headers: {
            'Authorization': `Bearer ${TEST_API_KEY}`,
          },
        }
      );

      expect(response2.status).toBe(200);
      const data2 = await response2.json() as any;
      expect(Array.isArray(data2.data)).toBe(true);

      // Verify no duplicate assets between pages
      const page1Assets = new Set(data1.data.map((p: any) => p.asset));
      const page2Assets = new Set(data2.data.map((p: any) => p.asset));
      const intersection = [...page1Assets].filter(asset => page2Assets.has(asset));
      expect(intersection).toHaveLength(0);
    }
  });

  it('should return immutable ordering across cursor iterations', async () => {
    const response1 = await fetch(`${API_BASE}/prices?limit=3`, {
      headers: {
        'Authorization': `Bearer ${TEST_API_KEY}`,
      },
    });

    expect(response1.status).toBe(200);
    const data1 = await response1.json() as any;
    const firstPageAssets = data1.data.map((p: any) => p.asset);

    // Fetch the same page again
    const response2 = await fetch(`${API_BASE}/prices?limit=3`, {
      headers: {
        'Authorization': `Bearer ${TEST_API_KEY}`,
      },
    });

    expect(response2.status).toBe(200);
    const data2 = await response2.json() as any;
    const secondPageAssets = data2.data.map((p: any) => p.asset);

    // First page assets should be identical (stable cursor ordering)
    expect(firstPageAssets).toEqual(secondPageAssets);
  });

  it('should provide stability guarantees in pagination metadata', async () => {
    const response = await fetch(`${API_BASE}/prices`, {
      headers: {
        'Authorization': `Bearer ${TEST_API_KEY}`,
      },
    });

    expect(response.status).toBe(200);
    const data = await response.json() as any;

    // Pagination metadata should document stability guarantees
    expect(data.pagination).toHaveProperty('stabilityGuarantee');
    expect(['stable', 'eventually_consistent']).toContain(
      data.pagination.stabilityGuarantee
    );
  });

  it('should document add/remove semantics for in-flight walks', async () => {
    const response = await fetch(`${API_BASE}/prices`, {
      headers: {
        'Authorization': `Bearer ${TEST_API_KEY}`,
      },
    });

    expect(response.status).toBe(200);
    const data = await response.json() as any;

    // Pagination metadata should document asset addition/removal behavior
    expect(data.pagination).toHaveProperty('newAssetBehavior');
    expect(['not_visible', 'visible_at_end']).toContain(
      data.pagination.newAssetBehavior
    );
  });

  it('should support backward compatibility with offset pagination', async () => {
    const response = await fetch(`${API_BASE}/prices?page=1&limit=5`, {
      headers: {
        'Authorization': `Bearer ${TEST_API_KEY}`,
      },
    });

    // Should either support offset (200) or explicitly deprecate (410 with Deprecation header)
    expect([200, 410]).toContain(response.status);

    if (response.status === 200) {
      const data = await response.json() as any;
      expect(data.data).toBeDefined();
      expect(Array.isArray(data.data)).toBe(true);
    } else if (response.status === 410) {
      expect(response.headers.get('Deprecation')).toBeTruthy();
      expect(response.headers.get('Sunset')).toBeTruthy();
    }
  });

  it('should avoid duplicates when underlying data mutates between fetches', async () => {
    const response1 = await fetch(`${API_BASE}/prices?limit=10`, {
      headers: {
        'Authorization': `Bearer ${TEST_API_KEY}`,
      },
    });

    expect(response1.status).toBe(200);
    const data1 = await response1.json() as any;

    // Wait a moment for potential price updates
    await new Promise(resolve => setTimeout(resolve, 2000));

    const response2 = await fetch(
      `${API_BASE}/prices?limit=10&cursor=${encodeURIComponent(data1.pagination.cursor)}`,
      {
        headers: {
          'Authorization': `Bearer ${TEST_API_KEY}`,
        },
      }
    );

    expect(response2.status).toBe(200);
    const data2 = await response2.json() as any;

    // Collect all assets from both pages
    const allAssets: string[] = [];
    data1.data.forEach((p: any) => allAssets.push(p.asset));
    data2.data.forEach((p: any) => allAssets.push(p.asset));

    // Check for duplicates
    const uniqueAssets = new Set(allAssets);
    expect(uniqueAssets.size).toBe(allAssets.length);
  });
});
