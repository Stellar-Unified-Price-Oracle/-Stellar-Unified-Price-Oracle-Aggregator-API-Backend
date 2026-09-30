import { describe, it, expect } from 'vitest';
import {
  WsGuardCore,
  isIpInAnyCidr,
  originMatches,
  parseCidr,
  type WsGuardConfig,
} from '../src/index';
import type { IncomingMessage } from 'http';

function baseConfig(overrides: Partial<WsGuardConfig> = {}): WsGuardConfig {
  return {
    allowedOrigins: [],
    requireOrigin: true,
    allowAllOrigins: false,
    isProduction: true,
    trustedProxyCidrs: [],
    maxForwardedHops: 64,
    rateLimitMax: 3,
    rateLimitWindowMs: 60000,
    ...overrides,
  };
}

function makeReq(
  remoteAddress: string,
  headers: Record<string, string | string[] | undefined> = {},
): IncomingMessage {
  return {
    socket: { remoteAddress },
    headers,
  } as unknown as IncomingMessage;
}

describe('WsGuardCore — trusted proxy identity resolution (#586)', () => {
  it('ignores X-Forwarded-For when the peer is not a trusted proxy', () => {
    const core = new WsGuardCore(
      baseConfig({ trustedProxyCidrs: ['10.0.0.0/8'] }),
    );
    const req = makeReq('203.0.113.50', {
      'x-forwarded-for': '1.2.3.4',
    });

    expect(core.resolveClientIp(req)).toBe('203.0.113.50');
  });

  it('ignores forwarded headers when no trusted proxies are configured', () => {
    const core = new WsGuardCore(baseConfig());
    const req = makeReq('203.0.113.50', {
      'x-forwarded-for': '1.2.3.4, 5.6.7.8',
      forwarded: 'for=9.9.9.9',
    });

    expect(core.resolveClientIp(req)).toBe('203.0.113.50');
  });

  it('honours X-Forwarded-For from a trusted proxy, taking the right-most untrusted hop', () => {
    const core = new WsGuardCore(
      baseConfig({ trustedProxyCidrs: ['10.0.0.0/8'] }),
    );
    // Proxy chain: client (198.51.100.7) -> trusted proxy -> our server.
    // The left-most entry is client-supplied garbage; right-most untrusted is real.
    const req = makeReq('10.1.2.3', {
      'x-forwarded-for': '6.6.6.6, 198.51.100.7',
    });

    expect(core.resolveClientIp(req)).toBe('198.51.100.7');
  });

  it('spoofing proof: the same attacker cannot mint a fresh identity per connection', () => {
    const core = new WsGuardCore(
      baseConfig({ trustedProxyCidrs: ['172.16.0.0/12'], rateLimitMax: 3 }),
    );
    // Attacker connects directly (no proxy in between) and varies the header.
    for (let i = 0; i < 10; i++) {
      const req = makeReq('192.0.2.9', {
        'x-forwarded-for': `198.51.100.${i}`,
      });
      expect(core.resolveClientIp(req)).toBe('192.0.2.9');
    }
  });

  it('walks the full chained-proxy case and falls back to the first hop', () => {
    const core = new WsGuardCore(
      baseConfig({ trustedProxyCidrs: ['10.0.0.0/8'] }),
    );
    // Both hops are trusted proxies — the identity is the last (client-most) hop.
    const req = makeReq('10.0.0.1', {
      'x-forwarded-for': '198.51.100.7, 10.0.0.2',
    });

    expect(core.resolveClientIp(req)).toBe('198.51.100.7');
  });

  it('supports the RFC 7239 Forwarded header from a trusted proxy', () => {
    const core = new WsGuardCore(
      baseConfig({ trustedProxyCidrs: ['10.0.0.0/8'] }),
    );
    const req = makeReq('10.1.2.3', {
      forwarded: 'for=6.6.6.6, for="198.51.100.7"',
    });

    expect(core.resolveClientIp(req)).toBe('198.51.100.7');
  });

  it('handles IPv6 peers and IPv4-mapped forwarded values', () => {
    const core = new WsGuardCore(
      baseConfig({ trustedProxyCidrs: ['fd00::/8'] }),
    );
    const req = makeReq('fd00::1', {
      'x-forwarded-for': '198.51.100.7',
    });

    expect(core.resolveClientIp(req)).toBe('198.51.100.7');
  });
});

describe('CIDR matching helpers (#586)', () => {
  it('matches IPv4 CIDR ranges', () => {
    expect(isIpInAnyCidr('10.1.2.3', ['10.0.0.0/8'])).toBe(true);
    expect(isIpInAnyCidr('11.1.2.3', ['10.0.0.0/8'])).toBe(false);
    expect(isIpInAnyCidr('192.168.1.20', ['192.168.1.0/24'])).toBe(true);
    expect(isIpInAnyCidr('192.168.2.20', ['192.168.1.0/24'])).toBe(false);
  });

  it('matches IPv6 CIDR ranges', () => {
    expect(isIpInAnyCidr('fd00::1', ['fd00::/8'])).toBe(true);
    expect(isIpInAnyCidr('fe80::1', ['fd00::/8'])).toBe(false);
    expect(isIpInAnyCidr('2001:db8:1234:5678::1', ['2001:db8::/32'])).toBe(true);
  });

  it('treats IPv4-mapped IPv6 peers as IPv4', () => {
    expect(isIpInAnyCidr('::ffff:10.1.2.3', ['10.0.0.0/8'])).toBe(true);
  });

  it('rejects malformed CIDRs safely (never matches)', () => {
    expect(isIpInAnyCidr('10.1.2.3', ['not-a-cidr'])).toBe(false);
    expect(isIpInAnyCidr('10.1.2.3', ['10.0.0.0/33'])).toBe(false);
    expect(parseCidr('10.0.0.0/33')).toBeNull();
    expect(parseCidr('banana')).toBeNull();
  });
});

