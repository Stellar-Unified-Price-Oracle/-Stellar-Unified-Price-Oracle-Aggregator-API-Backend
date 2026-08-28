import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Pool } from 'pg';
import { config } from '../src/infrastructure/config';
import { DatabaseClient, setDb, getDb, isDbAvailable } from '../src/infrastructure/database';

const mockPoolQuery = vi.fn();
const mockPoolConnect = vi.fn();
const mockPoolEnd = vi.fn();
const mockPoolOn = vi.fn();

const mockPoolInstance = {
  query: mockPoolQuery,
  connect: mockPoolConnect,
  end: mockPoolEnd,
  on: mockPoolOn,
  totalCount: 5,
  idleCount: 2,
  waitingCount: 0,
};

vi.mock('pg', () => ({
  Pool: vi.fn(function MockPool() { return mockPoolInstance; }),
  default: { Pool: vi.fn(function MockPool() { return mockPoolInstance; }) },
}));

vi.mock('../src/infrastructure/config', () => {
  const defaults = {
    poolMin: 2,
    poolMax: 10,
    idleTimeoutMs: 30000,
    connectionTimeoutMs: 5000,
    statementTimeoutMs: 10000,
  };
  return {
    config: {
      db: {
        ...defaults,
        retry: { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 1000 },
        circuitBreaker: {
          enabled: true,
          failureThreshold: 3,
          successThreshold: 2,
          openMs: 5000,
        },
        replica: {
          urls: [],
          maxLagMs: 0,
          healthCheckIntervalMs: 15000,
        },
      },
      useTimescale: false,
    },
  };
});

vi.mock('../src/observability/metrics', () => {
  const mockGauge = { set: vi.fn(), inc: vi.fn() };
  const mockCounter = { inc: vi.fn() };
  return {
    dbReplicaHealthy: mockGauge,
    dbReplicaLagSeconds: mockGauge,
    dbPoolTotalConnections: mockGauge,
    dbPoolIdleConnections: mockGauge,
    dbPoolWaitingCount: mockGauge,
    dbPoolMaxConnections: mockGauge,
    dbQueryDuration: { startTimer: vi.fn(() => () => 0) },
    dbQueryErrorsTotal: mockCounter,
    dbRetriesTotal: mockCounter,
    dbCircuitBreakerState: mockGauge,
    register: { registerMetric: vi.fn() },
  };
});

const logger = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as any;

