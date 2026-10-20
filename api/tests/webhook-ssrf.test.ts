import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import request from 'supertest';
import { isSsrfError, SsrfError } from '@stellar-oracle/ssrf-guard';
import { webhookService, type WebhookRegistration, type WebhookTrigger } from '../src/webhooks/webhook-service';
import webhooksRouter from '../src/webhooks/webhooks';
import { config } from '../src/infrastructure/config';

const trigger: WebhookTrigger = { type: 'threshold', asset: 'XLM', value: 5 };

const original = {
  requireHttps: config.webhooks.requireHttps,
  allowPrivateIps: config.webhooks.allowPrivateIps,
  allowedHosts: config.webhooks.allowedHosts,
  allowedHostsByTenant: config.webhooks.allowedHostsByTenant,
  maxRetries: config.webhooks.maxRetries,
};

beforeEach(() => {
  webhookService.reset();
  config.webhooks.requireHttps = true;
  config.webhooks.allowPrivateIps = false;
  config.webhooks.allowedHosts = [];
  config.webhooks.allowedHostsByTenant = {};
  config.webhooks.maxRetries = 5;
});

afterEach(() => {
  config.webhooks.requireHttps = original.requireHttps;
  config.webhooks.allowPrivateIps = original.allowPrivateIps;
  config.webhooks.allowedHosts = original.allowedHosts;
  config.webhooks.allowedHostsByTenant = original.allowedHostsByTenant;
  config.webhooks.maxRetries = original.maxRetries;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function registration(url: string, apiKeyPrefix = 'key-1'): WebhookRegistration {
  return {
    id: `wh-${Math.random().toString(36).slice(2)}`,
    url,
    apiKeyPrefix,
    trigger,
    secret: 'secret',
    verificationKey: 'verification-key',
    active: true,
    status: 'healthy',
    createdAt: Date.now(),
    failureCount: 0,
  };
}

describe('Issue #600: webhook registration rejects SSRF destinations', () => {
  it('rejects the cloud metadata endpoint', () => {
    expect(() =>
      webhookService.register('http://169.254.169.254/latest/meta-data/', 'key-1', trigger),
    ).toThrow(SsrfError);

    try {
      webhookService.register('https://169.254.169.254/latest/meta-data/', 'key-1', trigger);
      throw new Error('expected a rejection');
    } catch (err) {
      expect(isSsrfError(err)).toBe(true);
      expect((err as SsrfError).reason).toBe('private-ip');
    }
  });

  it('rejects loopback, RFC1918 and link-local literals', () => {
    const cases: Array<[string, string]> = [
      ['https://127.0.0.1:5432/', 'private-ip'],
      ['https://10.1.2.3/', 'private-ip'],
      ['https://172.16.0.9/', 'private-ip'],
      ['https://192.168.0.1/', 'private-ip'],
      ['https://[::1]:8200/', 'private-ip'],
      // Numeric obfuscations the URL parser folds back to 127.0.0.1.
      ['https://2130706433/', 'private-ip'],
      ['https://0x7f.1/', 'private-ip'],
    ];

    for (const [url, reason] of cases) {
      let thrown: unknown;
      try {
        webhookService.register(url, 'key-1', trigger);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, url).toBeInstanceOf(SsrfError);
      expect((thrown as SsrfError).reason, url).toBe(reason);
    }
  });

  it('rejects in-cluster and local hostnames without a DNS query', () => {
    const cases: Array<[string, string]> = [
      ['https://localhost/hook', 'forbidden-host'],
      ['https://metadata.google.internal/', 'forbidden-host'],
      ['https://oracle.default.svc.cluster.local/', 'forbidden-host'],
      ['https://kubernetes.default.svc/', 'forbidden-host'],
      ['https://api.internal/', 'forbidden-host'],
      ['https://host.docker.internal/', 'forbidden-host'],
    ];

    for (const [url, reason] of cases) {
      let thrown: unknown;
      try {
        webhookService.register(url, 'key-1', trigger);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, url).toBeInstanceOf(SsrfError);
      expect((thrown as SsrfError).reason, url).toBe(reason);
    }
  });

  it('requires https by default', () => {
    expect(config.webhooks.requireHttps).toBe(true);
    expect(() => webhookService.register('http://hooks.example.com/hook', 'key-1', trigger)).toThrow(
      /https/i,
    );
    expect(
      webhookService.register('https://hooks.example.com/hook', 'key-1', trigger).url,
    ).toBe('https://hooks.example.com/hook');
  });

  it('honours an explicit http opt-in for development', () => {
    config.webhooks.requireHttps = false;
    expect(webhookService.register('http://hooks.example.com/hook', 'key-1', trigger).url).toContain(
      'http://',
    );
  });

  it('rejects non-http protocols', () => {
    expect(() => webhookService.register('ftp://example.com/x', 'key-1', trigger)).toThrow(
      /protocol/i,
    );
    expect(() => webhookService.register('file:///etc/passwd', 'key-1', trigger)).toThrow(SsrfError);
  });
});

describe('Issue #600: allowlist and per-tenant allowlist', () => {
  it('rejects any host outside the global allowlist', () => {
    config.webhooks.allowedHosts = ['hooks.example.com'];

    expect(webhookService.register('https://hooks.example.com/hook', 'key-1', trigger)).toBeDefined();
    expect(() =>
      webhookService.register('https://evil.example.com/hook', 'key-1', trigger),
    ).toThrow(/allowlist/i);
    expect(() =>
      webhookService.register('https://169.254.169.254/', 'key-1', trigger),
    ).toThrow(/allowlist/i);
  });

  it('applies a tenant allowlist and lets other tenants fall back to the global one', () => {
    config.webhooks.allowedHosts = ['global.example.com'];
    config.webhooks.allowedHostsByTenant = { 'tenant-a': ['only-a.example.com'] };

    expect(
      webhookService.register('https://only-a.example.com/hook', 'tenant-a', trigger),
    ).toBeDefined();
    expect(() =>
      webhookService.register('https://other.example.com/hook', 'tenant-a', trigger),
    ).toThrow(/allowlist/i);
    // A tenant with no entry is governed by the global list, not the other tenant's.
    expect(
      webhookService.register('https://global.example.com/hook', 'tenant-b', trigger),
    ).toBeDefined();
    expect(() =>
      webhookService.register('https://only-a.example.com/hook', 'tenant-b', trigger),
    ).toThrow(/allowlist/i);
  });

  it('never widens the policy when the tenant map is malformed', () => {
    config.webhooks.allowedHosts = ['global.example.com'];
    (config.webhooks.allowedHostsByTenant as Record<string, unknown>)['tenant-a'] = {
      host: 'anything.example.com',
    };

    // The unusable entry is ignored, so the global allowlist governs the tenant.
    expect(webhookService.register('https://global.example.com/hook', 'tenant-a', trigger)).toBeDefined();
    expect(() =>
      webhookService.register('https://anything.example.com/hook', 'tenant-a', trigger),
    ).toThrow(/allowlist/i);
  });
});

describe('Issue #600: the registration route normalizes its rejection', () => {
  function app(): express.Express {
    const created = express();
    created.use(express.json());
    created.use('/webhooks', webhooksRouter);
    return created;
  }

  const payload = {
    url: 'https://169.254.169.254/latest/meta-data/',
    trigger: { type: 'threshold', asset: 'XLM', value: 5 },
  };

  it('answers 400 with a reason that does not echo internal detail', async () => {
    const res = await request(app()).post('/webhooks').send(payload);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('INVALID_WEBHOOK_URL');
    expect(res.body.error.reason).toBe('private-ip');
    expect(res.body.error.message).not.toMatch(/169\.254/);
    expect(res.body.error.message).not.toMatch(/meta-data/);
  });

  it('rejects a plaintext URL', async () => {
    const res = await request(app())
      .post('/webhooks')
      .send({ ...payload, url: 'http://hooks.example.com/hook' });

    expect(res.status).toBe(400);
    expect(res.body.error.reason).toBe('https-required');
    expect(res.body.error.message).toMatch(/https/i);
  });

  it('still registers an acceptable URL', async () => {
    const res = await request(app())
      .post('/webhooks')
      .send({ ...payload, url: 'https://hooks.example.com/hook' });

    expect(res.status).toBe(201);
    expect(res.body.data.url).toBe('https://hooks.example.com/hook');
  });
});

describe('Issue #600: delivery refuses a stored private URL', () => {
  it('never issues a request to the metadata endpoint', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const webhook = registration('http://169.254.169.254/latest/meta-data/');
    await webhookService.deliver(webhook, { asset: 'XLM', price: 0.5 });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(webhook.lastFailure).toBe('blocked-url');
    expect(webhook.status).toBe('dead-letter');
    expect(webhook.failureCount).toBe(1);

    const [delivery] = webhookService.deliveries(webhook.id);
    expect(delivery.success).toBe(false);
    expect(delivery.error).toBe('blocked-url');
    expect(delivery.error).not.toMatch(/169\.254/);
  });

  it('re-validates a URL that became disallowed after registration', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const webhook = webhookService.register('https://hooks.example.com/hook', 'key-1', trigger);
    config.webhooks.allowedHosts = ['somewhere-else.example.com'];

    await webhookService.deliver(webhook, { asset: 'XLM', price: 0.5 });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(webhook.lastFailure).toBe('blocked-url');
  });
});

