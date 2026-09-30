import { describe, it, expect, afterAll, vi } from 'vitest';
import type { IncomingMessage } from 'http';
import WebSocket from 'ws';
import { WsConnectionGuard } from '../src/infrastructure/ws-guard';

vi.mock('../src/observability/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../src/observability/metrics', () => ({
  wsUpgradeRejectionsTotal: { inc: vi.fn() },
  wsConnectionsActive: { inc: vi.fn(), dec: vi.fn() },
  wsConnectionsTotal: { inc: vi.fn() },
  wsMessagesTotal: { inc: vi.fn() },
  wsConnectionDuration: { observe: vi.fn() },
  wsErrorsTotal: { inc: vi.fn() },
}));

vi.mock('../src/infrastructure/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infrastructure/config')>();
  return {
    ...actual,
    config: {
      ...actual.config,
      security: {
        ...actual.config.security,
        websocket: {
          allowedOrigins: [],
          requireOrigin: false,
          maxConnectionsPerWindow: 3,
          rateLimitWindowMs: 60000,
        },
      },
    },
  };
});

function makeReq(
  remoteAddress: string,
  headers: Record<string, string | string[] | undefined> = {},
): IncomingMessage {
  return {
    socket: { remoteAddress },
    headers,
  } as unknown as IncomingMessage;
}

function verifyWith(
  guard: WsConnectionGuard,
  req: IncomingMessage,
  origin?: string,
): Promise<{ allow: boolean; code?: number; message?: string }> {
  return new Promise((resolve) => {
    guard.verifyClient({ origin, req, secure: false }, (allow, code, message) =>
      resolve({ allow, code, message }),
    );
  });
}

describe('WsConnectionGuard — issue #586 acceptance criteria', () => {
  const originalEnv = { ...process.env };

  afterAll(() => {
    process.env = originalEnv;
  });

  it('ignores a spoofed X-Forwarded-For from an untrusted peer', async () => {
    process.env.NODE_ENV = 'production';
    process.env.WS_ALLOW_ALL_ORIGINS = 'true';
    process.env.WS_TRUSTED_PROXY_CIDRS = '10.0.0.0/8';
    const guard = new WsConnectionGuard();

    const first = await verifyWith(guard, makeReq('203.0.113.9', { 'x-forwarded-for': '1.1.1.1' }));
    expect(first.allow).toBe(true);

    // Attacker varies the header on every connection, but the identity stays
    // the socket address, so the rate-limit bucket fills up after 3 attempts.
    for (let i = 2; i <= 3; i++) {
      const result = await verifyWith(
        guard,
        makeReq('203.0.113.9', { 'x-forwarded-for': `10.9.9.${i}` }),
      );
      expect(result.allow).toBe(true);
    }
    const fourth = await verifyWith(
      guard,
      makeReq('203.0.113.9', { 'x-forwarded-for': '10.9.9.99' }),
    );
    expect(fourth.allow).toBe(false);
    expect(fourth.code).toBe(429);
  });

  it('honours X-Forwarded-For from a trusted proxy', async () => {
    process.env.NODE_ENV = 'production';
    process.env.WS_ALLOW_ALL_ORIGINS = 'true';
    process.env.WS_TRUSTED_PROXY_CIDRS = '10.0.0.0/8';
    const guard = new WsConnectionGuard();

    // Trusted proxy peer: the right-most untrusted hop is the identity, so
    // distinct real clients get distinct buckets even through one proxy IP.
    const a = await verifyWith(guard, makeReq('10.0.0.5', { 'x-forwarded-for': 'spoof, 198.51.100.1' }));
    const b = await verifyWith(guard, makeReq('10.0.0.5', { 'x-forwarded-for': 'spoof2, 198.51.100.1' }));
    const c = await verifyWith(guard, makeReq('10.0.0.5', { 'x-forwarded-for': 'x, 198.51.100.2' }));
    expect(a.allow).toBe(true);
    expect(b.allow).toBe(true);
    expect(c.allow).toBe(true);
  });

  it('fail-closes when the origin allowlist is empty in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.WS_ALLOW_ALL_ORIGINS = '';
    process.env.WS_TRUSTED_PROXY_CIDRS = '';
    const guard = new WsConnectionGuard();

    const result = await verifyWith(guard, makeReq('203.0.113.10'), 'https://example.com');
    expect(result.allow).toBe(false);
    expect(result.code).toBe(403);

    // Omitting the Origin header entirely must not bypass the fail-close.
    const noOrigin = await verifyWith(guard, makeReq('203.0.113.12'));
    expect(noOrigin.allow).toBe(false);
  });

  it('allows an explicit WS_ALLOW_ALL_ORIGINS=true opt-in in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.WS_ALLOW_ALL_ORIGINS = 'true';
    const guard = new WsConnectionGuard();

    const result = await verifyWith(guard, makeReq('203.0.113.77'), 'https://example.com');
    expect(result.allow).toBe(true);
  });

  it('rejects missing Origin when requireOrigin is enabled', async () => {
    process.env.NODE_ENV = 'production';
    process.env.WS_ALLOW_ALL_ORIGINS = '';
    const guard = new WsConnectionGuard();

    const result = await verifyWith(guard, makeReq('203.0.113.11'));
    expect(result.allow).toBe(false);
    expect([403]).toContain(result.code);
  });

  it('counts upgrade rejections by reason', async () => {
    process.env.NODE_ENV = 'production';
    process.env.WS_ALLOW_ALL_ORIGINS = '';
    const guard = new WsConnectionGuard();
    const { wsUpgradeRejectionsTotal } = await import('../src/observability/metrics');

    vi.mocked(wsUpgradeRejectionsTotal.inc).mockClear();

    await verifyWith(guard, makeReq('203.0.113.20'), 'https://not-allowed.example');
    await verifyWith(guard, makeReq('203.0.113.21'), 'https://not-allowed.example');

    expect(wsUpgradeRejectionsTotal.inc).toHaveBeenCalledWith({
      service: 'aggregator',
      reason: 'origin',
    });
    expect(wsUpgradeRejectionsTotal.inc).toHaveBeenCalledTimes(2);
  });

  it('accepts upgrades over a real socket when the policy allows', async () => {
    // End-to-end: a real ws server on a test port with a permissive config.
    const { WebSocketServer } = await import('../src/infrastructure/ws-server');
    process.env.NODE_ENV = 'test';
    process.env.WS_ALLOW_ALL_ORIGINS = 'true';
    const server = new WebSocketServer(9400);
    server.start();
    try {
      const client = new WebSocket('ws://localhost:9401', {
        origin: 'https://example.com',
      });
      await new Promise<void>((resolve, reject) => {
        client.on('open', () => resolve());
        client.on('error', (err) => reject(err));
      });
      client.close();
    } finally {
      server.stop();
    }
  }, 15000);
});