beforeEach(() => {
  vi.clearAllMocks();
  mockPoolQuery.mockReset();
  mockPoolConnect.mockReset();
  mockPoolEnd.mockReset();
  mockPoolOn.mockReset();
  mockPoolInstance.totalCount = 5;
  mockPoolInstance.idleCount = 2;
  mockPoolInstance.waitingCount = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function createClient(replicaUrls: string[] = []): DatabaseClient {
  const originalUrls = config.db.replica.urls;
  config.db.replica.urls = replicaUrls;
  const client = new DatabaseClient('postgres://localhost:5432/test', logger);
  config.db.replica.urls = originalUrls;
  return client;
}

describe('DatabaseClient', () => {
  it('creates a primary pool on construction', () => {
    const client = new DatabaseClient('postgres://localhost:5432/test', logger);

    expect(Pool).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionString: 'postgres://localhost:5432/test',
        max: 10,
        min: 2,
      }),
    );
    expect(client.isInitialized()).toBe(false);
  });

  it('creates replica pools when configured', () => {
    createClient(['postgres://replica-1:5432/test', 'postgres://replica-2:5432/test']);

    expect(Pool).toHaveBeenCalledTimes(3);
  });

  it('logs replica count when replicas are configured', () => {
    createClient(['postgres://replica-1:5432/test']);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('1 read replica'),
    );
  });

  it('creates schema and sets initialized flag on successful init', async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValue({}),
      release: vi.fn(),
    };
    mockPoolConnect.mockResolvedValue(mockClient);

    const client = new DatabaseClient('postgres://localhost:5432/test', logger);
    await client.initialize();

    expect(client.isInitialized()).toBe(true);
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS price_history'),
    );
    expect(mockClient.release).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('PostgreSQL database initialized');
  });

  it('throws and does not set initialized on schema creation failure', async () => {
    const mockClient = {
      query: vi.fn().mockRejectedValue(new Error('permission denied')),
      release: vi.fn(),
    };
    mockPoolConnect.mockResolvedValue(mockClient);

    const client = new DatabaseClient('postgres://localhost:5432/test', logger);
    await expect(client.initialize()).rejects.toThrow('permission denied');

    expect(client.isInitialized()).toBe(false);
    expect(mockClient.release).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to initialize database',
      expect.any(Error),
    );
  });

  it('tries to enable TimescaleDB when configured', async () => {
    config.useTimescale = true;

    const mockClient = {
      query: vi.fn().mockResolvedValue({}),
      release: vi.fn(),
    };
    mockPoolConnect.mockResolvedValue(mockClient);

    const client = new DatabaseClient('postgres://localhost:5432/test', logger);
    await client.initialize();

    expect(client.isTimescaleEnabled()).toBe(true);
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('CREATE EXTENSION IF NOT EXISTS timescaledb'),
    );

    config.useTimescale = false;
  });

  it('falls back gracefully when TimescaleDB is unavailable', async () => {
    config.useTimescale = true;

    const mockClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error('extension not available')),
      release: vi.fn(),
    };
    mockPoolConnect.mockResolvedValue(mockClient);

    const client = new DatabaseClient('postgres://localhost:5432/test', logger);
    await client.initialize();

    expect(client.isInitialized()).toBe(true);
    expect(client.isTimescaleEnabled()).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('TimescaleDB not available'),
      expect.any(Error),
    );

    config.useTimescale = false;
  });

  it('executes a write query against the primary', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const client = new DatabaseClient('postgres://localhost:5432/test', logger);
    const result = await client.query('INSERT INTO price_history VALUES ($1, $2)', ['XLM', '100']);

    expect(result).toEqual({ rows: [], rowCount: 0 });
    expect(mockPoolQuery).toHaveBeenCalledWith(
      'INSERT INTO price_history VALUES ($1, $2)',
      ['XLM', '100'],
    );
  });

  it('readQuery reads against primary when no replicas', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [{ id: 1 }], rowCount: 1 });

    const client = new DatabaseClient('postgres://localhost:5432/test', logger);
    const result = await client.readQuery('SELECT * FROM price_history LIMIT 10');

    expect(result.rows).toEqual([{ id: 1 }]);
    expect(mockPoolQuery).toHaveBeenCalledWith(
      'SELECT * FROM price_history LIMIT 10',
      undefined,
    );
  });

  it('readQuery falls back to primary when replica query fails', async () => {
    const client = createClient(['postgres://replica-1:5432/test']);

    mockPoolQuery
      .mockRejectedValueOnce(new Error('replica down'))
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });

    const result = await client.readQuery('SELECT 1');

    expect(result.rows).toEqual([{ id: 1 }]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('falling back to primary'),
      expect.any(Error),
    );
  });

  it('getHistoricalPrices throws when not initialized', async () => {
    const client = new DatabaseClient('postgres://localhost:5432/test', logger);
    await expect(client.getHistoricalPrices('XLM')).rejects.toThrow(
      'Database not initialized',
    );
  });

  it('getHistoricalPrices returns rows for a given asset', async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValue({}),
      release: vi.fn(),
    };
    mockPoolConnect.mockResolvedValue(mockClient);
    mockPoolQuery.mockResolvedValue({
      rows: [
        {
          id: 1,
          asset: 'XLM',
          price: '100',
          decimals: 7,
          source: 'chainlink',
          timestamp: 1719000000,
          created_at: new Date('2024-06-21'),
        },
      ],
      rowCount: 1,
    });

    const client = new DatabaseClient('postgres://localhost:5432/test', logger);
    await client.initialize();

    const prices = await client.getHistoricalPrices('XLM');

    expect(prices).toHaveLength(1);
    expect(prices[0].asset).toBe('XLM');
    expect(prices[0].price).toBe('100');
    expect(prices[0].source).toBe('chainlink');
  });

  it('getHistoricalPrices supports time range filters', async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValue({}),
      release: vi.fn(),
    };
    mockPoolConnect.mockResolvedValue(mockClient);
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const client = new DatabaseClient('postgres://localhost:5432/test', logger);
    await client.initialize();

    await client.getHistoricalPrices('XLM', 1719000000, 1720000000, 50);

    expect(mockPoolQuery).toHaveBeenCalledWith(
      expect.stringContaining('timestamp >='),
      expect.arrayContaining(['XLM', 1719000000, 1720000000, 50]),
    );
  });

  it('getHistoricalPrices supports only from filter', async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValue({}),
      release: vi.fn(),
    };
    mockPoolConnect.mockResolvedValue(mockClient);
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const client = new DatabaseClient('postgres://localhost:5432/test', logger);
    await client.initialize();

    await client.getHistoricalPrices('XLM', 1719000000);

    expect(mockPoolQuery).toHaveBeenCalledWith(
      expect.stringContaining('timestamp >='),
      expect.arrayContaining(['XLM', 1719000000, 100]),
    );
    expect(mockPoolQuery).not.toHaveBeenCalledWith(
      expect.stringContaining('timestamp <='),
      expect.anything(),
    );
  });

  it('getHistoricalPrices throws on query error', async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValue({}),
      release: vi.fn(),
    };
    mockPoolConnect.mockResolvedValue(mockClient);
    mockPoolQuery.mockRejectedValue(new Error('table does not exist'));

    const client = new DatabaseClient('postgres://localhost:5432/test', logger);
    await client.initialize();

    await expect(client.getHistoricalPrices('XLM')).rejects.toThrow('table does not exist');
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to query price history',
      expect.any(Error),
    );
  });

  it('getAllLatestPrices throws when not initialized', async () => {
    const client = new DatabaseClient('postgres://localhost:5432/test', logger);
    await expect(client.getAllLatestPrices()).rejects.toThrow(
      'Database not initialized',
    );
  });

  it('getAllLatestPrices returns distinct assets', async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValue({}),
      release: vi.fn(),
    };
    mockPoolConnect.mockResolvedValue(mockClient);
    mockPoolQuery.mockResolvedValue({
      rows: [
        {
          id: 1,
          asset: 'XLM',
          price: '100',
          decimals: 7,
          source: 'chainlink',
          timestamp: 1719000000,
          created_at: new Date(),
        },
        {
          id: 2,
          asset: 'BTC',
          price: '65000',
          decimals: 8,
          source: 'redstone',
          timestamp: 1719000000,
          created_at: new Date(),
        },
      ],
      rowCount: 2,
    });

    const client = new DatabaseClient('postgres://localhost:5432/test', logger);
    await client.initialize();

    const prices = await client.getAllLatestPrices();

    expect(prices).toHaveLength(2);
    expect(prices[0].asset).toBe('XLM');
    expect(prices[1].asset).toBe('BTC');
  });

  it('getAllLatestPrices throws on query error', async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValue({}),
      release: vi.fn(),
    };
    mockPoolConnect.mockResolvedValue(mockClient);
    mockPoolQuery.mockRejectedValue(new Error('connection lost'));

    const client = new DatabaseClient('postgres://localhost:5432/test', logger);
    await client.initialize();

    await expect(client.getAllLatestPrices()).rejects.toThrow('connection lost');
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to fetch all latest prices',
      expect.any(Error),
    );
  });

  it('getLatestPrice throws when not initialized', async () => {
    const client = new DatabaseClient('postgres://localhost:5432/test', logger);
    await expect(client.getLatestPrice('XLM')).rejects.toThrow(
      'Database not initialized',
    );
  });

  it('getLatestPrice returns the row for the given asset', async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValue({}),
      release: vi.fn(),
    };
    mockPoolConnect.mockResolvedValue(mockClient);
    mockPoolQuery.mockResolvedValue({
      rows: [
        {
          id: 1,
          asset: 'XLM',
          price: '100',
          decimals: 7,
          source: 'chainlink',
          timestamp: 1719000000,
          created_at: new Date(),
        },
      ],
      rowCount: 1,
    });

    const client = new DatabaseClient('postgres://localhost:5432/test', logger);
    await client.initialize();

    const price = await client.getLatestPrice('XLM');

    expect(price).not.toBeNull();
    expect(price!.asset).toBe('XLM');
    expect(mockPoolQuery).toHaveBeenCalledWith(
      expect.stringContaining('ORDER BY timestamp DESC LIMIT 1'),
      ['XLM'],
    );
  });

  it('getLatestPrice returns null when no rows found', async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValue({}),
      release: vi.fn(),
    };
    mockPoolConnect.mockResolvedValue(mockClient);
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const client = new DatabaseClient('postgres://localhost:5432/test', logger);
    await client.initialize();

    const price = await client.getLatestPrice('UNKNOWN');

    expect(price).toBeNull();
  });

  it('getLatestPrice throws on query error', async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValue({}),
      release: vi.fn(),
    };
    mockPoolConnect.mockResolvedValue(mockClient);
    mockPoolQuery.mockRejectedValue(new Error('query timeout'));

    const client = new DatabaseClient('postgres://localhost:5432/test', logger);
    await client.initialize();

    await expect(client.getLatestPrice('XLM')).rejects.toThrow('query timeout');
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to fetch latest price',
      expect.any(Error),
    );
  });

  it('getPoolStats returns primary and replica stats', () => {
    const client = new DatabaseClient('postgres://localhost:5432/test', logger);
    const stats = client.getPoolStats();

    expect(stats.primary).toBeDefined();
    expect(stats.primary.name).toBe('primary');
    expect(stats.replicas).toEqual([]);
  });

  it('getPoolStats includes replica stats when replicas are configured', () => {
    const client = createClient(['postgres://replica-1:5432/test']);
    const stats = client.getPoolStats();

    expect(stats.replicas).toHaveLength(1);
    expect(stats.replicas[0].name).toBe('replica-0');
  });

  it('disconnect closes all pools', async () => {
    const client = createClient(['postgres://replica-1:5432/test']);

    await client.disconnect();

    expect(mockPoolEnd).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith('Database connection pools closed');
  });

  it('setDb / getDb / isDbAvailable work correctly', async () => {
    expect(isDbAvailable()).toBe(false);
    await expect(getDb()).rejects.toThrow('Database not initialized');

    const client = new DatabaseClient('postgres://localhost:5432/test', logger);
    setDb(client);

    expect(isDbAvailable()).toBe(true);
    await expect(getDb()).resolves.toBe(client);
  });

  it('disconnect clears timers after init', async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValue({}),
      release: vi.fn(),
    };
    mockPoolConnect.mockResolvedValue(mockClient);

    const client = new DatabaseClient('postgres://localhost:5432/test', logger);
    await client.initialize();

    await client.disconnect();
  });
});
