import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sanitizeInputs, cspHeaders, validateWsAssets } from '../../src/governance/sanitization';
import { requireRole, ROLE_PERMISSIONS, ROLES } from '../../src/governance/rbac';
import { signPayload, verifyWsSignature } from '../../src/governance/ws-signing';
import { deprecationNotifier, DeprecationEvent } from '../../src/infrastructure/deprecation-notifier';
import { usageAnalytics } from '../../src/services/usage-analytics';

function mockRes() {
  const res: any = { statusCode: 200, headers: {} };
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((body: unknown) => {
    res.body = body;
    return res;
  });
  res.set = vi.fn((key: string, value: string) => {
    res.headers[key] = value;
    return res;
  });
  return res;
}

describe('sanitization', () => {
  it('strips HTML tags and dangerous characters from strings', () => {
    const req: any = { body: { name: '<script>alert(1)</script>', note: 'a"b;c`d' } };
    const next = vi.fn();
    sanitizeInputs(req, mockRes(), next);
    expect(req.body.name).toBe('alert(1)');
    expect(req.body.note).toBe('abcd');
    expect(next).toHaveBeenCalled();
  });

  it('drops dangerous prototype-pollution keys', () => {
    const req: any = { body: JSON.parse('{"__proto__": {"x": 1}, "ok": 1}') };
    sanitizeInputs(req, mockRes(), vi.fn());
    expect(req.body).not.toHaveProperty('__proto__');
    expect(req.body.ok).toBe(1);
  });

  it('recursively sanitizes arrays and nested objects', () => {
    const req: any = { body: { tags: ['<b>a</b>', '<i>b</i>'], nested: { deep: '<script>x</script>' } } };
    sanitizeInputs(req, mockRes(), vi.fn());
    expect(req.body.tags).toEqual(['a', 'b']);
    expect(req.body.nested.deep).toBe('x');
  });

  it('removes control characters and trims whitespace', () => {
    const req: any = { body: { value: '  hello\u0000world\u001f ' } };
    sanitizeInputs(req, mockRes(), vi.fn());
    expect(req.body.value).toBe('helloworld');
  });

  it('sanitizes query and params too', () => {
    const req: any = { body: {}, query: { q: '<x>' }, params: { id: '<y>' } };
    sanitizeInputs(req, mockRes(), vi.fn());
    expect(req.query.q).toBe('');
    expect(req.params.id).toBe('');
  });

  it('sets a strict CSP header', () => {
    const res = mockRes();
    cspHeaders(mockRes(), res, vi.fn());
    expect(res.headers['Content-Security-Policy']).toContain("default-src 'none'");
    expect(res.headers['Content-Security-Policy']).toContain('frame-ancestors');
  });

  it('validates asset lists for WS subscriptions', () => {
    expect(validateWsAssets(['XLM', 'USDC'])).toBe(true);
    expect(validateWsAssets([])).toBe(true);
    expect(validateWsAssets('XLM')).toBe(false);
    expect(validateWsAssets(['xlm'])).toBe(true); // uppercased before match
    expect(validateWsAssets(['BAD ASSET'])).toBe(false);
    expect(validateWsAssets([123])).toBe(false);
    expect(validateWsAssets(new Array(51).fill('XLM'))).toBe(false);
    expect(validateWsAssets(['C' + 'A'.repeat(55)])).toBe(true); // contract ID
  });
});

