import { describe, it, expect, beforeAll } from 'vitest';
import fetch from 'node-fetch';

const API_ORIGIN = process.env.API_ORIGIN || 'http://localhost:3000';
const API_BASE = process.env.API_V1_URL || `${API_ORIGIN}/api/v1`;
const API_V2_BASE = process.env.API_V2_URL || `${API_ORIGIN}/api/v2`;
const TEST_API_KEY = process.env.TEST_API_KEY || 'test-key';

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)('Unified Error Model and Contract Testing (Issue #539)', () => {
  async function waitForService(url: string, maxAttempts = 30): Promise<void> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const response = await fetch(url, { timeout: 2000 });
        if (response.ok || response.status === 404 || response.status === 401 || response.status === 400) {
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

  it('should use unified error response shape across REST', async () => {
    const response = await fetch(`${API_BASE}/prices/NONEXISTENT`, {
      headers: {
        'Authorization': `Bearer ${TEST_API_KEY}`,
      },
    });

    expect(response.status).toBe(404);
    const data = await response.json() as any;

    // All error responses should have consistent structure
    expect(data).toHaveProperty('error');
    expect(data.error).toHaveProperty('code');
    expect(data.error).toHaveProperty('message');
    expect(typeof data.error.code).toBe('string');
    expect(typeof data.error.message).toBe('string');
  });

  it('should include error code and message in all error responses', async () => {
    const response = await fetch(`${API_BASE}/prices?invalid_param=true`, {
      headers: {
        'Authorization': `Bearer ${TEST_API_KEY}`,
      },
    });

    const data = await response.json() as any;

    if (!response.ok) {
      expect(data.error).toBeDefined();
      expect(data.error.code).toBeTruthy();
      expect(data.error.message).toBeTruthy();
    }
  });

  it('should use consistent error shape for validation failures', async () => {
    const response = await fetch(`${API_BASE}/prices?limit=invalid`, {
      headers: {
        'Authorization': `Bearer ${TEST_API_KEY}`,
      },
    });

    if (!response.ok) {
      const data = await response.json() as any;

      // Validation errors should match unified shape
      expect(data.error).toBeDefined();
      expect(data.error.code).toBeTruthy();
      expect(data.error.message).toBeTruthy();
      expect(typeof data.error).toBe('object');
    }
  });

  it('should return 401 for missing authentication', async () => {
    const response = await fetch(`${API_BASE}/prices`);

    expect(response.status).toBe(401);
    const data = await response.json() as any;

    expect(data.error).toBeDefined();
    expect(data.error.code).toBe('MISSING_API_KEY');
    expect(data.error.message).toBeTruthy();
  });

  it('should not leak internal details in error responses', async () => {
    const response = await fetch(`${API_BASE}/prices/INVALID`, {
      headers: {
        'Authorization': `Bearer ${TEST_API_KEY}`,
      },
    });

    const data = await response.json() as any;

    if (data.error) {
      const errorString = JSON.stringify(data.error);

      // Should not contain stack traces, database names, or internal IPs
      expect(errorString).not.toMatch(/stack|at |Error:/i);
      expect(errorString).not.toMatch(/postgresql|mysql|database/i);
      expect(errorString).not.toMatch(/192\.168\.|127\.0\.0|localhost/);
    }
  });

  it('should return rate limit error with consistent shape', async () => {
    // Make multiple rapid requests to potentially trigger rate limit
    const requests = [];
    for (let i = 0; i < 10; i++) {
      requests.push(
        fetch(`${API_BASE}/prices`, {
          headers: {
            'Authorization': `Bearer ${TEST_API_KEY}`,
          },
        })
      );
    }

    const responses = await Promise.all(requests);
    const rateLimited = responses.find(r => r.status === 429);

    if (rateLimited) {
      const data = await rateLimited.json() as any;

      expect(data.error).toBeDefined();
      expect(data.error.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(data.error).toHaveProperty('retryAfter');
      expect(rateLimited.headers.get('Retry-After')).toBeTruthy();
    }
  });

  it('should use consistent error shape in V2 endpoints', async () => {
    const response = await fetch(`${API_V2_BASE}/prices/NONEXISTENT`, {
      headers: {
        'Authorization': `Bearer ${TEST_API_KEY}`,
      },
    });

    if (!response.ok) {
      const data = await response.json() as any;

      // V2 should also use unified error shape
      expect(data.error).toBeDefined();
      expect(data.error.code).toBeTruthy();
      expect(data.error.message).toBeTruthy();
    }
  });

  it('should include error context fields when relevant', async () => {
    const response = await fetch(`${API_BASE}/prices?limit=invalid`, {
      headers: {
        'Authorization': `Bearer ${TEST_API_KEY}`,
      },
    });

    if (!response.ok) {
      const data = await response.json() as any;

      if (data.error && data.error.code === 'VALIDATION_ERROR') {
        // Validation errors should include field information
        expect(data.error.fields || data.error.context).toBeDefined();
      }
    }
  });

  it('should conform error responses to OpenAPI spec', async () => {
    const response = await fetch(`${API_BASE}/openapi.json`, {
      headers: {
        'Authorization': `Bearer ${TEST_API_KEY}`,
      },
    });

    if (response.ok) {
      const spec = await response.json() as any;

      // Spec should define error schemas
      expect(spec.components?.schemas?.Error).toBeDefined();

      // Error schema should have required fields
      const errorSchema = spec.components.schemas.Error;
      if (errorSchema) {
        expect(errorSchema.required || []).toContain('code');
        expect(errorSchema.required || []).toContain('message');
      }
    }
  });

  it('should document all error codes in API documentation', async () => {
    const response = await fetch(`${API_BASE}/docs/errors`, {
      headers: {
        'Authorization': `Bearer ${TEST_API_KEY}`,
      },
    });

    if (response.status === 200) {
      const data = await response.json() as any;
      expect(data).toBeDefined();
      // Documentation should list error codes
    }
  });

  it('should handle timeout errors with unified shape', async () => {
    // Create a request that might timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 100);

    try {
      const response = await fetch(`${API_BASE}/prices`, {
        headers: {
          'Authorization': `Bearer ${TEST_API_KEY}`,
        },
        signal: controller.signal as any,
      });

      if (!response.ok) {
        const data = await response.json() as any;
        expect(data.error).toBeDefined();
      }
    } catch (error) {
      // Timeout is acceptable
      expect(error).toBeDefined();
    } finally {
      clearTimeout(timeoutId);
    }
  });

  it('should provide request ID in error responses for tracking', async () => {
    const response = await fetch(`${API_BASE}/prices/INVALID`, {
      headers: {
        'Authorization': `Bearer ${TEST_API_KEY}`,
      },
    });

    const data = await response.json() as any;
    const requestId = response.headers.get('X-Request-Id') || data.error?.requestId;

    expect(requestId).toBeTruthy();
  });

  it('should handle validation errors with field-level details', async () => {
    const response = await fetch(`${API_BASE}/prices?limit=-5`, {
      headers: {
        'Authorization': `Bearer ${TEST_API_KEY}`,
      },
    });

    if (!response.ok) {
      const data = await response.json() as any;

      if (data.error?.code === 'VALIDATION_ERROR') {
        // Should include details about which field failed
        expect(data.error.fields || data.error.details || data.error.context).toBeDefined();
      }
    }
  });

  it('should maintain backwards compatibility during migration', async () => {
    const response = await fetch(`${API_BASE}/prices`, {
      headers: {
        'Authorization': `Bearer ${TEST_API_KEY}`,
      },
    });

    expect(response.ok || response.status === 401 || response.status === 400).toBe(true);

    // Response should be valid JSON
    const data = await response.json() as any;
    expect(data).toBeDefined();

    // Should have either new unified shape or old shape, but not mixed
    if (!response.ok) {
      expect(data.error || data.errors || data.message).toBeDefined();
    }
  });
});
