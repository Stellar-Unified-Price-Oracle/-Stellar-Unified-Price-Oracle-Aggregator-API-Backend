import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SourceCircuitBreaker } from '../src/price-aggregation/source-circuit-breaker';
import {
  isPrivateIp,
  validateOutboundUrl,
  SsrfError,
  getSecureAgents,
} from '../src/infrastructure/ssrf';

describe('SourceCircuitBreaker', () => {
  let cb: SourceCircuitBreaker;

  beforeEach(() => {
    vi.useFakeTimers();
    cb = new SourceCircuitBreaker({ failureThreshold: 3, cooldownMs: 10_000, halfOpenSuccesses: 2 });
  });

  it('starts closed and allows requests', () => {
    expect(cb.isAllowed('chainlink')).toBe(true);
    expect(cb.getStatus('chainlink').state).toBe('CLOSED');
  });

  it('resets the failure count after a success in closed state', () => {
    cb.recordFailure('redstone');
    cb.recordFailure('redstone');
    cb.recordSuccess('redstone');
    expect(cb.getStatus('redstone').failures).toBe(0);
  });

  it('trips open after the failure threshold', () => {
    cb.recordFailure('band');
    cb.recordFailure('band');
    expect(cb.isAllowed('band')).toBe(true);
    cb.recordFailure('band');
    expect(cb.getStatus('band').state).toBe('OPEN');
    expect(cb.getStatus('band').totalTrips).toBe(1);
    expect(cb.isAllowed('band')).toBe(false);
  });

  it('transitions to half-open after the cooldown elapses', () => {
    cb.recordFailure('reflector');
    cb.recordFailure('reflector');
    cb.recordFailure('reflector');
    expect(cb.isAllowed('reflector')).toBe(false);

    vi.advanceTimersByTime(10_000);
    expect(cb.isAllowed('reflector')).toBe(true);
    expect(cb.getStatus('reflector').state).toBe('HALF_OPEN');
  });

  it('recovers to closed after enough half-open successes', () => {
    cb.recordFailure('chainlink');
    cb.recordFailure('chainlink');
    cb.recordFailure('chainlink');
    vi.advanceTimersByTime(10_000);
    cb.isAllowed('chainlink'); // -> HALF_OPEN

    cb.recordSuccess('chainlink');
    expect(cb.getStatus('chainlink').state).toBe('HALF_OPEN');
    cb.recordSuccess('chainlink');
    expect(cb.getStatus('chainlink').state).toBe('CLOSED');
    expect(cb.getStatus('chainlink').failures).toBe(0);
  });

  it('re-trips open on a half-open failure', () => {
    cb.recordFailure('band');
    cb.recordFailure('band');
    cb.recordFailure('band');
    vi.advanceTimersByTime(10_000);
    cb.isAllowed('band');

    cb.recordFailure('band');
    expect(cb.getStatus('band').state).toBe('OPEN');
    expect(cb.getStatus('band').totalTrips).toBe(2);
  });

  it('reports status for all tracked sources', () => {
    cb.recordFailure('a');
    cb.recordFailure('b');
    const all = cb.getAllStatuses();
    expect(Object.keys(all).sort()).toEqual(['a', 'b']);
    expect(all.a.failures).toBe(1);
  });
});

describe('SSRF protection', () => {
  it('blocks private, loopback, and link-local IPv4 ranges', () => {
    expect(isPrivateIp('10.0.0.1')).toBe(true);
    expect(isPrivateIp('172.16.5.5')).toBe(true);
    expect(isPrivateIp('192.168.1.1')).toBe(true);
    expect(isPrivateIp('127.0.0.1')).toBe(true);
    expect(isPrivateIp('169.254.169.254')).toBe(true); // cloud metadata
    expect(isPrivateIp('0.0.0.0')).toBe(true);
  });

  it('allows public IPv4 addresses', () => {
    expect(isPrivateIp('8.8.8.8')).toBe(false);
    expect(isPrivateIp('1.1.1.1')).toBe(false);
    expect(isPrivateIp('104.16.132.229')).toBe(false);
  });

  it('blocks IPv6 loopback, ULA, link-local, and multicast', () => {
    expect(isPrivateIp('::1')).toBe(true);
    expect(isPrivateIp('::')).toBe(true);
    expect(isPrivateIp('fc00::1')).toBe(true);
    expect(isPrivateIp('fd12::1')).toBe(true);
    expect(isPrivateIp('fe80::1')).toBe(true);
    expect(isPrivateIp('ff02::1')).toBe(true);
  });

  it('rejects IPv4-mapped IPv6 that embeds a private address', () => {
    expect(isPrivateIp('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateIp('::ffff:8.8.8.8')).toBe(false);
  });

  it('treats unparseable input as unsafe', () => {
    expect(isPrivateIp('not-an-ip')).toBe(true);
  });

  it('rejects malformed URLs and non-http(s) protocols', () => {
    expect(() => validateOutboundUrl('not a url')).toThrow(SsrfError);
    expect(() => validateOutboundUrl('file:///etc/passwd')).toThrowError(/protocol/i);
    expect(() => validateOutboundUrl('ftp://example.com/x')).toThrowError(/protocol/i);
  });

  it('rejects hosts outside the allowlist', () => {
    expect(() => validateOutboundUrl('https://totally-not-in-allowlist.example.com/path')).toThrowError(
      /allowlist/i,
    );
  });



  it('provides cached secure HTTP/HTTPS agents', () => {
    const { httpAgent, httpsAgent } = getSecureAgents();
    expect(httpAgent).toBeDefined();
    expect(httpsAgent).toBeDefined();
    const again = getSecureAgents();
    expect(again.httpAgent).toBe(httpAgent);
  });
});
