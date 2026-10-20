import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CapabilityRegistry,
  FeedAssignmentValidator,
  capabilityRegistry,
  type ProviderCapabilities,
  type FeedAssignment,
} from '../src/oracle-sources/capabilities';
import { BaseSource } from '../src/oracle-sources/base';
import { OracleSourceName } from '../src/infrastructure/types';

vi.mock('../src/observability/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
// base.ts pulls config, metrics, and domain-events transitively. The repo is
// missing @stellar-oracle/ws-guard and @refract/types (pre-existing), so mock
// the modules that drag them in so BaseSource loads in tests.
vi.mock('../src/domain-events', () => ({
  eventBus: { publish: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() },
}));
vi.mock('prom-client', () => {
  const metric = () => ({ inc: vi.fn(), set: vi.fn(), observe: vi.fn(), startTimer: () => () => 0, labels: () => metric() });
  const Registry = class {
    registerMetric = vi.fn();
    removeSingleMetric = vi.fn();
    metrics = vi.fn().mockResolvedValue('');
  };
  const mocked = {
    Counter: class { constructor() { return metric(); } },
    Gauge: class { constructor() { return metric(); } },
    Histogram: class { constructor() { return metric(); } },
    Summary: class { constructor() { return metric(); } },
    Registry,
    register: { registerMetric: vi.fn(), removeSingleMetric: vi.fn(), metrics: vi.fn().mockResolvedValue('') },
    collectDefaultMetrics: vi.fn(),
  };
  return { ...mocked, default: mocked };
});
vi.mock('../src/infrastructure/cost-model', () => ({
  estimateCostUsd: () => 0,
  recordCall: vi.fn(),
  getBudgetStatus: () => ({ state: 'ok', utilization: 0 }),
  BUDGET_WARN_RATIO: 0.8,
}));
vi.mock('../src/observability/alert-manager', () => ({
  default: class {
    logThrottleExhaustion = vi.fn();
  },
}));

function makeCapabilities(source: OracleSourceName): ProviderCapabilities {
  return {
    source,
    supportedAssets: ['XLM', 'USDC'],
    updateCadenceMs: 10_000,
    precision: { decimals: 8, minDecimals: 0, maxDecimals: 18 },
    historicalAvailability: { earliestUnixSeconds: null, retentionDays: 7, snapshots: false },
  };
}

class TestSource extends BaseSource {
  name: OracleSourceName = 'chainlink';
  capabilities: ProviderCapabilities = makeCapabilities('chainlink');
  async fetchPrice(_asset: string): Promise<never> {
    throw new Error('not used');
  }
}

describe('Issue #684 — Provider capability negotiation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('CapabilityRegistry', () => {
    it('registers and retrieves a capability profile', () => {
      const registry = new CapabilityRegistry();
      const caps = makeCapabilities('chainlink');
      registry.register(caps);
      expect(registry.getCapabilities('chainlink')).toEqual(caps);
      expect(registry.getCapabilities('redstone')).toBeUndefined();
    });

    it('reports supported assets', () => {
      const registry = new CapabilityRegistry();
      registry.register(makeCapabilities('chainlink'));
      expect(registry.supportsAsset('chainlink', 'XLM')).toBe(true);
      expect(registry.supportsAsset('chainlink', 'DOGE')).toBe(false);
      expect(registry.supportsAsset('redstone', 'XLM')).toBe(false);
    });

    it('validates compatible and incompatible feed assignments', () => {
      const registry = new CapabilityRegistry();
      registry.register(makeCapabilities('chainlink'));

      expect(registry.isAssignmentCompatible({ source: 'chainlink', asset: 'XLM' })).toEqual({
        compatible: true,
      });
      expect(registry.isAssignmentCompatible({ source: 'chainlink', asset: 'DOGE' })).toEqual({
        compatible: false,
        reason: expect.stringContaining('does not carry asset DOGE'),
      });
      expect(registry.isAssignmentCompatible({ source: 'redstone', asset: 'XLM' })).toEqual({
        compatible: false,
        reason: expect.stringContaining('no capability profile registered'),
      });
    });
  });

  describe('FeedAssignmentValidator', () => {
    it('splits assignments into valid and rejected', () => {
      const registry = new CapabilityRegistry();
      registry.register(makeCapabilities('chainlink'));
      const validator = new FeedAssignmentValidator(registry);

      const { valid, rejected } = validator.validate([
        { source: 'chainlink', asset: 'XLM' },
        { source: 'chainlink', asset: 'DOGE' },
      ]);

      expect(valid).toEqual([{ source: 'chainlink', asset: 'XLM' }]);
      expect(rejected).toEqual([
        { source: 'chainlink', asset: 'DOGE', reason: expect.any(String) },
      ]);
    });
  });

  describe('Default capability profiles', () => {
    it('covers all four providers with watched assets', () => {
      for (const source of ['chainlink', 'redstone', 'band', 'reflector'] as OracleSourceName[]) {
        const caps = capabilityRegistry.getCapabilities(source);
        expect(caps).toBeDefined();
        expect(caps!.supportedAssets).toContain('XLM');
        expect(caps!.supportedAssets).toContain('USDC');
        expect(caps!.precision.decimals).toBeGreaterThanOrEqual(0);
        expect(caps!.precision.decimals).toBeLessThanOrEqual(18);
      }
    });
  });

  describe('BaseSource capability guard', () => {
    it('skips fetching an asset not in the capability set as no-price', async () => {
      const source = new TestSource();
      // Bypass the abstract constructor guard: TestSource supports only XLM/USDC.
      const outcome = await (source as any).fetchWithOutcome('DOGE');
      expect(outcome.price).toBeNull();
      expect(outcome.failureKind).toBe('no-price');
    });

    it('allows fetching an asset in the capability set (delegates to fetchPrice)', async () => {
      const source = new TestSource();
      // Override fetchPrice to return a price so the capability guard passes through.
      (source as any).fetchPrice = async () => ({
        asset: 'XLM',
        price: 1n,
        decimals: 8,
        source: 'chainlink',
        timestamp: 1000,
      });
      const outcome = await (source as any).fetchWithOutcome('XLM');
      expect(outcome.price).not.toBeNull();
    });
  });
});
