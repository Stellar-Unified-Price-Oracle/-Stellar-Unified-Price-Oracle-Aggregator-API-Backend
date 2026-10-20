import { describe, it, expect, vi, afterEach } from 'vitest';
import dns from 'dns';
import {
  SsrfError,
  createSecureLookup,
  isForbiddenHostname,
  isPrivateIp,
  validateOutboundUrl,
  verifyOutboundDestination,
} from '@stellar-oracle/ssrf-guard';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isPrivateIp', () => {
  it('blocks private, loopback, link-local and metadata IPv4 ranges', () => {
    for (const ip of [
      '10.0.0.1',
      '172.16.5.5',
      '192.168.1.1',
      '127.0.0.1',
      '169.254.169.254',
      '0.0.0.0',
      '100.64.0.1',
      '240.0.0.1',
    ]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });

  it('allows public IPv4 addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '104.16.132.229']) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });

  it('blocks IPv6 loopback, ULA, link-local and multicast', () => {
    for (const ip of ['::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1']) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });

  it('unwraps IPv4-mapped IPv6', () => {
    expect(isPrivateIp('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateIp('::ffff:8.8.8.8')).toBe(false);
  });

  it('treats unparseable input as unsafe', () => {
    expect(isPrivateIp('not-an-ip')).toBe(true);
  });
});

describe('isForbiddenHostname', () => {
  it('catches loopback, metadata and in-cluster names', () => {
    for (const host of [
      'localhost',
      'LOCALHOST.',
      'api.localhost',
      'metadata.google.internal',
      'metadata',
      'kubernetes.default.svc',
      'oracle.default.svc.cluster.local',
      'api.internal',
      'router.lan',
      'host.docker.internal',
    ]) {
      expect(isForbiddenHostname(host), host).toBe(true);
    }
  });

  it('leaves public hostnames alone', () => {
    for (const host of ['hooks.example.com', 'example.com', 'api.example.org']) {
      expect(isForbiddenHostname(host), host).toBe(false);
    }
  });
});

describe('validateOutboundUrl', () => {
  it('rejects malformed URLs and non-http(s) protocols', () => {
    expect(() => validateOutboundUrl('not a url')).toThrow(SsrfError);
    expect(() => validateOutboundUrl('file:///etc/passwd')).toThrow(/protocol/i);
    expect(() => validateOutboundUrl('ftp://example.com/x')).toThrow(/protocol/i);
  });

  it('requires https when the policy says so', () => {
    expect(() => validateOutboundUrl('http://hooks.example.com/x', { requireHttps: true })).toThrow(
      /https/i,
    );
    expect(validateOutboundUrl('https://hooks.example.com/x', { requireHttps: true })).toBeTruthy();
    expect(validateOutboundUrl('http://hooks.example.com/x')).toBeTruthy();
  });

  it('rejects every private and internal destination shape', () => {
    const cases: Array<[string, string]> = [
      ['https://169.254.169.254/latest/meta-data/', 'private-ip'],
      ['https://127.0.0.1:5432/admin', 'private-ip'],
      ['https://10.0.0.5/', 'private-ip'],
      ['https://172.16.0.1/', 'private-ip'],
      ['https://[::1]/', 'private-ip'],
      // WHATWG parses these decimal/hex/octal forms down to 127.0.0.1.
      ['https://2130706433/', 'private-ip'],
      ['https://0x7f.1/', 'private-ip'],
      ['https://localhost/', 'forbidden-host'],
      ['https://metadata.google.internal/', 'forbidden-host'],
      ['https://oracle.default.svc.cluster.local/', 'forbidden-host'],
      ['https://host.docker.internal/', 'forbidden-host'],
    ];

    for (const [url, reason] of cases) {
      let thrown: unknown;
      try {
        validateOutboundUrl(url, { requireHttps: false });
      } catch (err) {
        thrown = err;
      }
      expect(thrown, url).toBeInstanceOf(SsrfError);
      expect((thrown as SsrfError).reason, url).toBe(reason);
    }
  });

  it('lets a private destination through only when explicitly allowed', () => {
    expect(validateOutboundUrl('https://127.0.0.1/hook', { allowPrivateIps: true })).toBeTruthy();
    expect(validateOutboundUrl('https://localhost/hook', { allowPrivateIps: true })).toBeTruthy();
    expect(validateOutboundUrl('https://[::1]/hook', { allowPrivateIps: true })).toBeTruthy();
  });

  it('enforces an exact-host allowlist', () => {
    const policy = { allowedHosts: ['hooks.example.com'] };
    expect(validateOutboundUrl('https://hooks.example.com/x', policy)).toBeTruthy();
    expect(() => validateOutboundUrl('https://evil.example.com/x', policy)).toThrow(/allowlist/i);
    expect(() => validateOutboundUrl('https://hooksexample.com/x', policy)).toThrow(/allowlist/i);
    // An allowlisted private literal is still refused.
    expect(() =>
      validateOutboundUrl('https://169.254.169.254/', {
        allowedHosts: ['169.254.169.254'],
      }),
    ).toThrow(/private/i);
  });

  it('never reports anything but a property of the caller URL', () => {
    try {
      validateOutboundUrl('https://169.254.169.254/latest/meta-data/');
      throw new Error('expected a rejection');
    } catch (err) {
      const ssrf = err as SsrfError;
      expect(ssrf.reason).toBe('private-ip');
      expect(ssrf.url).toBe('https://169.254.169.254/latest/meta-data/');
    }
  });
});

describe('createSecureLookup (connect-time pinning)', () => {
  function stubResolution(addresses: Array<{ address: string; family: number }>): void {
    vi.spyOn(dns, 'lookup').mockImplementation(((
      _hostname: string,
      _options: unknown,
      callback: (err: unknown, addrs: unknown, family: number) => void,
    ) => {
      callback(null, addresses, 0);
    }) as never);
  }

  it('refuses an answer that points at the metadata endpoint', () => {
    stubResolution([{ address: '169.254.169.254', family: 4 }]);

    const onBlocked = vi.fn();
    const lookup = createSecureLookup({
      getPolicy: () => ({ allowPrivateIps: false }),
      onBlocked,
    });

    let captured: unknown;
    lookup('evil.example.com', { all: true }, (err, address) => {
      captured = { err, address };
    });

    const { err, address } = captured as { err: SsrfError; address: unknown };
    expect(err).toBeInstanceOf(SsrfError);
    expect(err.reason).toBe('dns-rebinding');
    // The socket is never opened, so no address is handed back.
    expect(address).toBe('');
    expect(onBlocked).toHaveBeenCalledWith({
      host: 'evil.example.com',
      addresses: ['169.254.169.254'],
      reason: 'dns-rebinding',
    });
  });

  it('passes a public answer back in the shape that was requested', () => {
    stubResolution([{ address: '93.184.216.34', family: 4 }]);

    const lookup = createSecureLookup({ getPolicy: () => ({ allowPrivateIps: false }) });

    const all: { err: unknown; address: unknown } = { err: null, address: null };
    lookup('example.com', { all: true }, (err, address) => {
      all.err = err;
      all.address = address;
    });
    expect(all.err).toBeNull();
    expect(all.address).toEqual([{ address: '93.184.216.34', family: 4 }]);

    const single: { err: unknown; address: unknown; family: number } = {
      err: null,
      address: null,
      family: 0,
    };
    lookup('example.com', {}, (err, address, family) => {
      single.err = err;
      single.address = address;
      single.family = family;
    });
    expect(single.err).toBeNull();
    expect(single.address).toBe('93.184.216.34');
    expect(single.family).toBe(4);
  });

  it('drops private answers from a mixed public/private response', () => {
    stubResolution([
      { address: '10.0.0.9', family: 4 },
      { address: '93.184.216.34', family: 4 },
    ]);

    const lookup = createSecureLookup({ getPolicy: () => ({ allowPrivateIps: false }) });

    let address: unknown;
    lookup('example.com', { all: true }, (_err, addrs) => {
      address = addrs;
    });
    expect(address).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('permits private answers only when the policy allows them', () => {
    stubResolution([{ address: '127.0.0.1', family: 4 }]);

    const lookup = createSecureLookup({ getPolicy: () => ({ allowPrivateIps: true }) });

    let address: unknown;
    lookup('localhost', { all: true }, (err, addrs) => {
      expect(err).toBeNull();
      address = addrs;
    });
    expect(address).toEqual([{ address: '127.0.0.1', family: 4 }]);
  });

  it('reads the policy on every resolution', () => {
    stubResolution([{ address: '127.0.0.1', family: 4 }]);

    let allowPrivate = false;
    const lookup = createSecureLookup({ getPolicy: () => ({ allowPrivateIps: allowPrivate }) });

    let first: unknown;
    lookup('localhost', { all: true }, (err) => {
      first = err;
    });
    expect(first).toBeInstanceOf(SsrfError);

    allowPrivate = true;
    let second: unknown = 'unset';
    lookup('localhost', { all: true }, (err) => {
      second = err;
    });
    expect(second).toBeNull();
  });
});

describe('verifyOutboundDestination (deployment policy)', () => {
  function stubResolution(addresses: Array<{ address: string; family: number }>): void {
    vi.spyOn(dns, 'lookup').mockImplementation(((
      _hostname: string,
      _options: unknown,
      callback: (err: unknown, addrs: unknown, family: number) => void,
    ) => {
      callback(null, addresses, 0);
    }) as never);
  }

  const deploymentPolicy = {
    requireHttps: true,
    allowedHosts: ['hooks.example.com', 'api.partner.io'],
    allowedPorts: [443],
  };

  it('accepts an allowlisted host that resolves to a public address', async () => {
    stubResolution([{ address: '93.184.216.34', family: 4 }]);

    const result = await verifyOutboundDestination('https://hooks.example.com/events', {
      policy: deploymentPolicy,
    });

    expect(result.ok).toBe(true);
    expect(result.url).toBe('https://hooks.example.com/events');
    expect(result.host).toBe('hooks.example.com');
    expect(result.addresses).toEqual([{ address: '93.184.216.34', family: 4 }]);
    expect(result.reason).toBeUndefined();
  });

  it('rejects a redirect that lands on a private address', async () => {
    stubResolution([{ address: '169.254.169.254', family: 4 }]);

    const result = await verifyOutboundDestination('https://hooks.example.com/events', {
      policy: deploymentPolicy,
      redirectChain: [
        'https://hooks.example.com/events',
        'https://hooks.example.com/moved',
        'https://169.254.169.254/latest/meta-data/',
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('private-ip');
    expect(result.blockedUrl).toBe('https://169.254.169.254/latest/meta-data/');
    expect(result.addresses).toEqual([]);
  });

  it('rejects a redirect that leaves the allowlist', async () => {
    stubResolution([{ address: '93.184.216.34', family: 4 }]);

    const result = await verifyOutboundDestination('https://hooks.example.com/events', {
      policy: deploymentPolicy,
      redirectChain: ['https://hooks.example.com/events', 'https://evil.example.com/collect'],
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not-allowlisted');
    expect(result.blockedUrl).toBe('https://evil.example.com/collect');
  });

  it('rejects DNS rebinding where the answer changes to a private address', async () => {
    stubResolution([{ address: '10.0.0.7', family: 4 }]);

    const result = await verifyOutboundDestination('https://api.partner.io/hook', {
      policy: deploymentPolicy,
      // The host was validated earlier when it resolved publicly.
      previousAddresses: [{ address: '93.184.216.34', family: 4 }],
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('dns-rebinding');
    expect(result.addresses).toEqual([]);
  });

  it('rejects a destination on a port outside the deployment policy', async () => {
    stubResolution([{ address: '93.184.216.34', family: 4 }]);

    const result = await verifyOutboundDestination('https://hooks.example.com:8443/events', {
      policy: deploymentPolicy,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('port-not-allowed');
    expect(result.port).toBe(8443);
  });

  it('rejects plain http when the deployment requires https', async () => {
    stubResolution([{ address: '93.184.216.34', family: 4 }]);

    const result = await verifyOutboundDestination('http://hooks.example.com/events', {
      policy: deploymentPolicy,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('insecure-protocol');
  });

  it('fails closed when DNS resolution errors', async () => {
    vi.spyOn(dns, 'lookup').mockImplementation(((
      _hostname: string,
      _options: unknown,
      callback: (err: unknown, addrs: unknown, family: number) => void,
    ) => {
      callback(new Error('ENOTFOUND'), [], 0);
    }) as never);

    const result = await verifyOutboundDestination('https://hooks.example.com/events', {
      policy: deploymentPolicy,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('dns-error');
    expect(result.addresses).toEqual([]);
  });
});
