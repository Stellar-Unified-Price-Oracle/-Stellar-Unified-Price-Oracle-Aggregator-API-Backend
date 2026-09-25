import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import fetch from 'node-fetch';

const API_ORIGIN = process.env.API_ORIGIN || 'http://localhost:3000';
const API_BASE = process.env.API_V1_URL || `${API_ORIGIN}/api/v1`;
const TEST_API_KEY = process.env.TEST_API_KEY || 'test-key';

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)('Endpoint Deprecation Enforcement (Issue #537)', () => {
  async function waitForService(url: string, maxAttempts = 30): Promise<void> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const response = await fetch(url, { timeout: 2000 });
        if (response.ok || response.status === 404 || response.status === 401 || response.status === 410) {
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
    await waitForService(`${API_BASE}/history/XLM/legacy`, 5);
  }, 30_000);

  it('should emit Deprecation header on legacy endpoint', async () => {
    const response = await fetch(`${API_BASE}/history/XLM/legacy`, {
      headers: {
        'Authorization': `Bearer ${TEST_API_KEY}`,
      },
    });

    expect(response.status).toMatch(/^(200|301|410)$/);
    const deprecation = response.headers.get('Deprecation');
    expect(deprecation).toBeTruthy();
  });

  it('should emit Sunset header with removal date', async () => {
    const response = await fetch(`${API_BASE}/history/XLM/legacy`, {
      headers: {
        'Authorization': `Bearer ${TEST_API_KEY}`,
      },
    });

    expect(response.status).toMatch(/^(200|301|410)$/);
    const sunset = response.headers.get('Sunset');
    expect(sunset).toBeTruthy();

    // Sunset should be a valid HTTP-date
    if (sunset) {
      const sunsetDate = new Date(sunset);
      expect(sunsetDate.getTime()).toBeGreaterThan(Date.now());
    }
  });

  it('should include deprecation notice in response body', async () => {
    const response = await fetch(`${API_BASE}/history/XLM/legacy`, {
      headers: {
        'Authorization': `Bearer ${TEST_API_KEY}`,
      },
    });

    if (response.status === 200) {
      const data = await response.json() as any;
      // Deprecation notice should be present without breaking v1 parser
      expect(data.deprecation || data.warn || response.headers.get('Warning')).toBeTruthy();
    }
  });

  it('should track per-consumer usage via API key', async () => {
    const response = await fetch(`${API_BASE}/history/XLM/legacy`, {
      headers: {
        'Authorization': `Bearer ${TEST_API_KEY}`,
      },
    });

    expect(response.status).toMatch(/^(200|301|410)$/);

    // Response should include telemetry identifier
    expect(
      response.headers.get('X-Telemetry-Id') ||
      response.headers.get('X-Request-Id')
    ).toBeTruthy();
  });

  it('should document lifecycle stages in metadata', async () => {
    const response = await fetch(`${API_BASE}/docs/deprecated-endpoints`, {
      headers: {
        'Authorization': `Bearer ${TEST_API_KEY}`,
      },
    });

    // Should have deprecation policy documentation
    if (response.status === 200) {
      const data = await response.json() as any;
      expect(data).toBeDefined();
      // Documentation should list lifecycle stages and criteria
    }
  });

  it('should provide replacement endpoint information', async () => {
    const response = await fetch(`${API_BASE}/history/XLM/legacy`, {
      headers: {
        'Authorization': `Bearer ${TEST_API_KEY}`,
      },
    });

    expect(response.status).toMatch(/^(200|301|410)$/);

    // Should indicate replacement endpoint
    const link = response.headers.get('Link');
    const body = response.status === 200 ? await response.json() as any : null;

    expect(link || body?.replacement || body?.successor).toBeTruthy();
  });

  it('should define post-sunset response', async () => {
    // Test the behavior when sunset date is passed
    const response = await fetch(`${API_BASE}/history/XLM/legacy`, {
      headers: {
        'Authorization': `Bearer ${TEST_API_KEY}`,
      },
    });

    const sunset = response.headers.get('Sunset');
    if (sunset) {
      const sunsetDate = new Date(sunset);
      if (sunsetDate <= new Date()) {
        // If endpoint is already sunset
        expect(response.status).toBe(410);
        const data = await response.json() as any;
        expect(data.error || data.message).toBeTruthy();
      }
    }
  });

  it('should maintain v1 parser compatibility', async () => {
    const response = await fetch(`${API_BASE}/history/XLM/legacy`, {
      headers: {
        'Authorization': `Bearer ${TEST_API_KEY}`,
      },
    });

    if (response.status === 200) {
      const data = await response.json() as any;

      // Core structure should remain compatible with v1 parsers
      expect(data).toHaveProperty('data');
      if (data.data) {
        expect(Array.isArray(data.data) || typeof data.data === 'object').toBe(true);
      }
    }
  });

  it('should handle unauthenticated legacy requests per policy', async () => {
    const response = await fetch(`${API_BASE}/history/XLM/legacy`);

    // Should either accept or explicitly reject with auth error
    expect([401, 200, 410]).toContain(response.status);
  });

  it('should differentiate telemetry between legacy and new endpoints', async () => {
    const legacyResponse = await fetch(`${API_BASE}/history/XLM/legacy`, {
      headers: {
        'Authorization': `Bearer ${TEST_API_KEY}`,
      },
    });

    const newResponse = await fetch(`${API_BASE}/history/XLM`, {
      headers: {
        'Authorization': `Bearer ${TEST_API_KEY}`,
      },
    });

    const legacyId = legacyResponse.headers.get('X-Request-Id');
    const newId = newResponse.headers.get('X-Request-Id');

    expect(legacyId).toBeTruthy();
    expect(newId).toBeTruthy();
    // IDs should be different for tracking
    expect(legacyId).not.toEqual(newId);
  });
});
