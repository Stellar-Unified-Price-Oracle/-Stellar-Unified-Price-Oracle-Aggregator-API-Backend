import { describe, it, expect, afterEach } from 'vitest';
import { HealthServer, HealthSnapshot } from '../src/observability/health-server';

function snapshotWithPorts(ports: { base: number; ws: number; http: number }): HealthSnapshot {
  return {
    sourceHealth: {
      chainlink: { healthy: true, uptimePercent: 100, consecutiveFailures: 0 },
    },
    lastAggregated: [],
    uptime: 1,
    startupTimeMs: 1,
    ports,
  } as unknown as HealthSnapshot;
}

function snapshotWithFeedHealth(): HealthSnapshot {
  return {
    sourceHealth: {
      chainlink: { healthy: true, uptimePercent: 100, consecutiveFailures: 0 },
    },
    lastAggregated: [],
    uptime: 1,
    startupTimeMs: 1,
    feedHealth: {
      'eth-usd': {
        feed: 'eth-usd',
        region: 'us-east',
        lagMs: 120,
        lagP50Ms: 80,
        lagP95Ms: 200,
        lagP99Ms: 350,
        missingSequences: 0,
        healthy: true,
        degraded: false,
        lastUpdatedMs: 1,
      },
      'btc-usd': {
        feed: 'btc-usd',
        region: 'eu-west',
        lagMs: 5200,
        lagP50Ms: 4000,
        lagP95Ms: 6000,
        lagP99Ms: 7500,
        missingSequences: 3,
        healthy: false,
        degraded: true,
        lastUpdatedMs: 1,
      },
    },
    routing: {
      strategy: 'feed-health',
      degradedFeeds: ['btc-usd'],
      failoverActive: true,
      decisions: [
        { feed: 'eth-usd', selectedRegion: 'us-east', reason: 'healthy' },
        { feed: 'btc-usd', selectedRegion: 'us-west', reason: 'failover:degraded' },
      ],
    },
  } as unknown as HealthSnapshot;
}

describe('HealthServer per-feed lag and routing (#739, #740)', () => {
  let server: HealthServer | null = null;
  const port = 47322;

  afterEach(() => {
    server?.stop();
    server = null;
  });

  it('exposes per-feed lag distributions and missing sequences on /health', async () => {
    server = new HealthServer(port, () => snapshotWithFeedHealth());
    server.start();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const res = await fetch(`http://localhost:${port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      feedHealth?: Record<string, { lagMs: number; lagP95Ms: number; missingSequences: number; degraded: boolean }>;
    };
    expect(body.feedHealth).toBeDefined();
    expect(body.feedHealth?.['eth-usd'].lagMs).toBe(120);
    expect(body.feedHealth?.['eth-usd'].missingSequences).toBe(0);
    expect(body.feedHealth?.['btc-usd'].lagP95Ms).toBe(6000);
    expect(body.feedHealth?.['btc-usd'].missingSequences).toBe(3);
    expect(body.feedHealth?.['btc-usd'].degraded).toBe(true);
  });

  it('exposes routing state and failover decisions on /health', async () => {
    server = new HealthServer(port, () => snapshotWithFeedHealth());
    server.start();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const res = await fetch(`http://localhost:${port}/health`);
    const body = (await res.json()) as {
      routing?: { strategy: string; degradedFeeds: string[]; failoverActive: boolean; decisions: unknown[] };
    };
    expect(body.routing?.strategy).toBe('feed-health');
    expect(body.routing?.degradedFeeds).toEqual(['btc-usd']);
    expect(body.routing?.failoverActive).toBe(true);
    expect(body.routing?.decisions).toHaveLength(2);
  });

  it('reports not-ready when a feed is degraded', async () => {
    server = new HealthServer(port, () => snapshotWithFeedHealth());
    server.start();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const res = await fetch(`http://localhost:${port}/ready`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ready?: boolean; degradedFeeds?: string[] };
    expect(body.ready).toBe(false);
    expect(body.degradedFeeds).toContain('btc-usd');
  });

  it('reports ready when all feeds are healthy', async () => {
    const snap = snapshotWithFeedHealth();
    (snap as unknown as { feedHealth: Record<string, unknown> }).feedHealth = {
      'eth-usd': (snap as unknown as { feedHealth: Record<string, unknown> }).feedHealth['eth-usd'],
    };
    (snap as unknown as { routing: Record<string, unknown> }).routing = {
      strategy: 'feed-health',
      degradedFeeds: [],
      failoverActive: false,
      decisions: [{ feed: 'eth-usd', selectedRegion: 'us-east', reason: 'healthy' }],
    };
    server = new HealthServer(port, () => snap);
    server.start();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const res = await fetch(`http://localhost:${port}/ready`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ready?: boolean; degradedFeeds?: string[] };
    expect(body.ready).toBe(true);
    expect(body.degradedFeeds ?? []).toHaveLength(0);
  });

  it('omits feedHealth and routing when absent (back-compat)', async () => {
    server = new HealthServer(port, () => ({
      sourceHealth: { chainlink: { healthy: true, uptimePercent: 100, consecutiveFailures: 0 } },
      lastAggregated: [],
      uptime: 1,
    } as unknown as HealthSnapshot));
    server.start();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const res = await fetch(`http://localhost:${port}/health`);
    const body = (await res.json()) as Record<string, unknown>;
    expect('feedHealth' in body).toBe(false);
    expect('routing' in body).toBe(false);
  });
});

describe('HealthServer resolved ports (#590)', () => {
  let server: HealthServer | null = null;
  const port = 47321;

  afterEach(() => {
    server?.stop();
    server = null;
  });

  it('exposes the resolved ports on /health', async () => {
    const ports = { base: 4000, ws: 4001, http: 4002 };
    server = new HealthServer(port, () => snapshotWithPorts(ports));
    server.start();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const res = await fetch(`http://localhost:${port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ports?: { base: number; ws: number; http: number } };
    expect(body.ports).toEqual(ports);
    expect(body.ports?.http).toBe(body.ports ? body.ports.base + 2 : -1);
  });

  it('omits the ports field when the snapshot has none (back-compat)', async () => {
    server = new HealthServer(port, () => ({
      sourceHealth: { chainlink: { healthy: true, uptimePercent: 100, consecutiveFailures: 0 } },
      lastAggregated: [],
      uptime: 1,
    } as unknown as HealthSnapshot));
    server.start();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const res = await fetch(`http://localhost:${port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect('ports' in body).toBe(false);
  });
});