describe('Origin policy (#586)', () => {
  it('fail-closes when the allowlist is empty in production', () => {
    const core = new WsGuardCore(baseConfig({ isProduction: true }));
    expect(core.checkOrigin('https://evil.example').allowed).toBe(false);
    expect(core.checkOrigin('https://example.com').allowed).toBe(false);
  });

  it('allows all origins outside production when the allowlist is empty', () => {
    const core = new WsGuardCore(baseConfig({ isProduction: false }));
    expect(core.checkOrigin('https://anything.dev').allowed).toBe(true);
  });

  it('allows all origins in production only with the explicit opt-in', () => {
    const core = new WsGuardCore(
      baseConfig({ isProduction: true, allowAllOrigins: true }),
    );
    expect(core.checkOrigin('https://anything.dev').allowed).toBe(true);
  });

  it('matches exact origins and rejects same-suffix lookalikes', () => {
    const core = new WsGuardCore(
      baseConfig({ allowedOrigins: ['https://app.example.com'] }),
    );
    expect(core.checkOrigin('https://app.example.com').allowed).toBe(true);
    expect(core.checkOrigin('https://evil-app.example.com').allowed).toBe(false);
    expect(core.checkOrigin('https://app.example.com.evil.io').allowed).toBe(false);
  });

  it('supports explicit wildcard subdomain patterns', () => {
    const core = new WsGuardCore(
      baseConfig({
        allowedOrigins: ['https://*.example.com', 'https://example.com'],
      }),
    );
    expect(core.checkOrigin('https://app.example.com').allowed).toBe(true);
    expect(core.checkOrigin('https://a.b.example.com').allowed).toBe(true);
    expect(core.checkOrigin('https://example.com').allowed).toBe(true);
    expect(core.checkOrigin('https://evilexample.com').allowed).toBe(false);
    expect(core.checkOrigin('http://app.example.com').allowed).toBe(false);
  });

  it('requires the Origin header when requireOrigin is set', () => {
    const core = new WsGuardCore(baseConfig({ requireOrigin: true }));
    const result = core.checkOrigin(undefined);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('origin-required');
  });

  it('permits non-browser clients without Origin when a deliberate policy exists', () => {
    // With a configured allowlist, a missing Origin (non-browser client) is fine.
    const allowlisted = new WsGuardCore(
      baseConfig({ requireOrigin: false, allowedOrigins: ['https://app.example.com'] }),
    );
    expect(allowlisted.checkOrigin(undefined).allowed).toBe(true);

    // With the explicit opt-in, likewise.
    const optedIn = new WsGuardCore(
      baseConfig({ requireOrigin: false, allowAllOrigins: true }),
    );
    expect(optedIn.checkOrigin(undefined).allowed).toBe(true);
  });

  it('fail-closes a missing Origin in production with an empty allowlist (bypass prevention)', () => {
    const core = new WsGuardCore(baseConfig({ requireOrigin: false }));
    const result = core.checkOrigin(undefined);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('origin');
  });

  it('originMatches: exact match only for non-wildcard entries', () => {
    expect(originMatches('https://a.com', 'https://a.com')).toBe(true);
    expect(originMatches('https://a.com', 'https://b.com')).toBe(false);
    expect(originMatches('https://a.com', '*')).toBe(true);
  });
});

describe('Rate limiting and rejection accounting (#586)', () => {
  it('rate-limits by resolved identity', () => {
    const core = new WsGuardCore(
      baseConfig({
        trustedProxyCidrs: ['10.0.0.0/8'],
        rateLimitMax: 3,
      }),
    );
    const reqFor = (xff: string) => makeReq('10.0.0.9', { 'x-forwarded-for': xff });

    // Three different spoofed identities, one real bucket (peer + right-most hop).
    expect(core.checkRateLimit(core.resolveClientIp(reqFor('9.9.9.9, 198.51.100.1')))).toBe(true);
    expect(core.checkRateLimit(core.resolveClientIp(reqFor('8.8.8.8, 198.51.100.1')))).toBe(true);
    expect(core.checkRateLimit(core.resolveClientIp(reqFor('7.7.7.7, 198.51.100.1')))).toBe(true);
    expect(core.checkRateLimit(core.resolveClientIp(reqFor('6.6.6.6, 198.51.100.1')))).toBe(false);
  });

  it('counts rejections by reason', () => {
    const core = new WsGuardCore(baseConfig());
    core.reject({ reason: 'rate-limit', code: 429, message: 'x', clientIp: '1.2.3.4' });
    core.reject({ reason: 'rate-limit', code: 429, message: 'x', clientIp: '1.2.3.4' });
    core.reject({ reason: 'origin', code: 403, message: 'x', clientIp: '1.2.3.4' });

    const counts = core.getRejectionCounts();
    expect(counts.find((c) => c.reason === 'rate-limit')?.count).toBe(2);
    expect(counts.find((c) => c.reason === 'origin')?.count).toBe(1);
  });

  it('tracks concurrent connection counts per IP', () => {
    const core = new WsGuardCore(baseConfig());
    core.onConnect('1.2.3.4');
    core.onConnect('1.2.3.4');
    expect(core.getConnectionCount('1.2.3.4')).toBe(2);
    core.onDisconnect('1.2.3.4');
    core.onDisconnect('1.2.3.4');
    expect(core.getConnectionCount('1.2.3.4')).toBe(0);
  });
});
