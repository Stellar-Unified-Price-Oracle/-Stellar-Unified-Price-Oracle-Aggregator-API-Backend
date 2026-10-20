import { describe, it, expect } from 'vitest';
import {
  loadTelemetryPolicy,
  truncateIp,
  minimizeIp,
  redactQuery,
  containsIdentifier,
  DEFAULT_RETENTION_DAYS,
} from '../src/privacy/telemetryMinimizer';

describe('telemetry minimizer', () => {
  it('defaults to truncated IPs and 30 day retention', () => {
    const p = loadTelemetryPolicy({} as NodeJS.ProcessEnv);
    expect(p.ip).toBe('truncate');
    expect(p.retentionDays).toBe(DEFAULT_RETENTION_DAYS);
  });

  it('ignores invalid configuration', () => {
    const p = loadTelemetryPolicy({ TELEMETRY_IP_MODE: 'bogus', TELEMETRY_RETENTION_DAYS: '-3' } as unknown as NodeJS.ProcessEnv);
    expect(p.ip).toBe('truncate');
    expect(p.retentionDays).toBe(DEFAULT_RETENTION_DAYS);
  });

  it('truncates IPv4, mapped IPv4 and IPv6', () => {
    expect(truncateIp('203.0.113.77')).toBe('203.0.113.0');
    expect(truncateIp('::ffff:203.0.113.77')).toBe('203.0.113.0');
    expect(truncateIp('2001:db8:abcd:12::1')).toBe('2001:db8:abcd::');
  });

  it('handles missing and malformed IPs', () => {
    expect(truncateIp(undefined)).toBe('unknown');
    expect(truncateIp('not-an-ip')).toBe('unknown');
  });

  it('drop mode emits nothing; full mode is explicit opt-in', () => {
    expect(minimizeIp('1.2.3.4', { ...loadTelemetryPolicy({} as NodeJS.ProcessEnv), ip: 'drop' })).toBeUndefined();
    expect(minimizeIp('1.2.3.4', { ...loadTelemetryPolicy({} as NodeJS.ProcessEnv), ip: 'full' })).toBe('1.2.3.4');
  });

  it('hash mode is salted and falls back to truncation without a salt', () => {
    const base = loadTelemetryPolicy({} as NodeJS.ProcessEnv);
    const a = minimizeIp('1.2.3.4', { ...base, ip: 'hash', hashSalt: 's1' });
    const b = minimizeIp('1.2.3.4', { ...base, ip: 'hash', hashSalt: 's2' });
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
    expect(minimizeIp('1.2.3.4', { ...base, ip: 'hash' })).toBe('1.2.3.0');
  });

  it('redacts sensitive query keys case-insensitively without mutating input', () => {
    const q = { API_KEY: 'sk_abcdefabcdefabcdef', asset: 'XLM', Token: 'x' };
    const out = redactQuery(q);
    expect(out).toEqual({ API_KEY: '[redacted]', asset: 'XLM', Token: '[redacted]' });
    expect(q.API_KEY).toBe('sk_abcdefabcdefabcdef');
  });

  it('supports operator-added sensitive keys and non-object queries', () => {
    const p = loadTelemetryPolicy({ TELEMETRY_SENSITIVE_QUERY_KEYS: 'Wallet' } as unknown as NodeJS.ProcessEnv);
    expect(redactQuery({ wallet: 'G...' }, p)).toEqual({ wallet: '[redacted]' });
    expect(redactQuery(null)).toEqual({});
  });

  it('flags unmasked identifiers in emitted text', () => {
    expect(containsIdentifier('ip=203.0.113.77')).toBe(true);
    expect(containsIdentifier('ip=203.0.113.0')).toBe(false);
    expect(containsIdentifier('k=sk_abcdefabcdefabcdef')).toBe(true);
    expect(containsIdentifier('asset=XLM')).toBe(false);
  });
});
