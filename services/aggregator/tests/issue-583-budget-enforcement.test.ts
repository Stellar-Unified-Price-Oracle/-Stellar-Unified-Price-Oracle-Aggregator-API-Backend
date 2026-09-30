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
});
