import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  recordCall,
  getBudgetUtilization,
  getBudgetStatus,
  getBudgetStatuses,
  getDailyCount,
  getDailyCounts,
  resetDailyCounts,
  flushDailyCounts,
  reloadPersistedCounts,
  DAILY_BUDGET_CALLS,
  BUDGET_WARN_RATIO,
  BUDGET_EXHAUSTED_RATIO,
} from '../src/infrastructure/cost-model';
import fs from 'fs';
import path from 'path';

vi.mock('../src/price-aggregation/source-circuit-breaker', () => ({
  sourceCircuitBreaker: {
    isAllowed: vi.fn(() => true),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
  },
}));

vi.mock(import('../src/observability/metrics'), async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/observability/metrics')>();
  return {
    ...actual,
    oracleSourceBudgetBlockedTotal: { inc: vi.fn() },
    oracleApiBudgetUtilization: { set: vi.fn() },
  };
});

vi.mock('../src/domain-events', () => ({
  eventBus: { publish: vi.fn() },
}));

const DATA_DIR = path.resolve(__dirname, '../data');
const COUNTS_FILE = path.join(DATA_DIR, 'daily-call-counts.json');

describe('Cost model budget enforcement (#583)', () => {
  beforeEach(() => {
    resetDailyCounts();
    if (fs.existsSync(COUNTS_FILE)) fs.unlinkSync(COUNTS_FILE);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    resetDailyCounts();
    if (fs.existsSync(COUNTS_FILE)) fs.unlinkSync(COUNTS_FILE);
  });

  describe('configuration', () => {
    it('sources budgets from real configuration, not a zeros table', () => {
      for (const [source, budget] of Object.entries(DAILY_BUDGET_CALLS)) {
        expect(source).toBeTruthy();
        expect(budget).toBeGreaterThan(0);
      }
    });

    it('reports a zero rate honestly for free public endpoints', () => {
      // The providers under contract are free public feeds: $0/1k calls is the
      // real contract term, while the daily budget is the real fair-use limit.
      for (const source of ['chainlink', 'redstone', 'band', 'reflector']) {
        expect(getBudgetStatus(source).budget).toBeGreaterThan(0);
      }
    });

    it('honors ORACLE_BUDGET_DAILY_CALLS_<SOURCE> env overrides', async () => {
      process.env.ORACLE_BUDGET_DAILY_CALLS_CHAINLINK = '50';
      vi.resetModules();
      const mod = await import('../src/infrastructure/cost-model');
      expect(mod.DAILY_BUDGET_CALLS['chainlink']).toBe(50);
      mod.recordCall('chainlink');
      expect(mod.getBudgetUtilization('chainlink')).toBe(1 / 50);
      delete process.env.ORACLE_BUDGET_DAILY_CALLS_CHAINLINK;
      vi.resetModules();
    });
  });

  describe('threshold states', () => {
    it('is ok below the warn ratio', () => {
      const budget = DAILY_BUDGET_CALLS['chainlink'];
      for (let i = 0; i < Math.floor(budget * BUDGET_WARN_RATIO) - 1; i++) recordCall('chainlink');
      const status = getBudgetStatus('chainlink');
      expect(status.state).toBe('ok');
      expect(status.utilization).toBeLessThan(BUDGET_WARN_RATIO);
    });

    it('warns at 80% utilization but keeps polling', () => {
      const budget = DAILY_BUDGET_CALLS['chainlink'];
      for (let i = 0; i < Math.ceil(budget * BUDGET_WARN_RATIO); i++) recordCall('chainlink');
      const status = getBudgetStatus('chainlink');
      expect(status.state).toBe('warn');
      expect(status.utilization).toBeGreaterThanOrEqual(BUDGET_WARN_RATIO);
      expect(status.utilization).toBeLessThan(BUDGET_EXHAUSTED_RATIO);
    });

    it('is exhausted at 100% utilization', () => {
      const budget = DAILY_BUDGET_CALLS['chainlink'];
      for (let i = 0; i < budget; i++) recordCall('chainlink');
      const status = getBudgetStatus('chainlink');
      expect(status.state).toBe('exhausted');
      expect(status.utilization).toBeGreaterThanOrEqual(BUDGET_EXHAUSTED_RATIO);
    });

    it('exposes statuses for every configured source', () => {
      const statuses = getBudgetStatuses();
      expect(Object.keys(statuses).sort()).toEqual(['band', 'chainlink', 'redstone', 'reflector']);
      expect(statuses['chainlink']).toMatchObject({ state: 'ok', dailyCalls: 0 });
    });

    it('keeps utilization beyond 1.0 when overridable budget is exceeded', async () => {
      process.env.ORACLE_BUDGET_DAILY_CALLS_BAND = '10';
      vi.resetModules();
      const mod = await import('../src/infrastructure/cost-model');
      for (let i = 0; i < 12; i++) mod.recordCall('band');
      expect(mod.getBudgetUtilization('band')).toBe(1.2);
      expect(mod.getBudgetStatus('band').state).toBe('exhausted');
      delete process.env.ORACLE_BUDGET_DAILY_CALLS_BAND;
      vi.resetModules();
    });
  });

  describe('rollover and persistence', () => {
    it('resets counters idempotently at the UTC boundary', () => {
      recordCall('chainlink');
      recordCall('chainlink');
      expect(getDailyCount('chainlink')).toBe(2);

      vi.setSystemTime(new Date('2024-01-16T00:00:00Z'));
      expect(getDailyCount('chainlink')).toBe(0);
      expect(getBudgetStatus('chainlink').state).toBe('ok');

      // The same timestamp again must not double-apply anything.
      expect(getDailyCount('chainlink')).toBe(0);
      expect(getDailyCounts()).toEqual({});
    });

    it('persists counters so they survive a restart', () => {
      for (let i = 0; i < 25; i++) recordCall('chainlink');
      flushDailyCounts();

      expect(fs.existsSync(COUNTS_FILE)).toBe(true);
      const persisted = JSON.parse(fs.readFileSync(COUNTS_FILE, 'utf8'));
      expect(persisted.date).toBe('2024-01-15');
      expect(persisted.counts['chainlink']).toBe(25);

      // Simulate a fresh process: in-memory state is seeded from disk.
      resetDailyCounts();
      reloadPersistedCounts();
      expect(getDailyCount('chainlink')).toBe(25);
    });

    it('drops persisted counters from a previous day on load', () => {
      for (let i = 0; i < 15; i++) recordCall('chainlink');
      flushDailyCounts();

      // Roll past midnight, then reload: yesterday's counts must not count
      // against today's budget.
      vi.setSystemTime(new Date('2024-01-16T00:00:00Z'));
      resetDailyCounts();
      reloadPersistedCounts();

      expect(getDailyCount('chainlink')).toBe(0);
      expect(getBudgetStatus('chainlink').state).toBe('ok');
    });

    it('writes the persisted file atomically (no temp leftovers)', () => {
      for (let i = 0; i < 20; i++) recordCall('redstone');
      flushDailyCounts();

      const leftovers = fs.readdirSync(DATA_DIR).filter((f) => f.includes('.tmp-'));
      expect(leftovers).toEqual([]);
      expect(JSON.parse(fs.readFileSync(COUNTS_FILE, 'utf8')).counts['redstone']).toBe(20);
    });
  });

  describe('degraded path', () => {
    it('skips fetching a source whose budget is exhausted', async () => {
      process.env.ORACLE_BUDGET_DAILY_CALLS_REFLECTOR = '3';
      vi.resetModules();
      const mod = await import('../src/infrastructure/cost-model');
      const { BaseSource } = await import('../src/oracle-sources/base');

      class StubSource extends BaseSource {
        name = 'reflector' as const;
        fetchCalls = 0;
        async fetchPrice(): Promise<null> {
          this.fetchCalls++;
          return null;
        }
      }

      const source = new StubSource();
      for (let i = 0; i < 3; i++) await source.fetchWithBackoff('XLM');
      expect(source.fetchCalls).toBe(3);

      // Budget exhausted: the provider is no longer contacted at all.
      const fourth = await source.fetchWithBackoff('XLM');
      expect(fourth).toBeNull();
      expect(source.fetchCalls).toBe(3);

      delete process.env.ORACLE_BUDGET_DAILY_CALLS_REFLECTOR;
      vi.resetModules();
    });
  });

  describe('surge limits and safe degradation (#744)', () => {
    async function loadSurgeModule() {
      vi.resetModules();
      return import('../src/infrastructure/cost-model');
    }

    it('exposes surge configuration with sane defaults', async () => {
      const mod = await loadSurgeModule();
      expect(mod.SURGE_WINDOW_MS).toBeGreaterThan(0);
      expect(mod.SURGE_MAX_CALLS_PER_WINDOW).toBeGreaterThan(0);
      expect(mod.SURGE_DEGRADE_RATIO).toBeGreaterThan(0);
      expect(mod.SURGE_DEGRADE_RATIO).toBeLessThan(1);
    });

    it('allows traffic below the surge limit', async () => {
      const mod = await loadSurgeModule();
      const limit = mod.SURGE_MAX_CALLS_PER_WINDOW;
      for (let i = 0; i < limit; i++) {
        expect(mod.checkSurgeLimit('chainlink').allowed).toBe(true);
        mod.recordCall('chainlink');
      }
    });

    it('blocks traffic at the surge limit boundary', async () => {
      const mod = await loadSurgeModule();
      const limit = mod.SURGE_MAX_CALLS_PER_WINDOW;
      for (let i = 0; i < limit; i++) {
        mod.recordCall('chainlink');
      }
      const decision = mod.checkSurgeLimit('chainlink');
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('surge');
    });

    it('degrades before the daily budget is breached', async () => {
      process.env.ORACLE_BUDGET_DAILY_CALLS_CHAINLINK = '10';
      const mod = await loadSurgeModule();
      // Fill to the degrade threshold (e.g. 90% of 10 = 9 calls).
      const threshold = Math.ceil(10 * mod.SURGE_DEGRADE_RATIO);
      for (let i = 0; i < threshold; i++) mod.recordCall('chainlink');

      const decision = mod.checkSurgeLimit('chainlink');
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('budget-degrade');
      // Budget is not yet exhausted: we degraded early, on purpose.
      expect(mod.getBudgetStatus('chainlink').state).not.toBe('exhausted');

      delete process.env.ORACLE_BUDGET_DAILY_CALLS_CHAINLINK;
      vi.resetModules();
    });

    it('recovers after the surge window rolls over', async () => {
      const mod = await loadSurgeModule();
      const limit = mod.SURGE_MAX_CALLS_PER_WINDOW;
      for (let i = 0; i < limit; i++) mod.recordCall('chainlink');
      expect(mod.checkSurgeLimit('chainlink').allowed).toBe(false);

      vi.advanceTimersByTime(mod.SURGE_WINDOW_MS + 1);
      expect(mod.checkSurgeLimit('chainlink').allowed).toBe(true);
    });

    it('emits an alert when the surge limit trips', async () => {
      const mod = await loadSurgeModule();
      const { eventBus } = await import('../src/domain-events');
      const publish = vi.mocked(eventBus.publish);
      publish.mockClear();

      const limit = mod.SURGE_MAX_CALLS_PER_WINDOW;
      for (let i = 0; i < limit; i++) mod.recordCall('chainlink');
      mod.checkSurgeLimit('chainlink');

      expect(publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'oracle.surge_limit_tripped',
          source: 'chainlink',
        }),
      );
    });

    it('emits an alert once when entering early degradation', async () => {
      process.env.ORACLE_BUDGET_DAILY_CALLS_CHAINLINK = '10';
      const mod = await loadSurgeModule();
      const { eventBus } = await import('../src/domain-events');
      const publish = vi.mocked(eventBus.publish);
      publish.mockClear();

      const threshold = Math.ceil(10 * mod.SURGE_DEGRADE_RATIO);
      for (let i = 0; i < threshold; i++) mod.recordCall('chainlink');
      mod.checkSurgeLimit('chainlink');
      mod.checkSurgeLimit('chainlink');

      const degradeAlerts = publish.mock.calls.filter(
        ([event]) => (event as { type?: string }).type === 'oracle.budget_degrade',
      );
      expect(degradeAlerts).toHaveLength(1);

      delete process.env.ORACLE_BUDGET_DAILY_CALLS_CHAINLINK;
      vi.resetModules();
    });

    it('does not contact the provider once surge-degraded', async () => {
      const mod = await loadSurgeModule();
      const { BaseSource } = await import('../src/oracle-sources/base');

      class StubSource extends BaseSource {
        name = 'chainlink' as const;
        fetchCalls = 0;
        async fetchPrice(): Promise<null> {
          this.fetchCalls++;
          return null;
        }
      }

      const source = new StubSource();
      const limit = mod.SURGE_MAX_CALLS_PER_WINDOW;
      for (let i = 0; i < limit; i++) await source.fetchWithBackoff('XLM');
      expect(source.fetchCalls).toBe(limit);

      const blocked = await source.fetchWithBackoff('XLM');
      expect(blocked).toBeNull();
      expect(source.fetchCalls).toBe(limit);
    });

    it('resets surge counters at the UTC day boundary', async () => {
      const mod = await loadSurgeModule();
      const limit = mod.SURGE_MAX_CALLS_PER_WINDOW;
      for (let i = 0; i < limit; i++) mod.recordCall('chainlink');
      expect(mod.checkSurgeLimit('chainlink').allowed).toBe(false);

      vi.setSystemTime(new Date('2024-01-16T00:00:00Z'));
      expect(mod.checkSurgeLimit('chainlink').allowed).toBe(true);
    });
  });
});
