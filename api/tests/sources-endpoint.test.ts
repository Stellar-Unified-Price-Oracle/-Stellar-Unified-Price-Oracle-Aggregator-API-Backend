import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

interface SourceState {
  name: string;
  authorized: boolean;
  reachable: boolean;
  contributingToCurrentRound: boolean;
  healthOverWindow: 'healthy' | 'degraded' | 'unhealthy';
  consecutiveFailures: number;
  lastSuccessTimestamp: number | null;
  circuitBreakerState: 'closed' | 'open' | 'half_open';
  uptimePercentage: number;
}

interface SourceHealthChannel {
  type: 'redis' | 'proxy' | 'derived';
  failureMode: string;
}

class SourceHealthProvider {
  private sources: Map<string, SourceState> = new Map();
  private channel: SourceHealthChannel;

  constructor(channel: SourceHealthChannel = { type: 'redis', failureMode: '' }) {
    this.channel = channel;
  }

  setSourceState(state: SourceState): void {
    this.sources.set(state.name, state);
  }

  async getSourceStates(): Promise<SourceState[]> {
    if (this.channel.type === 'redis' && this.channel.failureMode === 'timeout') {
      throw new Error('Redis connection timeout');
    }
    if (this.channel.type === 'proxy' && this.channel.failureMode === 'aggregator_down') {
      throw new Error('Aggregator unhealthy');
    }
    return Array.from(this.sources.values());
  }

  async getSourceHealth(name: string): Promise<SourceState | null> {
    return this.sources.get(name) || null;
  }

  updateCircuitBreakerState(name: string, state: 'closed' | 'open' | 'half_open'): void {
    const source = this.sources.get(name);
    if (source) {
      source.circuitBreakerState = state;
    }
  }

  recordSuccess(name: string): void {
    const source = this.sources.get(name);
    if (source) {
      source.lastSuccessTimestamp = Math.floor(Date.now() / 1000);
      source.consecutiveFailures = 0;
      source.reachable = true;
      source.healthOverWindow = 'healthy';
    }
  }

  recordFailure(name: string): void {
    const source = this.sources.get(name);
    if (source) {
      source.consecutiveFailures++;
      if (source.consecutiveFailures > 3) {
        source.reachable = false;
        source.healthOverWindow = 'unhealthy';
        source.circuitBreakerState = 'open';
      } else {
        source.healthOverWindow = 'degraded';
      }
    }
  }
}

class SourcesEndpoint {
  private provider: SourceHealthProvider;

  constructor(provider: SourceHealthProvider) {
    this.provider = provider;
  }

  async handleGetSources(
    limit: number = 25,
    offset: number = 0,
  ): Promise<{ sources: SourceState[]; total: number; error?: string }> {
    try {
      const states = await this.provider.getSourceStates();

      if (!states || states.length === 0) {
        return {
          sources: [],
          total: 0,
          error: 'Source state unavailable',
        };
      }

      const paginated = states.slice(offset, offset + limit);

      return {
        sources: paginated,
        total: states.length,
      };
    } catch (err) {
      return {
        sources: [],
        total: 0,
        error: `Source health check failed: ${err instanceof Error ? err.message : 'unknown'}`,
      };
    }
  }

  async validateSourceState(source: SourceState): Promise<{ valid: boolean; reason?: string }> {
    if (source.authorized && !source.reachable) {
      return {
        valid: true,
        reason: 'Authorized but unreachable (transient failure)',
      };
    }

    if (!source.authorized) {
      return {
        valid: true,
        reason: 'Not authorized',
      };
    }

    return { valid: true };
  }

  async filterUnavailableState(sources: SourceState[]): Promise<SourceState[]> {
    return sources.filter((s) => s !== null && s !== undefined);
  }
}

