import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/infrastructure/config';

describe('repaired config assembly (baseline repair)', () => {
  it('produces surge, egress, ownership and region-resolved sources from parsed env', () => {
    const cfg = loadConfig({
      ...process.env,
      SHUTDOWN_DRAIN_DEADLINE_MS: '25000',
      SHUTDOWN_FORCE_EXIT_MS: '35000',
    });

    expect(cfg.surge.enabled).toBe(false);
    expect(cfg.surge.maxRequestsPerWindow).toBe(1000);
    expect(cfg.surge.windowMs).toBe(60000);
    expect(cfg.surge.alertThresholdPercent).toBe(0.8);

    expect(cfg.security.egress.enabled).toBe(true);
    expect(cfg.security.egress.maxRedirects).toBe(0);
    expect(cfg.security.egress.followRedirects).toBe(false);
    expect(cfg.security.egress.pinDns).toBe(true);
    expect(cfg.security.ssrf.requestTimeoutMs).toBe(10000);

    // Every watched asset always resolves to exactly one authorized publisher.
    for (const asset of cfg.assets) {
      expect(cfg.feedOwnership[asset]).toBeDefined();
      expect(cfg.feedOwnership[asset].primary).toBe(cfg.region.id);
      expect(cfg.feedOwnership[asset].failover).toBe(cfg.region.id);
    }

    // Region-scoped resolution keeps working: a scoped Chainlink URL wins.
    const scoped = loadConfig({ ...process.env, REGION_ID: 'us-east', CHAINLINK_BASE_URL_US_EAST: 'https://scoped.example' });
    expect(scoped.sources.chainlink.baseUrl).toBe('https://scoped.example');
    // ...while an invalid scoped URL falls back loudly to the global endpoint.
    const fallback = loadConfig({ ...process.env, REGION_ID: 'us-east', CHAINLINK_BASE_URL_US_EAST: 'not-a-url' });
    expect(fallback.sources.chainlink.baseUrl).toBe('https://min-api.cryptocompare.com/data');
  });
});
