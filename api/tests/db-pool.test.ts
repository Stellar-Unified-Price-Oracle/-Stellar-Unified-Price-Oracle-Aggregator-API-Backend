import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Pool } from 'pg';
import { ManagedPool, ManagedPoolOptions } from '../src/infrastructure/db-pool';

const mockQuery = vi.fn();
const mockConnect = vi.fn();
const mockEnd = vi.fn();
const mockOn = vi.fn();

const mockPoolInstance = {
  query: mockQuery,
  connect: mockConnect,
  end: mockEnd,
  on: mockOn,
  totalCount: 5,
  idleCount: 2,
  waitingCount: 0,
};

vi.mock('pg', () => ({
  Pool: vi.fn(function MockPool() { return mockPoolInstance; }),
  default: { Pool: vi.fn(function MockPool() { return mockPoolInstance; }) },
}));

vi.mock('../src/observability/metrics', () => {
  const mockGauge = { set: vi.fn(), inc: vi.fn() };
  const mockCounter = { inc: vi.fn() };
  return {
    dbPoolTotalConnections: mockGauge,
    dbPoolIdleConnections: mockGauge,
    dbPoolWaitingCount: mockGauge,
    dbPoolMaxConnections: mockGauge,
    dbQueryDuration: { startTimer: vi.fn(() => () => 0) },
    dbQueryErrorsTotal: mockCounter,
    dbRetriesTotal: mockCounter,
    dbCircuitBreakerState: mockGauge,
  };
});

const defaultOpts: ManagedPoolOptions = {
  name: 'primary',
  connectionString: 'postgres://localhost:5432/test',
  poolMin: 2,
  poolMax: 10,
  idleTimeoutMs: 30000,
  connectionTimeoutMs: 5000,
  statementTimeoutMs: 10000,
  retry: { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 1000 },
  circuitBreaker: {
    enabled: true,
    failureThreshold: 3,
    successThreshold: 2,
    openMs: 5000,
  },
};

const logger = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as any;

beforeEach(() => {
  vi.clearAllMocks();
  mockQuery.mockReset();
  mockConnect.mockReset();
  mockEnd.mockReset();
  mockOn.mockReset();
  mockPoolInstance.totalCount = 5;
  mockPoolInstance.idleCount = 2;
  mockPoolInstance.waitingCount = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ManagedPool', () => {
  it('creates a pool with the given options', () => {
    new ManagedPool(defaultOpts, logger);

    expect(Pool).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionString: 'postgres://localhost:5432/test',
        min: 2,
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
        statement_timeout: 10000,
      }),
    );
  });

  it('stores the pool name', () => {
    const pool = new ManagedPool(defaultOpts, logger);
    expect(pool.name).toBe('primary');
  });

  it('registers an error handler on the pool', () => {
    new ManagedPool(defaultOpts, logger);
    expect(mockOn).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('executes a query successfully', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: 1 }], rowCount: 1 });
    const pool = new ManagedPool(defaultOpts, logger);

    const result = await pool.query('SELECT 1');

    expect(result).toEqual({ rows: [{ id: 1 }], rowCount: 1 });
    expect(mockQuery).toHaveBeenCalledWith('SELECT 1', undefined);
  });

  it('executes a parameterised query successfully', async () => {
    mockQuery.mockResolvedValue({ rows: [{ name: 'test' }], rowCount: 1 });
    const pool = new ManagedPool(defaultOpts, logger);

    const result = await pool.query('SELECT * FROM t WHERE id = $1', [1]);

    expect(result).toEqual({ rows: [{ name: 'test' }], rowCount: 1 });
    expect(mockQuery).toHaveBeenCalledWith('SELECT * FROM t WHERE id = $1', [1]);
  });

  it('rejects on query error', async () => {
    mockQuery.mockRejectedValue(new Error('connection lost'));
    const pool = new ManagedPool(defaultOpts, logger);

    await expect(pool.query('SELECT 1')).rejects.toThrow('connection lost');
  });

  it('connects and returns a PoolClient', async () => {
    const mockClient = { query: vi.fn(), release: vi.fn() };
    mockConnect.mockResolvedValue(mockClient);
    const pool = new ManagedPool(defaultOpts, logger);

    const client = await pool.connect();

    expect(client).toBe(mockClient);
  });

  it('rejects on connect failure', async () => {
    mockConnect.mockRejectedValue(new Error('too many connections'));
    const pool = new ManagedPool(defaultOpts, logger);

    await expect(pool.connect()).rejects.toThrow('too many connections');
  });

  it('returns true on successful ping', async () => {
    mockQuery.mockResolvedValue({ rows: [{ '?column?': 1 }] });
    const pool = new ManagedPool(defaultOpts, logger);

    const result = await pool.ping();

    expect(result).toBe(true);
    expect(mockQuery).toHaveBeenCalledWith('SELECT 1');
  });

  it('returns false on ping failure', async () => {
    mockQuery.mockRejectedValue(new Error('connection refused'));
    const pool = new ManagedPool(defaultOpts, logger);

    const result = await pool.ping();

    expect(result).toBe(false);
  });

  it('collects and returns pool statistics', () => {
    const pool = new ManagedPool(defaultOpts, logger);
    const stats = pool.collectMetrics();

    expect(stats).toEqual({
      name: 'primary',
      total: 5,
      idle: 2,
      waiting: 0,
      max: 10,
      circuitState: 'closed',
    });
  });

  it('collects metrics when pool is at capacity', () => {
    mockPoolInstance.totalCount = 10;
    mockPoolInstance.idleCount = 0;
    mockPoolInstance.waitingCount = 5;
    const pool = new ManagedPool(defaultOpts, logger);

    const stats = pool.collectMetrics();

    expect(stats.total).toBe(10);
    expect(stats.idle).toBe(0);
    expect(stats.waiting).toBe(5);
  });

  it('getCircuitState returns the breaker state', () => {
    const pool = new ManagedPool(defaultOpts, logger);
    expect(pool.getCircuitState()).toBe('closed');
  });

  it('circuit breaker opens on repeated failures', async () => {
    mockQuery.mockRejectedValue(new Error('db down'));
    const pool = new ManagedPool(defaultOpts, logger);

    for (let i = 0; i < 3; i++) {
      await expect(pool.query('SELECT 1')).rejects.toThrow('db down');
    }

    expect(pool.getCircuitState()).toBe('open');
  });

  it('ends the pool gracefully', async () => {
    const pool = new ManagedPool(defaultOpts, logger);
    await pool.end();
    expect(mockEnd).toHaveBeenCalled();
  });

  it('works with replica pool names', () => {
    const replicaPool = new ManagedPool(
      { ...defaultOpts, name: 'replica-0' },
      logger,
    );
    expect(replicaPool.name).toBe('replica-0');
  });
});
