import { describe, it, expect, afterAll, vi } from 'vitest';
import type { IncomingMessage } from 'http';
import { WsUpgradeGuard } from '../src/infrastructure/upgrade-guard';

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
  wsSubscribeEventsTotal: { inc: vi.fn() },
}));

vi.mock('../src/infrastructure/csrf', () => ({
  isCsrfEnabled: vi.fn(() => false),
  verifyWsCsrfToken: vi.fn(() => true),
}));

vi.mock('../src/governance/ws-signing', () => ({
  verifyWsSignature: vi.fn(() => ({ valid: true })),
}));

vi.mock('../src/infrastructure/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infrastructure/config')>();
  return {
    ...actual,
    config: {
      ...actual.config,
      ws: {
        ...actual.config.ws,
        allowedOrigins: [],
        requireOrigin: false,
        rateLimitMax: 3,
        rateLimitWindowMs: 60000,
        maxConcurrentConnectionsPerIp: 2,
        csrfSecret: '',
        hmacSecret: '',
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
    url: '/',
  } as unknown as IncomingMessage;
}

function verifyWith(
  guard: WsUpgradeGuard,
  req: IncomingMessage,
  origin?: string,
): Promise<{ allow: boolean; code?: number; message?: string }> {
  return new Promise((resolve) => {
    guard.verifyClient({ origin, req, secure: false }, (allow, code, message) =>
      resolve({ allow, code, message }),
    );
  });
}

describe('WsUpgradeGuard — issue #586 acceptance criteria', () => {
  const originalEnv = { ...process.env };

  afterAll(() => {
    process.env = originalEnv;
  });

  it('ignores a spoofed X-Forwarded-For from an untrusted peer (rate-limit bypass proof)', async () => {
    process.env.NODE_ENV = 'production';
    process.env.WS_ALLOW_ALL_ORIGINS = 'true';
    process.env.WS_TRUSTED_PROXY_CIDRS = '10.0.0.0/8';
    const guard = new WsUpgradeGuard();

    // Same socket peer every time, fresh spoofed identity each attempt.
    for (let i = 1; i <= 3; i++) {
      const result = await verifyWith(
        guard,
        makeReq('192.0.2.50', { 'x-forwarded-for': `198.51.100.${i}` }),
      );
      expect(result.allow).toBe(true);
    }
    const fourth = await verifyWith(
      guard,
      makeReq('192.0.2.50', { 'x-forwarded-for': '198.51.100.200' }),
    );
    expect(fourth.allow).toBe(false);
    expect(fourth.code).toBe(429);
  });

  it('honours X-Forwarded-For from a trusted proxy (right-most untrusted hop)', async () => {
    process.env.NODE_ENV = 'production';
    process.env.WS_ALLOW_ALL_ORIGINS = 'true';
    process.env.WS_TRUSTED_PROXY_CIDRS = '10.0.0.0/8, 10.1.0.0/16';
    const guard = new WsUpgradeGuard();

    // Real client 198.51.100.7 behind two trusted proxies; spoofed left-most
    // entries are ignored.
    const a = await verifyWith(
      guard,
      makeReq('10.1.2.3', { 'x-forwarded-for': 'spoofed, 10.0.0.9, 198.51.100.7' }),
    );
    expect(a.allow).toBe(true);
  });

  it('fail-closes when the origin allowlist is empty in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.WS_ALLOW_ALL_ORIGINS = '';
    process.env.WS_TRUSTED_PROXY_CIDRS = '';
    const guard = new WsUpgradeGuard();

    const withOrigin = await verifyWith(guard, makeReq('192.0.2.51'), 'https://evil.example');
    expect(withOrigin.allow).toBe(false);
    expect(withOrigin.code).toBe(403);
  });

  it('requires an explicit opt-in to open the empty allowlist', async () => {
    process.env.NODE_ENV = 'production';
    process.env.WS_ALLOW_ALL_ORIGINS = 'true';
    const guard = new WsUpgradeGuard();

    const result = await verifyWith(guard, makeReq('192.0.2.52'), 'https://anything.example');
    expect(result.allow).toBe(true);
  });

  it('enforces the concurrent connection cap per resolved identity', async () => {
    process.env.NODE_ENV = 'production';
    process.env.WS_ALLOW_ALL_ORIGINS = 'true';
    process.env.WS_TRUSTED_PROXY_CIDRS = '';
    const guard = new WsUpgradeGuard();

    guard.onConnect('192.0.2.60');
    guard.onConnect('192.0.2.60');

    const third = await verifyWith(guard, makeReq('192.0.2.60'), 'https://ok.example');
    expect(third.allow).toBe(false);
    expect(third.code).toBe(429);

    guard.onDisconnect('192.0.2.60');
    const afterRelease = await verifyWith(guard, makeReq('192.0.2.60'), 'https://ok.example');
    expect(afterRelease.allow).toBe(true);
  });

  it('counts rejections by reason and logs the rate-limit identity', async () => {
    process.env.NODE_ENV = 'production';
    process.env.WS_ALLOW_ALL_ORIGINS = '';
    const { wsUpgradeRejectionsTotal } = await import('../src/observability/metrics');
    const { logger } = await import('../src/observability/logger');
    const guard = new WsUpgradeGuard();

    vi.mocked(wsUpgradeRejectionsTotal.inc).mockClear();
    vi.mocked(logger.warn).mockClear();

    await verifyWith(guard, makeReq('192.0.2.70'), 'https://blocked.example');

    expect(wsUpgradeRejectionsTotal.inc).toHaveBeenCalledWith({
      service: 'api',
      reason: 'origin',
    });
    // The logged ip must be the resolved identity (socket address here).
    expect(logger.warn).toHaveBeenCalledWith(
      'WS upgrade rejected',
      expect.objectContaining({ ip: '192.0.2.70', reason: 'origin' }),
    );
  });

  it('uses the shared core so policy cannot diverge from the aggregator guard', async () => {
    const { WsGuardCore } = await import('@stellar-oracle/ws-guard');
    const guard = new WsUpgradeGuard();

    expect((guard as unknown as { core: WsGuardCore }).core).toBeInstanceOf(WsGuardCore);
  });
});