describe('Issue #600: redirects cannot escape the validation', () => {
  let server: http.Server;
  let port = 0;
  const hits: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits.push(req.url ?? '');
      if (req.url === '/redirect') {
        res.writeHead(302, { Location: `http://127.0.0.1:${port}/internal` });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    hits.length = 0;
    // Reaching a loopback test double at all is a development opt-in.
    config.webhooks.requireHttps = false;
    config.webhooks.allowPrivateIps = true;
    config.webhooks.maxRetries = 1;
  });

  it('refuses the redirect target instead of fetching it', async () => {
    const webhook = webhookService.register(`http://127.0.0.1:${port}/redirect`, 'key-1', trigger);

    await webhookService.deliver(webhook, { asset: 'XLM', price: 0.5 });

    expect(hits).toContain('/redirect');
    expect(hits).not.toContain('/internal');
    expect(webhook.lastFailure).toBe('redirect-not-followed');
  });

  it('asks the client for manual redirects', async () => {
    const fetchSpy = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchSpy);

    const webhook = webhookService.register(`http://127.0.0.1:${port}/hook`, 'key-1', trigger);
    await webhookService.deliver(webhook, { asset: 'XLM', price: 0.5 });

    const init = fetchSpy.mock.calls[0][1] as RequestInit & { redirect?: string; dispatcher?: unknown };
    expect(init.redirect).toBe('manual');
    expect(init.dispatcher).toBeDefined();
  });

  it('delivers through the hardened dispatcher when the destination is allowed', async () => {
    const webhook = webhookService.register(`http://127.0.0.1:${port}/hook`, 'key-1', trigger);

    await webhookService.deliver(webhook, { asset: 'XLM', price: 0.5 });

    expect(hits).toContain('/hook');
    const [delivery] = webhookService.deliveries(webhook.id);
    expect(delivery.success).toBe(true);
    expect(delivery.statusCode).toBe(200);
    expect(webhook.lastFailure).toBeUndefined();
  });

  it('still refuses a private destination when private IPs are switched off', async () => {
    config.webhooks.allowPrivateIps = false;

    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const webhook = registration(`http://127.0.0.1:${port}/hook`);
    await webhookService.deliver(webhook, { asset: 'XLM', price: 0.5 });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(webhook.lastFailure).toBe('blocked-url');
    expect(hits).not.toContain('/hook');
  });
});