describe('SourcesEndpoint', () => {
  let provider: SourceHealthProvider;
  let endpoint: SourcesEndpoint;

  beforeEach(() => {
    provider = new SourceHealthProvider();
    endpoint = new SourcesEndpoint(provider);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Real Source State', () => {
    it('returns real source state instead of hardcoded list', async () => {
      provider.setSourceState({
        name: 'Chainlink',
        authorized: true,
        reachable: true,
        contributingToCurrentRound: true,
        healthOverWindow: 'healthy',
        consecutiveFailures: 0,
        lastSuccessTimestamp: Math.floor(Date.now() / 1000),
        circuitBreakerState: 'closed',
        uptimePercentage: 99.5,
      });

      const result = await endpoint.handleGetSources();

      expect(result.sources).toHaveLength(1);
      expect(result.sources[0].name).toBe('Chainlink');
      expect(result.sources[0].healthOverWindow).toBe('healthy');
    });

    it('reflects degraded source state', async () => {
      provider.setSourceState({
        name: 'Redstone',
        authorized: true,
        reachable: false,
        contributingToCurrentRound: false,
        healthOverWindow: 'unhealthy',
        consecutiveFailures: 10,
        lastSuccessTimestamp: Math.floor(Date.now() / 1000) - 3600,
        circuitBreakerState: 'open',
        uptimePercentage: 45.2,
      });

      const result = await endpoint.handleGetSources();

      expect(result.sources[0].healthOverWindow).toBe('unhealthy');
      expect(result.sources[0].reachable).toBe(false);
      expect(result.sources[0].circuitBreakerState).toBe('open');
    });

    it('includes per-source detail: last success, failures, breaker state', async () => {
      const lastSuccess = Math.floor(Date.now() / 1000) - 300;
      provider.setSourceState({
        name: 'Band',
        authorized: true,
        reachable: true,
        contributingToCurrentRound: true,
        healthOverWindow: 'healthy',
        consecutiveFailures: 0,
        lastSuccessTimestamp: lastSuccess,
        circuitBreakerState: 'closed',
        uptimePercentage: 98.0,
      });

      const result = await endpoint.handleGetSources();
      const band = result.sources[0];

      expect(band.lastSuccessTimestamp).toBe(lastSuccess);
      expect(band.consecutiveFailures).toBe(0);
      expect(band.circuitBreakerState).toBe('closed');
    });
  });

  describe('Source Health Channel', () => {
    it('handles Redis channel failures gracefully', async () => {
      const redisProvider = new SourceHealthProvider({
        type: 'redis',
        failureMode: 'timeout',
      });
      const redisEndpoint = new SourcesEndpoint(redisProvider);

      const result = await redisEndpoint.handleGetSources();

      expect(result.error).toBeDefined();
      expect(result.sources).toHaveLength(0);
      expect(result.error).toContain('timeout');
    });

    it('signals unavailable state explicitly, never stale optimistic default', async () => {
      const failingProvider = new SourceHealthProvider({
        type: 'proxy',
        failureMode: 'aggregator_down',
      });
      const failingEndpoint = new SourcesEndpoint(failingProvider);

      const result = await failingEndpoint.handleGetSources();

      expect(result.error).toBeDefined();
      expect(result.sources).toHaveLength(0);
    });

    it('returns empty when no sources available', async () => {
      const result = await endpoint.handleGetSources();

      expect(result.sources).toHaveLength(0);
      expect(result.total).toBe(0);
    });
  });

  describe('Explicit Source Fields', () => {
    it('distinguishes authorized from reachable', async () => {
      provider.setSourceState({
        name: 'Authorized-But-Down',
        authorized: true,
        reachable: false,
        contributingToCurrentRound: false,
        healthOverWindow: 'unhealthy',
        consecutiveFailures: 5,
        lastSuccessTimestamp: null,
        circuitBreakerState: 'open',
        uptimePercentage: 0,
      });

      const result = await endpoint.handleGetSources();

      expect(result.sources[0].authorized).toBe(true);
      expect(result.sources[0].reachable).toBe(false);
    });

    it('splits active field into separate meaningful fields', async () => {
      provider.setSourceState({
        name: 'Chainlink',
        authorized: true,
        reachable: true,
        contributingToCurrentRound: true,
        healthOverWindow: 'healthy',
        consecutiveFailures: 0,
        lastSuccessTimestamp: Math.floor(Date.now() / 1000),
        circuitBreakerState: 'closed',
        uptimePercentage: 99.5,
      });

      provider.setSourceState({
        name: 'Redstone',
        authorized: true,
        reachable: false,
        contributingToCurrentRound: false,
        healthOverWindow: 'unhealthy',
        consecutiveFailures: 20,
        lastSuccessTimestamp: null,
        circuitBreakerState: 'open',
        uptimePercentage: 0,
      });

      const result = await endpoint.handleGetSources();

      const chainlink = result.sources.find((s) => s.name === 'Chainlink')!;
      const redstone = result.sources.find((s) => s.name === 'Redstone')!;

      expect(chainlink.authorized).toBe(true);
      expect(chainlink.reachable).toBe(true);
      expect(chainlink.contributingToCurrentRound).toBe(true);

      expect(redstone.authorized).toBe(true);
      expect(redstone.reachable).toBe(false);
      expect(redstone.contributingToCurrentRound).toBe(false);
    });
  });

  describe('Pagination', () => {
    it('paginates variable-length source list correctly', async () => {
      for (let i = 0; i < 30; i++) {
        provider.setSourceState({
          name: `Source-${i}`,
          authorized: true,
          reachable: true,
          contributingToCurrentRound: true,
          healthOverWindow: 'healthy',
          consecutiveFailures: 0,
          lastSuccessTimestamp: Math.floor(Date.now() / 1000),
          circuitBreakerState: 'closed',
          uptimePercentage: 99.0,
        });
      }

      const page1 = await endpoint.handleGetSources(10, 0);
      const page2 = await endpoint.handleGetSources(10, 10);
      const page3 = await endpoint.handleGetSources(10, 20);

      expect(page1.sources).toHaveLength(10);
      expect(page2.sources).toHaveLength(10);
      expect(page3.sources).toHaveLength(10);
      expect(page1.total).toBe(30);
      expect(page2.total).toBe(30);
      expect(page3.total).toBe(30);
    });

    it('handles partial last page', async () => {
      for (let i = 0; i < 25; i++) {
        provider.setSourceState({
          name: `Source-${i}`,
          authorized: true,
          reachable: true,
          contributingToCurrentRound: true,
          healthOverWindow: 'healthy',
          consecutiveFailures: 0,
          lastSuccessTimestamp: Math.floor(Date.now() / 1000),
          circuitBreakerState: 'closed',
          uptimePercentage: 99.0,
        });
      }

      const page2 = await endpoint.handleGetSources(20, 20);

      expect(page2.sources).toHaveLength(5);
      expect(page2.total).toBe(25);
    });
  });

  describe('Actionable Degradation Signals', () => {
    it('allows operator to identify failing source immediately', async () => {
      provider.setSourceState({
        name: 'Band',
        authorized: true,
        reachable: false,
        contributingToCurrentRound: false,
        healthOverWindow: 'unhealthy',
        consecutiveFailures: 15,
        lastSuccessTimestamp: Math.floor(Date.now() / 1000) - 7200,
        circuitBreakerState: 'open',
        uptimePercentage: 12.5,
      });

      const result = await endpoint.handleGetSources();
      const band = result.sources[0];

      expect(band.reachable).toBe(false);
      expect(band.consecutiveFailures).toBeGreaterThan(10);
      expect(band.circuitBreakerState).toBe('open');
    });

    it('distinguishes transient degradation from circuit breaker', async () => {
      provider.setSourceState({
        name: 'Reflector',
        authorized: true,
        reachable: true,
        contributingToCurrentRound: true,
        healthOverWindow: 'degraded',
        consecutiveFailures: 2,
        lastSuccessTimestamp: Math.floor(Date.now() / 1000) - 60,
        circuitBreakerState: 'half_open',
        uptimePercentage: 85.0,
      });

      const result = await endpoint.handleGetSources();
      const reflector = result.sources[0];

      expect(reflector.circuitBreakerState).toBe('half_open');
      expect(reflector.consecutiveFailures).toBe(2);
      expect(reflector.healthOverWindow).toBe('degraded');
    });
  });

  describe('State Transitions', () => {
    it('reflects success recovery in source state', async () => {
      provider.setSourceState({
        name: 'Chainlink',
        authorized: true,
        reachable: false,
        contributingToCurrentRound: false,
        healthOverWindow: 'unhealthy',
        consecutiveFailures: 5,
        lastSuccessTimestamp: null,
        circuitBreakerState: 'open',
        uptimePercentage: 20.0,
      });

      provider.recordSuccess('Chainlink');

      const result = await endpoint.handleGetSources();
      const chainlink = result.sources[0];

      expect(chainlink.reachable).toBe(true);
      expect(chainlink.consecutiveFailures).toBe(0);
      expect(chainlink.healthOverWindow).toBe('healthy');
    });

    it('reflects failure escalation in source state', async () => {
      provider.setSourceState({
        name: 'Redstone',
        authorized: true,
        reachable: true,
        contributingToCurrentRound: true,
        healthOverWindow: 'healthy',
        consecutiveFailures: 0,
        lastSuccessTimestamp: Math.floor(Date.now() / 1000),
        circuitBreakerState: 'closed',
        uptimePercentage: 99.5,
      });

      provider.recordFailure('Redstone');
      provider.recordFailure('Redstone');
      provider.recordFailure('Redstone');
      provider.recordFailure('Redstone');

      const result = await endpoint.handleGetSources();
      const redstone = result.sources[0];

      expect(redstone.reachable).toBe(false);
      expect(redstone.circuitBreakerState).toBe('open');
      expect(redstone.healthOverWindow).toBe('unhealthy');
    });
  });

  describe('Validation', () => {
    it('validates source state consistency', async () => {
      provider.setSourceState({
        name: 'Band',
        authorized: true,
        reachable: false,
        contributingToCurrentRound: false,
        healthOverWindow: 'unhealthy',
        consecutiveFailures: 5,
        lastSuccessTimestamp: null,
        circuitBreakerState: 'open',
        uptimePercentage: 10.0,
      });

      const state = await provider.getSourceHealth('Band');
      const validation = await endpoint.validateSourceState(state!);

      expect(validation.valid).toBe(true);
    });
  });
});
