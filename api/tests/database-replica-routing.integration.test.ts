import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { config } from '../src/infrastructure/config';
import { DatabaseClient } from '../src/infrastructure/database';

const pools: any[] = [];

vi.mock('pg', () => ({
  Pool: vi.fn(function MockPool(opts: any) {
    const pool = {
      opts,
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      connect: vi.fn().mockResolvedValue({ query: vi.fn().mockResolvedValue({}), release: vi.fn() }),
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

vi.mock('../src/observability/metrics', () => {
  const gauge = { set: vi.fn(), inc: vi.fn() };
  const counter = { inc: vi.fn() };
  return {
    dbReplicaHealthy: gauge,
    dbReplicaLagSeconds: gauge,
    dbPoolTotalConnections: gauge,
    dbPoolIdleConnections: gauge,
    dbPoolWaitingCount: gauge,
    dbPoolMaxConnections: gauge,
    dbQueryDuration: { startTimer: vi.fn(() => () => 0) },
    dbQueryErrorsTotal: counter,
    dbRetriesTotal: counter,
    dbCircuitBreakerState: gauge,
    register: { registerMetric: vi.fn() },
  };
});

const logger = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as any;

function createClient(replicaUrls: string[]): DatabaseClient {
  config.db.replica.urls = replicaUrls;
  config.db.replica.maxLagMs = 0;
  return new DatabaseClient('postgres://primary/db', logger);
}

beforeEach(() => {
  vi.clearAllMocks();
  pools.length = 0;
  config.db.replica.urls = [];
});

describe('Database read replica routing integration', () => {
  it('routes writes to primary and reads to replicas', async () => {
    const client = createClient(['postgres://replica-1/db']);

    await client.query('INSERT INTO price_history VALUES ($1)', ['XLM']);
    await client.readQuery('SELECT * FROM price_history WHERE asset = $1', ['XLM']);

    expect(Pool).toHaveBeenCalledTimes(2);
    expect(pools[0].query).toHaveBeenCalledWith('INSERT INTO price_history VALUES ($1)', ['XLM']);
    expect(pools[1].query).toHaveBeenCalledWith('SELECT * FROM price_history WHERE asset = $1', ['XLM']);
  });

  it('falls back to primary when a replica read fails', async () => {
    const client = createClient(['postgres://replica-1/db']);
    pools[1].query.mockRejectedValueOnce(new Error('replica down'));

    await client.readQuery('SELECT * FROM price_history WHERE asset = $1', ['XLM']);

    expect(pools[1].query).toHaveBeenCalledTimes(1);
    expect(pools[0].query).toHaveBeenCalledWith('SELECT * FROM price_history WHERE asset = $1', ['XLM']);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('falling back to primary'),
      expect.any(Error),
    );
  });

  it('skips lagging replicas and serves reads from primary', async () => {
    const client = createClient(['postgres://replica-1/db']);
    config.db.replica.maxLagMs = 1000;
    pools[1].query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ lag: '5' }], rowCount: 1 });
    await client.initialize();

    await new Promise((resolve) => setTimeout(resolve, 0));
    await client.readQuery('SELECT * FROM price_history WHERE asset = $1', ['XLM']);

    expect(pools[0].query).toHaveBeenCalledWith('SELECT * FROM price_history WHERE asset = $1', ['XLM']);
    await client.disconnect();
  });
});
