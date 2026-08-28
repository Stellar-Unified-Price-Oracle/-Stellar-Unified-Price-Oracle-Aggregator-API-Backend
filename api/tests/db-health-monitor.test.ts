import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DbHealthMonitor } from '../src/infrastructure/db-health-monitor';

vi.mock('prom-client', () => ({
  default: {
    Counter: vi.fn(function MockCounter() {
      this.inc = vi.fn();
      return this;
    }),
    Gauge: vi.fn(function MockGauge() {
      this.set = vi.fn();
      return this;
    }),
    Registry: vi.fn(function MockRegistry() {
      this.registerMetric = vi.fn();
      this.metrics = vi.fn(() => Promise.resolve(''));
      this.contentType = 'text/plain';
      return this;
    }),
    collectDefaultMetrics: vi.fn(),
  },
  Counter: vi.fn(function MockCounter() {
    this.inc = vi.fn();
    return this;
  }),
  Gauge: vi.fn(function MockGauge() {
    this.set = vi.fn();
    return this;
  }),
  Registry: vi.fn(function MockRegistry() {
    this.registerMetric = vi.fn();
    this.metrics = vi.fn(() => Promise.resolve(''));
    this.contentType = 'text/plain';
    return this;
  }),
}));

vi.mock('../src/observability/metrics', () => ({
  register: { registerMetric: vi.fn() },
}));

const logger = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as any;