describe('Issue #750: egress destinations are constrained by deployment policy', () => {
  it('pins the default deployment policy to https, no private IPs and no allowlist widening', () => {
    // The shipped defaults are the policy of record; a change here is a policy change.
    expect(config.webhooks.requireHttps).toBe(true);
    expect(config.webhooks.allowPrivateIps).toBe(false);
    expect(config.webhooks.allowedHosts).toEqual([]);
    expect(config.webhooks.allowedHostsByTenant).toEqual({});
  });

  it('accepts a boundary allowlisted destination and rejects its near-misses', () => {
    config.webhooks.allowedHosts = ['hooks.example.com'];

    // Exact host match is the only accepted form.
    expect(webhookService.register('https://hooks.example.com/hook', 'key-1', trigger)).toBeDefined();
    expect(webhookService.register('https://hooks.example.com:8443/hook', 'key-1', trigger)).toBeDefined();

    const nearMisses = [
      'https://hooks.example.com.evil.test/hook',
      'https://evil.test/hooks.example.com',
      'https://sub.hooks.example.com/hook',
      'https://hooks.example.com@evil.test/hook',
      'https://evil.test#@hooks.example.com/hook',
      'https://evil.test?next=https://hooks.example.com/hook',
    ];

    for (const url of nearMisses) {
      let thrown: unknown;
      try {
        webhookService.register(url, 'key-1', trigger);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, url).toBeInstanceOf(SsrfError);
      expect((thrown as SsrfError).reason, url).toBe('not-allowlisted');
    }
  });

  it('keeps the allowlist authoritative over the private-IP opt-in', () => {
    config.webhooks.allowPrivateIps = true;
    config.webhooks.allowedHosts = ['hooks.example.com'];

    // The development opt-in must not widen the allowlist.
    expect(() =>
      webhookService.register('https://127.0.0.1/hook', 'key-1', trigger),
    ).toThrow(/allowlist/i);
    expect(() =>
      webhookService.register('https://169.254.169.254/', 'key-1', trigger),
    ).toThrow(/allowlist/i);
  });

  it('re-validates the destination on every delivery, not just at registration', async () => {
    const fetchSpy = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchSpy);

    const webhook = webhookService.register('https://hooks.example.com/hook', 'key-1', trigger);
    await webhookService.deliver(webhook, { asset: 'XLM', price: 0.5 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Policy tightens after registration: the stored URL is re-checked.
    config.webhooks.allowedHosts = ['other.example.com'];
    await webhookService.deliver(webhook, { asset: 'XLM', price: 0.5 });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(webhook.lastFailure).toBe('blocked-url');
  });
});

describe('Issue #750: redirects and DNS rebinding cannot bypass egress policy', () => {
  let server: http.Server;
  let port = 0;
  const hits: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits.push(req.url ?? '');
      if (req.url === '/redirect-private') {
        res.writeHead(302, { Location: `http://127.0.0.1:${port}/internal` });
        res.end();
        return;
      }
      if (req.url === '/redirect-metadata') {
        res.writeHead(307, { Location: 'http://169.254.169.254/latest/meta-data/' });
        res.end();
        return;
      }
      if (req.url === '/redirect-allowlisted') {
        res.writeHead(302, { Location: 'https://hooks.example.com/hook' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    hits.length = 0;
    config.webhooks.requireHttps = false;
    config.webhooks.allowPrivateIps = true;
    config.webhooks.maxRetries = 1;
  });

  it('does not follow a redirect to a private destination', async () => {
    const webhook = webhookService.register(`http://127.0.0.1:${port}/redirect-private`, 'key-1', trigger);

    await webhookService.deliver(webhook, { asset: 'XLM', price: 0.5 });

    expect(hits).toContain('/redirect-private');
    expect(hits).not.toContain('/internal');
    expect(webhook.lastFailure).toBe('redirect-not-followed');
  });

  it('does not follow a redirect to the metadata endpoint', async () => {
    const webhook = webhookService.register(`http://127.0.0.1:${port}/redirect-metadata`, 'key-1', trigger);

    await webhookService.deliver(webhook, { asset: 'XLM', price: 0.5 });

    expect(hits).toContain('/redirect-metadata');
    expect(webhook.lastFailure).toBe('redirect-not-followed');
    const [delivery] = webhookService.deliveries(webhook.id);
    expect(delivery.error).not.toMatch(/169\.254|meta-data/);
  });

  it('does not follow a redirect even to an allowlisted destination', async () => {
    config.webhooks.allowedHosts = ['hooks.example.com'];
    const fetchSpy = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchSpy);

    const webhook = registration(`http://127.0.0.1:${port}/redirect-allowlisted`);
    await webhookService.deliver(webhook, { asset: 'XLM', price: 0.5 });

    // Redirects are never followed; the policy is evaluated once per delivery.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(webhook.lastFailure).toBe('redirect-not-followed');
  });

  it('blocks a host whose DNS answer changes to a private address (rebinding)', async () => {
    const fetchSpy = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchSpy);

    // Registration resolves the host to a public address.
    const webhook = webhookService.register('https://rebind.example.com/hook', 'key-1', trigger);
    expect(webhook.url).toBe('https://rebind.example.com/hook');

    // The name now resolves to loopback; delivery must re-resolve and refuse.
    const resolve = vi.fn(async () => ['127.0.0.1']);
    const rebound = registration('https://rebind.example.com/hook');
    await webhookService.deliver(rebound, { asset: 'XLM', price: 0.5 }, { resolve } as never);

    expect(resolve).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(rebound.lastFailure).toBe('blocked-url');
  });
});