describe('RBAC', () => {
  it('defines the expected roles and permission matrix', () => {
    expect(ROLES).toEqual(['admin', 'operator', 'viewer']);
    expect(ROLE_PERMISSIONS.admin).toContain('keys:rotate');
    expect(ROLE_PERMISSIONS.operator).not.toContain('keys:delete');
    expect(ROLE_PERMISSIONS.viewer).not.toContain('keys:write');
  });

  it('allows roles at or above the minimum', () => {
    const next = vi.fn();
    requireRole('operator')({ userRole: 'admin' } as any, mockRes(), next);
    requireRole('viewer')({ userRole: 'viewer' } as any, mockRes(), next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('rejects roles below the minimum with 403', () => {
    const res = mockRes();
    requireRole('admin')({ userRole: 'viewer' } as any, res, vi.fn());
    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).toContain('admin');
  });

  it('defaults an unauthenticated request to viewer', () => {
    const res = mockRes();
    requireRole('admin')({} as any, res, vi.fn());
    expect(res.statusCode).toBe(403);
  });
});

describe('WS request signing', () => {
  const SECRET = 'test-secret';

  it('signs and verifies a valid request', () => {
    const ts = Date.now();
    const nonce = 'abc123';
    const sig = signPayload(SECRET, ts, nonce, '');
    const req: any = { url: `ws://host/path?ts=${ts}&nonce=${nonce}&sig=${sig}` };
    expect(verifyWsSignature(req, SECRET)).toEqual({ valid: true });
  });

  it('rejects requests without signature params', () => {
    const req: any = { url: 'ws://host/path' };
    expect(verifyWsSignature(req, SECRET).valid).toBe(false);
    expect(verifyWsSignature(req, SECRET).error).toContain('Missing');
  });

  it('rejects stale timestamps outside the ±30s window', () => {
    const ts = Date.now() - 120_000;
    const nonce = 'stale-nonce';
    const sig = signPayload(SECRET, ts, nonce, '');
    const req: any = { url: `ws://host/path?ts=${ts}&nonce=${nonce}&sig=${sig}` };
    const result = verifyWsSignature(req, SECRET);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Timestamp');
  });

  it('rejects tampered signatures', () => {
    const ts = Date.now();
    const req: any = { url: `ws://host/path?ts=${ts}&nonce=n&sig=${'0'.repeat(64)}` };
    expect(verifyWsSignature(req, SECRET).valid).toBe(false);
  });

  it('rejects replay of the same nonce', () => {
    const ts = Date.now();
    const nonce = 'replay-nonce';
    const sig = signPayload(SECRET, ts, nonce, '');
    const req: any = { url: `ws://host/path?ts=${ts}&nonce=${nonce}&sig=${sig}` };
    expect(verifyWsSignature(req, SECRET).valid).toBe(true);
    expect(verifyWsSignature(req, SECRET).valid).toBe(false);
  });

  it('skips verification when no secret is configured', () => {
    const req: any = { url: 'ws://host/path' };
    expect(verifyWsSignature(req, '')).toEqual({ valid: true });
  });
});

describe('deprecation notifier', () => {
  beforeEach(() => {
    (deprecationNotifier as any).listeners = [];
    (deprecationNotifier as any).seenKeysByPath = new Map();
  });
  afterEach(() => vi.restoreAllMocks());

  const event: DeprecationEvent = {
    path: '/v1/legacy',
    method: 'GET',
    sunsetOn: '2027-01-01',
    apiKeyId: 'key-1',
    timestamp: Date.now(),
  };

  it('notifies listeners for events with an apiKeyId', () => {
    const listener = vi.fn();
    deprecationNotifier.onDeprecatedUsage(listener);
    deprecationNotifier.notify(event);
    expect(listener).toHaveBeenCalledWith(event);
  });

  it('deduplicates repeated usage by the same key and path', () => {
    const listener = vi.fn();
    deprecationNotifier.onDeprecatedUsage(listener);
    deprecationNotifier.notify(event);
    deprecationNotifier.notify(event);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(deprecationNotifier.getAffectedConsumers('/v1/legacy')).toEqual(['key-1']);
  });

  it('notifies for every event when no apiKeyId is present', () => {
    const listener = vi.fn();
    deprecationNotifier.onDeprecatedUsage(listener);
    const anonymous = { ...event, apiKeyId: undefined };
    deprecationNotifier.notify(anonymous);
    deprecationNotifier.notify(anonymous);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('usage analytics', () => {
  beforeEach(() => {
    (usageAnalytics as any).events = [];
    (usageAnalytics as any).hourly = new Map();
  });
  afterEach(() => vi.restoreAllMocks());

  it('produces a daily report with aggregated counts', () => {
    usageAnalytics.record({ endpoint: '/prices', method: 'GET', apiKeyPrefix: 'abc', asset: 'XLM', status: 200, timestamp: Date.now() });
    usageAnalytics.record({ endpoint: '/prices', method: 'GET', apiKeyPrefix: 'abc', asset: 'BTC', status: 200, timestamp: Date.now() });
    usageAnalytics.record({ endpoint: '/sources', method: 'GET', apiKeyPrefix: 'xyz', status: 404, timestamp: Date.now() });

    const report = usageAnalytics.report('daily') as any;
    expect(report.period).toBe('daily');
    expect(report.totalRequests).toBe(3);
    expect(report.topEndpoints.length).toBeGreaterThan(0);
    expect(report.topKeys.length).toBeGreaterThan(0);
    expect(report.topAssets).toContainEqual({ key: 'XLM', count: 1 });
  });

  it('produces a dashboard with all windows and recent events', () => {
    usageAnalytics.record({ endpoint: '/prices', method: 'GET', apiKeyPrefix: 'abc', status: 200, timestamp: Date.now() });
    const dash = usageAnalytics.dashboard() as any;
    expect(dash.last24h).toBeDefined();
    expect(dash.last7d).toBeDefined();
    expect(dash.last30d).toBeDefined();
    expect(dash.recentEvents.length).toBe(1);
  });

  it('detects anomalies only with enough distinct hours and nonzero variance', () => {
    expect(usageAnalytics.detectAnomalies()).toEqual([]); // too few buckets
    const base = Date.now();
    for (let i = 0; i < 6; i++) {
      usageAnalytics.record({
        endpoint: '/prices', method: 'GET', apiKeyPrefix: 'k', status: 200,
        timestamp: base - i * 60 * 60 * 1000,
      });
    }
    const anomalies = usageAnalytics.detectAnomalies(0.0001, 24 * 30);
    expect(Array.isArray(anomalies)).toBe(true);
  });

  it('caps retained events at the maximum', () => {
    const now = Date.now();
    for (let i = 0; i < 5100; i++) {
      usageAnalytics.record({ endpoint: '/prices', method: 'GET', apiKeyPrefix: 'k', status: 200, timestamp: now });
    }
    expect((usageAnalytics as any).events.length).toBe(5000);
  });
});
