import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { HealthServer } from '../src/observability/health-server';
import { PriceAggregator } from '../src/price-aggregation/aggregator';

vi.mock('../src/infrastructure/config', () => ({ config: { stalenessThresholdMs: 60000 } }));
vi.mock('../src/observability/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('../src/observability/alert-manager', () => ({ alertManager: { emit: vi.fn() } }));
vi.mock('../src/observability/metrics', () => ({ register: {} }));
vi.mock('../src/infrastructure/cost-model', () => ({ getDailyCounts: vi.fn(), getBudgetStatuses: vi.fn() }));
vi.mock('../src/persistence/uptime-history', () => ({ getDailyCounts: vi.fn(), getUptimeHistory: vi.fn(), getUptimeForPeriod: vi.fn(), getLatestUptime: vi.fn() }));
let health: HealthServer | undefined;
afterEach(() => health?.stop());

describe('selected evidence HTTP bundle', () => {
  it('serves only captured decisions, matches IDs and does not refresh on reads', async () => {
    const aggregator = new PriceAggregator();
    aggregator.updateSourcePrice({ asset: 'BTC', source: 'chainlink', price: 100n, decimals: 0, timestamp: Math.floor(Date.now() / 1000) });
    const result = aggregator.getLatestForAsset('BTC');
    health = new HealthServer(0, () => ({ sourceHealth: {}, lastAggregated: [], uptime: 1,
      evidence: asset => aggregator.getEvidence(asset) }));
    health.start();
    const server = (health as unknown as { server: Server }).server;
    if (!server.listening) await once(server, 'listening');
    const address = server.address() as { port: number };
    const base = `http://127.0.0.1:${address.port}/evidence/`;
    const response = await fetch(base + 'BTC');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const bundle = await response.json() as { id: string; result: unknown };
    expect(bundle.result).toEqual(JSON.parse(JSON.stringify(result)));
    expect(await (await fetch(base + 'btc?id=' + bundle.id)).json()).toEqual(bundle);
    expect((await fetch(base + 'BTC?id=older')).status).toBe(404);
    expect((await fetch(base + 'ETH')).status).toBe(404);
    expect((await fetch(base + '%3Csecret%3E')).status).toBe(404);
  });
});