describe('Issue #600: error surfaces do not reveal topology', () => {
  beforeEach(() => {
    config.webhooks.maxRetries = 1;
  });

  it('replaces the transport message with a fixed category', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.7:5432'))),
    );

    const webhook = webhookService.register('https://hooks.example.com/hook', 'key-1', trigger);
    await webhookService.deliver(webhook, { asset: 'XLM', price: 0.5 });

    expect(webhook.lastFailure).toBe('network-error');
    expect(webhook.lastFailure).not.toMatch(/10\.0\.0\.7|5432|ECONNREFUSED|at Object\./);

    const [delivery] = webhookService.deliveries(webhook.id);
    expect(delivery.error).toBe('network-error');
    expect(delivery.error).not.toMatch(/10\.0\.0\.7|5432|ECONNREFUSED/);
  });

  it('reports an http status without inventing detail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('nope', { status: 503 }))),
    );

    const webhook = webhookService.register('https://hooks.example.com/hook', 'key-1', trigger);
    await webhookService.deliver(webhook, { asset: 'XLM', price: 0.5 });

    expect(webhook.lastFailure).toBe('HTTP 503');
    const [delivery] = webhookService.deliveries(webhook.id);
    expect(delivery.statusCode).toBe(503);
  });

  it('clears the failure once a delivery succeeds', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
    );

    const webhook = webhookService.register('https://hooks.example.com/hook', 'key-1', trigger);
    webhook.lastFailure = 'network-error';
    webhook.status = 'degraded';

    await webhookService.deliver(webhook, { asset: 'XLM', price: 0.5 });

    expect(webhook.lastFailure).toBeUndefined();
    expect(webhook.status).toBe('healthy');
  });
});
