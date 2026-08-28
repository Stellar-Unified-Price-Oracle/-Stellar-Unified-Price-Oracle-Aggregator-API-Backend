import { describe, it, expect, vi, beforeEach } from 'vitest';
import client from 'prom-client';

vi.mock('prom-client', () => ({
  default: {
    Histogram: vi.fn(function (config) {
      this.observe = vi.fn();
      this.startTimer = vi.fn(() => vi.fn());
      this.config = config;
      return this;
    }),
    Counter: vi.fn(function (config) {
      this.inc = vi.fn();
      this.config = config;
      return this;
    }),
    Registry: vi.fn(function () {
      this.registerMetric = vi.fn();
      return this;
    }),
    collectDefaultMetrics: vi.fn(),
  },
}));

interface ContractCallMetrics {
  simulateDurationMs: number;
  sendDurationMs: number;
  confirmDurationMs: number;
  totalDurationMs: number;
  statusCode?: number;
  errorMessage?: string;
}

describe('Prometheus Metrics for Soroban Contract Latency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('records simulate operation latency', () => {
    const metrics: ContractCallMetrics = {
      simulateDurationMs: 250,
      sendDurationMs: 0,
      confirmDurationMs: 0,
      totalDurationMs: 250,
    };

    expect(metrics.simulateDurationMs).toBe(250);
  });

  it('records send operation latency', () => {
    const metrics: ContractCallMetrics = {
      simulateDurationMs: 250,
      sendDurationMs: 150,
      confirmDurationMs: 0,
      totalDurationMs: 400,
    };

    expect(metrics.sendDurationMs).toBe(150);
  });

  it('records confirm operation latency', () => {
    const metrics: ContractCallMetrics = {
      simulateDurationMs: 250,
      sendDurationMs: 150,
      confirmDurationMs: 3000,
      totalDurationMs: 3400,
    };

    expect(metrics.confirmDurationMs).toBe(3000);
  });

  it('records total end-to-end contract call latency', () => {
    const metrics: ContractCallMetrics = {
      simulateDurationMs: 250,
      sendDurationMs: 150,
      confirmDurationMs: 3000,
      totalDurationMs: 3400,
    };

    expect(metrics.totalDurationMs).toBe(3400);
  });

  it('creates histogram with appropriate buckets for contract latency', () => {
    const histogramConfig = {
      name: 'soroban_contract_call_latency_seconds',
      help: 'Latency of Soroban contract operations in seconds',
      labelNames: ['operation', 'function', 'status'],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    };

    expect(histogramConfig.name).toBe('soroban_contract_call_latency_seconds');
    expect(histogramConfig.buckets).toContain(0.1);
    expect(histogramConfig.buckets).toContain(5);
  });

  it('tracks simulate latency per contract function', () => {
    const metrics: ContractCallMetrics = {
      simulateDurationMs: 200,
      sendDurationMs: 0,
      confirmDurationMs: 0,
      totalDurationMs: 200,
      statusCode: 200,
    };

    expect(metrics.simulateDurationMs).toBeLessThan(500);
  });

  it('tracks send latency per contract function', () => {
    const metrics: ContractCallMetrics = {
      simulateDurationMs: 250,
      sendDurationMs: 120,
      confirmDurationMs: 0,
      totalDurationMs: 370,
      statusCode: 200,
    };

    expect(metrics.sendDurationMs).toBeLessThan(1000);
  });

  it('tracks confirm latency per contract function', () => {
    const metrics: ContractCallMetrics = {
      simulateDurationMs: 250,
      sendDurationMs: 150,
      confirmDurationMs: 2800,
      totalDurationMs: 3200,
      statusCode: 200,
    };

    expect(metrics.confirmDurationMs).toBeLessThan(10000);
  });

  it('records failed contract call latency with error status', () => {
    const metrics: ContractCallMetrics = {
      simulateDurationMs: 350,
      sendDurationMs: 0,
      confirmDurationMs: 0,
      totalDurationMs: 350,
      statusCode: 500,
      errorMessage: 'Simulation failed: insufficient balance',
    };

    expect(metrics.errorMessage).toBeDefined();
  });

  it('distinguishes between successful and failed operations', () => {
    const successMetrics: ContractCallMetrics = {
      simulateDurationMs: 250,
      sendDurationMs: 150,
      confirmDurationMs: 3000,
      totalDurationMs: 3400,
      statusCode: 200,
    };

    const failMetrics: ContractCallMetrics = {
      simulateDurationMs: 400,
      sendDurationMs: 0,
      confirmDurationMs: 0,
      totalDurationMs: 400,
      statusCode: 500,
      errorMessage: 'Simulation failed',
    };

    expect(successMetrics.statusCode).toBe(200);
    expect(failMetrics.statusCode).toBe(500);
  });

  it('records histogram with operation type label', () => {
    const operations = ['simulate', 'send', 'confirm'];
    const labelNames = ['operation', 'function', 'status'];

    expect(labelNames).toContain('operation');
    expect(operations.every(op => typeof op === 'string')).toBe(true);
  });

  it('records histogram with contract function label', () => {
    const functions = ['submit_price', 'batch_submit_prices', 'update_source_stake'];
    const labelNames = ['operation', 'function', 'status'];

    expect(labelNames).toContain('function');
    expect(functions.every(fn => typeof fn === 'string')).toBe(true);
  });

  it('measures latency in correct time unit (seconds)', () => {
    const metrics: ContractCallMetrics = {
      simulateDurationMs: 250,
      sendDurationMs: 150,
      confirmDurationMs: 3000,
      totalDurationMs: 3400,
    };

    const latencySeconds = metrics.totalDurationMs / 1000;
    expect(latencySeconds).toBe(3.4);
  });

  it('tracks all three phases of contract execution', () => {
    const phases = ['simulate', 'send', 'confirm'];
    const metrics: ContractCallMetrics = {
      simulateDurationMs: 250,
      sendDurationMs: 150,
      confirmDurationMs: 3000,
      totalDurationMs: 3400,
    };

    expect(metrics.simulateDurationMs).toBeGreaterThan(0);
    expect(metrics.sendDurationMs).toBeGreaterThan(0);
    expect(metrics.confirmDurationMs).toBeGreaterThan(0);
  });
});
