import { describe, it, expect, vi } from 'vitest';

describe('SSRF private-IP rejection (allowlisted literal)', () => {
  it('blocks private IP literals even when allowlisted, when private IPs are disallowed', async () => {
    vi.doMock('../src/infrastructure/config', () => ({
      config: {
        security: {
          ssrf: {
            enabled: true,
            allowedHosts: ['127.0.0.1', '10.0.0.5', '8.8.8.8'],
            allowPrivateIps: false,
            requestTimeoutMs: 10000,
          },
        },
      },
    }));

    const mod = await import('../src/infrastructure/ssrf');

    expect(mod.isPrivateIp('127.0.0.1')).toBe(true);
    expect(() => mod.validateOutboundUrl('http://127.0.0.1/price')).toThrowError(/private/i);
    expect(() => mod.validateOutboundUrl('http://10.0.0.5/price')).toThrowError(/private/i);
    // Public allowlisted literal passes.
    expect(mod.validateOutboundUrl('https://8.8.8.8/path').hostname).toBe('8.8.8.8');
  });

  it('allows private IP literals when allowPrivateIps is enabled', async () => {
    vi.resetModules();
    vi.doMock('../src/infrastructure/config', () => ({
      config: {
        security: {
          ssrf: {
            enabled: true,
            allowedHosts: ['127.0.0.1'],
            allowPrivateIps: true,
            requestTimeoutMs: 10000,
          },
        },
      },
    }));

    const mod = await import('../src/infrastructure/ssrf');
    expect(mod.validateOutboundUrl('http://127.0.0.1/price').hostname).toBe('127.0.0.1');
  });
});