function mockDbClient(overrides: Record<string, any> = {}) {
  const stats = {
    primary: {
      name: 'primary',
      total: 5,
      idle: 2,
      waiting: 0,
      max: 10,
      circuitState: 'closed',
    },
    replicas: [
      {
        name: 'replica-0',
        total: 5,
        idle: 3,
        waiting: 0,
        max: 10,
        circuitState: 'closed',
      },
    ],
  };

  return {
    getPoolStats: vi.fn(() => ({ ...stats, ...overrides.stats })),
    readQuery: vi.fn(),
    ...overrides,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('DbHealthMonitor', () => {
  it('creates a monitor with default configuration', () => {
    const db = mockDbClient();
    const monitor = new DbHealthMonitor(db, logger);
    expect(monitor).toBeDefined();
  });

  it('creates a monitor with custom configuration', () => {
    const db = mockDbClient();
    const monitor = new DbHealthMonitor(db, logger, {
      checkIntervalMs: 5000,
      connectionExhaustionThreshold: 0.5,
      slowQueryThresholdMs: 2000,
      replicationLagAlertMs: 15000,
    });
    expect(monitor).toBeDefined();
  });

  it('start begins periodic health checks', () => {
    const db = mockDbClient();
    db.readQuery.mockResolvedValue({ rows: [{ '?column?': 1 }] });
    const monitor = new DbHealthMonitor(db, logger);

    monitor.start();

    expect(db.getPoolStats).toHaveBeenCalledTimes(1);
  });

  it('stop clears the interval timer', () => {
    const db = mockDbClient();
    const monitor = new DbHealthMonitor(db, logger);

    monitor.start();
    expect(() => monitor.stop()).not.toThrow();
  });

  it('double stop does not throw', () => {
    const db = mockDbClient();
    const monitor = new DbHealthMonitor(db, logger);

    monitor.start();
    monitor.stop();
    expect(() => monitor.stop()).not.toThrow();
  });

  it('reports healthy when no issues found', async () => {
    const db = mockDbClient();
    db.readQuery.mockResolvedValue({ rows: [{ '?column?': 1 }] });

    const monitor = new DbHealthMonitor(db, logger);
    const report = await monitor.runCheck();

    expect(report.status).toBe('healthy');
    expect(report.issues).toHaveLength(0);
    expect(report.probeLatencyMs).toBeGreaterThanOrEqual(0);
    expect(report.checkedAt).toBeGreaterThan(0);
  });

  it('reports degraded when connection exhaustion threshold is exceeded', async () => {
    const db = mockDbClient({
      stats: {
        primary: {
          name: 'primary',
          total: 10,
          idle: 0,
          waiting: 9,
          max: 10,
          circuitState: 'closed',
        },
        replicas: [],
      },
    });
    db.readQuery.mockResolvedValue({ rows: [{ '?column?': 1 }] });

    const monitor = new DbHealthMonitor(db, logger, {
      connectionExhaustionThreshold: 0.8,
    });
    const report = await monitor.runCheck();

    expect(report.status).toBe('degraded');
    expect(report.issues.some((i: string) => i.includes('connection exhaustion'))).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('connection exhaustion'),
    );
  });

  it('does not alert when exhaustion is below threshold', async () => {
    const db = mockDbClient({
      stats: {
        primary: {
          name: 'primary',
          total: 10,
          idle: 3,
          waiting: 5,
          max: 10,
          circuitState: 'closed',
        },
        replicas: [],
      },
    });
    db.readQuery.mockResolvedValue({ rows: [{ '?column?': 1 }] });

    const monitor = new DbHealthMonitor(db, logger, {
      connectionExhaustionThreshold: 0.8,
    });
    const report = await monitor.runCheck();

    expect(report.status).toBe('healthy');
    expect(report.issues.some((i: string) => i.includes('connection exhaustion'))).toBe(false);
  });

  it('reports critical when circuit breaker is open', async () => {
    const db = mockDbClient({
      stats: {
        primary: {
          name: 'primary',
          total: 5,
          idle: 2,
          waiting: 0,
          max: 10,
          circuitState: 'open',
        },
        replicas: [],
      },
    });
    db.readQuery.mockResolvedValue({ rows: [{ '?column?': 1 }] });

    const monitor = new DbHealthMonitor(db, logger);
    const report = await monitor.runCheck();

    expect(report.status).toBe('critical');
    expect(report.issues.some((i: string) => i.includes('circuit breaker'))).toBe(true);
  });

  it('reports circuit open on replica pool', async () => {
    const db = mockDbClient({
      stats: {
        primary: {
          name: 'primary',
          total: 5,
          idle: 2,
          waiting: 0,
          max: 10,
          circuitState: 'closed',
        },
        replicas: [
          {
            name: 'replica-0',
            total: 5,
            idle: 3,
            waiting: 0,
            max: 10,
            circuitState: 'open',
          },
        ],
      },
    });
    db.readQuery.mockResolvedValue({ rows: [{ '?column?': 1 }] });

    const monitor = new DbHealthMonitor(db, logger);
    const report = await monitor.runCheck();

    expect(report.status).toBe('critical');
    expect(report.issues.some((i: string) => i.includes('circuit breaker'))).toBe(true);
  });

  it('reports degraded when probe latency exceeds the threshold', async () => {
    const db = mockDbClient();
    // Simulate a slow query
    db.readQuery.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ rows: [{ '?column?': 1 }] }), 50)),
    );

    const monitor = new DbHealthMonitor(db, logger, {
      slowQueryThresholdMs: 25,
    });
    const reportPromise = monitor.runCheck();

    await vi.advanceTimersByTimeAsync(100);
    const report = await reportPromise;

    expect(report.status).toBe('degraded');
    expect(report.issues.some((i: string) => i.includes('probe latency'))).toBe(true);
  });

  it('does not alert when probe latency is within threshold', async () => {
    const db = mockDbClient();
    db.readQuery.mockResolvedValue({ rows: [{ '?column?': 1 }] });

    const monitor = new DbHealthMonitor(db, logger, {
      slowQueryThresholdMs: 5000,
    });
    const report = await monitor.runCheck();

    expect(report.status).toBe('healthy');
    expect(report.issues.some((i: string) => i.includes('probe latency'))).toBe(false);
  });

  it('reports critical when the liveness probe fails', async () => {
    const db = mockDbClient();
    db.readQuery.mockRejectedValue(new Error('connection refused'));

    const monitor = new DbHealthMonitor(db, logger);
    const report = await monitor.runCheck();

    expect(report.status).toBe('critical');
    expect(report.issues.some((i: string) => i.includes('liveness probe failed'))).toBe(true);
    expect(report.probeLatencyMs).toBe(-1);
  });

  it('reports degraded when replication lag exceeds threshold', async () => {
    const db = mockDbClient({
      stats: {
        primary: {
          name: 'primary',
          total: 5,
          idle: 2,
          waiting: 0,
          max: 10,
          circuitState: 'closed',
        },
        replicas: [
          {
            name: 'replica-0',
            total: 5,
            idle: 3,
            waiting: 0,
            max: 10,
            circuitState: 'closed',
          },
        ],
      },
    });
    db.readQuery
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [{ lag: '45' }] });

    const monitor = new DbHealthMonitor(db, logger, {
      replicationLagAlertMs: 30000,
    });
    const report = await monitor.runCheck();

    expect(report.status).toBe('degraded');
    expect(report.issues.some((i: string) => i.includes('Replication lag'))).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Replication lag'),
    );
  });

  it('does not alert when replication lag is within threshold', async () => {
    const db = mockDbClient();
    db.readQuery
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [{ lag: '5' }] });

    const monitor = new DbHealthMonitor(db, logger, {
      replicationLagAlertMs: 60000,
    });
    const report = await monitor.runCheck();

    expect(report.status).toBe('healthy');
    expect(report.issues.some((i: string) => i.includes('Replication lag'))).toBe(false);
  });

  it('handles replication lag query failure gracefully', async () => {
    const db = mockDbClient();
    db.readQuery
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockRejectedValueOnce(new Error('replica unavailable'));

    const monitor = new DbHealthMonitor(db, logger);
    const report = await monitor.runCheck();

    expect(report.issues.some((i: string) => i.includes('Replication lag'))).toBe(false);
  });

  it('reports critical when both circuit open and probe fail', async () => {
    const db = mockDbClient({
      stats: {
        primary: {
          name: 'primary',
          total: 5,
          idle: 2,
          waiting: 0,
          max: 10,
          circuitState: 'open',
        },
        replicas: [],
      },
    });
    db.readQuery.mockRejectedValue(new Error('connection refused'));

    const monitor = new DbHealthMonitor(db, logger);
    const report = await monitor.runCheck();

    expect(report.status).toBe('critical');
    expect(report.issues.length).toBeGreaterThanOrEqual(2);
  });

  it('reports degraded when exhaustion and lag are both issues', async () => {
    const db = mockDbClient({
      stats: {
        primary: {
          name: 'primary',
          total: 10,
          idle: 0,
          waiting: 9,
          max: 10,
          circuitState: 'closed',
        },
        replicas: [
          {
            name: 'replica-0',
            total: 5,
            idle: 3,
            waiting: 0,
            max: 10,
            circuitState: 'closed',
          },
        ],
      },
    });
    db.readQuery
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [{ lag: '60' }] });

    const monitor = new DbHealthMonitor(db, logger, {
      connectionExhaustionThreshold: 0.8,
      replicationLagAlertMs: 30000,
    });
    const report = await monitor.runCheck();

    expect(report.status).toBe('degraded');
    expect(report.issues.length).toBeGreaterThanOrEqual(2);
  });

  it('getLastReport returns undefined before any check', () => {
    const db = mockDbClient();
    const monitor = new DbHealthMonitor(db, logger);

    expect(monitor.getLastReport()).toBeUndefined();
  });

  it('getLastReport returns the most recent report after a check', async () => {
    const db = mockDbClient();
    db.readQuery.mockResolvedValue({ rows: [{ '?column?': 1 }] });

    const monitor = new DbHealthMonitor(db, logger);
    await monitor.runCheck();

    const report = monitor.getLastReport();
    expect(report).toBeDefined();
    expect(report!.status).toBe('healthy');
  });

  it('handles pool with max=0 without division by zero', async () => {
    const db = mockDbClient({
      stats: {
        primary: {
          name: 'primary',
          total: 0,
          idle: 0,
          waiting: 0,
          max: 0,
          circuitState: 'closed',
        },
        replicas: [],
      },
    });
    db.readQuery.mockResolvedValue({ rows: [{ '?column?': 1 }] });

    const monitor = new DbHealthMonitor(db, logger);
    const report = await monitor.runCheck();

    expect(report.status).toBe('healthy');
    expect(report.issues).toHaveLength(0);
  });
});
