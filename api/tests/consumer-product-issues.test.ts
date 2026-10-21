import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { buildQualityReport, recordLatencySample, resetForTesting } from '../src/price-serving/consumer/store';
import schemaRegistry from '../src/price-serving/consumer/schema-registry';
import qualityReportRoutes from '../src/price-serving/consumer/quality-report';
import { checkPolicyScope } from '../src/governance/api-key-manager';

vi.mock('../src/governance/auth', () => ({ authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next() }));

describe('consumer data products #711 and #713', () => {
  beforeEach(() => resetForTesting());

  it('returns deterministic coverage and quality for selected feeds, including no-data feeds', () => {
    recordLatencySample({ asset: 'xlm', region: 'global', observedAt: 100, deliveredAt: 110, latencyMs: 10, freshnessMs: 60_000 });
    const report = buildQualityReport(['XLM', 'BTC', 'XLM'], 90, 120);
    expect(report.feeds.map((feed) => [feed.asset, feed.status])).toEqual([['BTC', 'no_data'], ['XLM', 'measured']]);
    expect(report.coverage).toEqual({ requested: 2, measured: 1, ratio: 0.5 });
    expect(report.quality.ratio).toBe(1);
    expect(buildQualityReport(['XLM', 'BTC'], 90, 120).feeds).toEqual(report.feeds);
  });

  it('publishes versioned REST and streaming schema metadata', async () => {
    const app = express();
    app.use('/schemas', schemaRegistry);
    const response = await request(app).get('/schemas');
    expect(response.status).toBe(200);
    expect(response.body.registryVersion).toBe('1.0.0');
    expect(response.body.schemas.map((schema: { id: string }) => schema.id)).toContain('stream.replay_complete.v1');
    expect(response.body.compatibility.deprecationHeaders).toContain('Sunset');
  });

  it('serves a fixed-window selected-feed report and rejects unsupported windows', async () => {
    const app = express();
    app.use('/quality-report', qualityReportRoutes);
    recordLatencySample({ asset: 'XLM', region: 'global', observedAt: 100, deliveredAt: 110, latencyMs: 10, freshnessMs: 50 });
    const response = await request(app).get('/quality-report?assets=XLM,BTC&from=90&to=120');
    expect(response.status).toBe(200);
    expect(response.body.data.reportId).toMatch(/^[a-f0-9]{64}$/);
    expect(response.body.data.feeds.map((feed: { status: string }) => feed.status)).toEqual(['no_data', 'measured']);
    const invalid = await request(app).get('/quality-report?assets=XLM&from=90&to=3000000');
    expect(invalid.status).toBe(400);
  });
});

describe('consumer entitlement effective dates (#714)', () => {
  it('denies a future grant until activation and after expiry', () => {
    const policy = { feeds: ['XLM'], operations: ['read'], environments: ['production'], effectiveAt: 2000, expiresAt: 3000 };
    expect(checkPolicyScope(policy, { feed: 'XLM', operation: 'read', environment: 'production' }, 1999)).toEqual({ allowed: false, reason: 'not_yet_effective' });
    expect(checkPolicyScope(policy, { feed: 'XLM', operation: 'read', environment: 'production' }, 2000)).toEqual({ allowed: true });
    expect(checkPolicyScope(policy, { feed: 'BTC', operation: 'read', environment: 'production' }, 2500)).toEqual({ allowed: false, reason: 'feed' });
    expect(checkPolicyScope(policy, { feed: 'XLM', operation: 'read', environment: 'production' }, 3000)).toEqual({ allowed: false, reason: 'expired' });
  });
});
