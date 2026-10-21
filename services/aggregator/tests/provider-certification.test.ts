import { describe, expect, it } from 'vitest';
import { certifyProviderTransport } from '../src/oracle-sources/certification';
import { validateOutboundUrl, type SsrfPolicy } from '../../../packages/ssrf-guard/src/policy';

describe('provider adapter transport certification', () => {
  const validate = (endpoint: string, policy: { allowedHosts: string[]; allowPrivateIps: boolean; allowLocalHostnames: boolean; requireHttps: boolean }) => validateOutboundUrl(endpoint, policy as SsrfPolicy);

  it('accepts an allowed HTTPS provider endpoint and a probe within deadline', async () => {
    const report = await certifyProviderTransport({
      provider: 'chainlink', endpoint: 'https://oracle.example/price', allowedHosts: ['oracle.example'], timeoutMs: 100,
      validateEndpoint: validate, probe: async () => ({ status: 200 }),
    });
    expect(report).toMatchObject({ endpointAllowed: true, probeCompleted: true, probeTimedOut: false, certified: true });
  });

  it('rejects private or unlisted endpoints without running the probe', async () => {
    for (const endpoint of ['http://127.0.0.1/price', 'https://unlisted.example/price']) {
      const report = await certifyProviderTransport({
        provider: 'chainlink', endpoint, allowedHosts: ['127.0.0.1', 'oracle.example'], timeoutMs: 100,
        validateEndpoint: validate, probe: async () => { throw new Error('probe must not run'); },
      });
      expect(report.endpointAllowed).toBe(false);
      expect(report.probeCompleted).toBe(false);
      expect(report.certified).toBe(false);
    }
  });

  it('fails certification when an adapter probe exceeds its deadline and aborts it', async () => {
    let aborted = false;
    const report = await certifyProviderTransport({
      provider: 'redstone', endpoint: 'https://oracle.example/price', allowedHosts: ['oracle.example'], timeoutMs: 5,
      validateEndpoint: validate,
      probe: (signal) => new Promise((resolve) => {
        signal.addEventListener('abort', () => { aborted = true; resolve(undefined); }, { once: true });
      }),
    });
    expect(aborted).toBe(true);
    expect(report).toMatchObject({ endpointAllowed: true, probeCompleted: false, probeTimedOut: true, certified: false });
  });
});
