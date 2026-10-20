import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/infrastructure/config';
import { logger } from '../src/observability/logger';

vi.mock('../src/observability/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

function baseEnv(): NodeJS.ProcessEnv {
  return {
    REGION_ID: 'us-east',
    CHAINLINK_BASE_URL: 'https://global.chainlink.example',
    CHAINLINK_API_KEY: 'global-key',
    REDSTONE_BASE_URL: 'https://global.redstone.example',
    BAND_BASE_URL: 'https://global.band.example',
    REFLECTOR_BASE_URL: 'https://global.reflector.example',
    WATCHED_ASSETS: 'XLM,USDC',
    ENCRYPTION_KEY: '0'.repeat(64),
  } as NodeJS.ProcessEnv;
}

describe('Issue #685 — Region-scoped provider configuration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves region-scoped base URL over the global endpoint', () => {
    const env = { ...baseEnv(), CHAINLINK_BASE_URL_US_EAST: 'https://us-east.chainlink.example' };
    const config = loadConfig(env);
    expect(config.sources.chainlink.baseUrl).toBe('https://us-east.chainlink.example');
    expect(config.sources.redstone.baseUrl).toBe('https://global.redstone.example');
  });

  it('falls back to the global endpoint when no region-scoped URL is set', () => {
    const env = baseEnv();
    const config = loadConfig(env);
    expect(config.sources.chainlink.baseUrl).toBe('https://global.chainlink.example');
  });

  it('resolves region-scoped API key over the global key', () => {
    const env = { ...baseEnv(), CHAINLINK_API_KEY_US_EAST: 'region-key-us-east' };
    const config = loadConfig(env);
    // apiKey is decrypted; in tests decryptSecret returns the input unless it looks encrypted.
    expect(config.sources.chainlink.apiKey).toContain('region-key-us-east');
  });

  it('does not leak another region\'s credentials (namespaced by region)', () => {
    const env = {
      ...baseEnv(),
      REGION_ID: 'eu-west',
      CHAINLINK_API_KEY_US_EAST: 'us-east-key',
      CHAINLINK_API_KEY_EU_WEST: 'eu-west-key',
    };
    const config = loadConfig(env);
    expect(config.sources.chainlink.apiKey).toContain('eu-west-key');
    expect(config.sources.chainlink.apiKey).not.toContain('us-east-key');
  });

  it('falls back to global endpoint and warns when region-scoped URL is invalid', () => {
    const warn = vi.mocked(logger.warn);
    const env = { ...baseEnv(), CHAINLINK_BASE_URL_US_EAST: 'not-a-url' };
    const config = loadConfig(env);
    expect(config.sources.chainlink.baseUrl).toBe('https://global.chainlink.example');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Ignoring invalid region-scoped'),
    );
  });

  it('warns when a region-scoped key equals the global key (potential leakage)', () => {
    const warn = vi.mocked(logger.warn);
    const env = { ...baseEnv(), CHAINLINK_API_KEY_US_EAST: 'global-key' };
    loadConfig(env);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('cross-environment leakage'),
    );
  });
});
