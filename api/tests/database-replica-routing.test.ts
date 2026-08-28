import { beforeEach, describe, expect, it, vi } from 'vitest';

const logger = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as any;

describe('DatabaseClient replica routing', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function loadClient(replicaUrls: string[]) {
    const pools: any[] = [];

    vi.doMock('pg', () => ({
      Pool: vi.fn(function MockPool(opts: any) {
        const pool = {
          opts,
          query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
          connect: vi.fn(),
          end: vi.fn(),
          on: vi.fn(),
          totalCount: 1,
          idleCount: 1,
          waitingCount: 0,
        };
        pools.push(pool);
        return pool;
      }),
    }));

    vi.doMock('../src/infrastructure/config', () => ({
      config: {
        db: {
          poolMin: 1,
          poolMax: 2,
          idleTimeoutMs: 30000,
          connectionTimeoutMs: 5000,
          statementTimeoutMs: 10000,
          retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 },
          circuitBreaker: {
            enabled: false,
            failureThreshold: 3,
            successThreshold: 1,
            openMs: 1000,
          },
          replica: {
            urls: replicaUrls,
            maxLagMs: 0,
            healthCheckIntervalMs: 60000,
          },
        },
        useTimescale: false,
      },
    }));

    vi.doMock('../src/observability/metrics', () => {
      const gauge = { set: vi.fn(), inc: vi.fn() };
      const counter = { inc: vi.fn() };
      return {
        dbReplicaHealthy: gauge,
        dbReplicaLagSeconds: gauge,
        dbPoolTotalConnections: gauge,
        dbPoolIdleConnections: gauge,
        dbPoolWaitingCount: gauge,
        dbPoolMaxConnections: gauge,
        dbQueryDuration: { startTimer: vi.fn(() => () => undefined) },
        dbQueryErrorsTotal: counter,
        dbRetriesTotal: counter,
        dbCircuitBreakerState: gauge,
      };
    });

    const { DatabaseClient } = await import('../src/infrastructure/database');
    return { client: new DatabaseClient('postgres://primary/db', logger), pools };
  }

  it('routes writes to the primary pool', async () => {
    const { client, pools } = await loadClient(['postgres://replica/db']);

    await client.query('INSERT INTO price_history(asset) VALUES($1)', ['XLM']);

    expect(pools[0].query).toHaveBeenCalledWith('INSERT INTO price_history(asset) VALUES($1)', ['XLM']);
    expect(pools[1].query).not.toHaveBeenCalled();
  });

  it('routes reads to a healthy replica', async () => {
    const { client, pools } = await loadClient(['postgres://replica/db']);

    await client.readQuery('SELECT * FROM price_history');

    expect(pools[0].query).not.toHaveBeenCalled();
    expect(pools[1].query).toHaveBeenCalledWith('SELECT * FROM price_history', undefined);
  });

  it('fails over reads to primary when the selected replica fails', async () => {
    const { client, pools } = await loadClient(['postgres://replica/db']);
    pools[1].query.mockRejectedValueOnce(new Error('replica unavailable'));

    await client.readQuery('SELECT 1');

    expect(pools[1].query).toHaveBeenCalledWith('SELECT 1', undefined);
    expect(pools[0].query).toHaveBeenCalledWith('SELECT 1', undefined);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('falling back to primary'),
      expect.any(Error),
    );
  });
});
