import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import transparencyRoutes from '../../src/governance/transparency/routes';
import { runGovernanceRehearsal } from '../../src/governance/transparency/rehearsal';

const app = express();
app.use('/api/v1/governance', transparencyRoutes);

const GOVERNANCE_SNAPSHOT = {
  asOf: '2026-10-20T00:00:00.000Z',
  network: 'testnet',
  token: { symbol: 'ORACLE', decimals: 7 },
  eligibleVoters: 50,
  totalVotingPower: '1000000',
  delegations: [
    { delegator: 'GDELEGATORA', delegate: 'GDELEGATEA', power: '100' },
    { delegator: 'GDELEGATORB', delegate: 'GDELEGATEB', power: '100' },
    { delegator: 'GDELEGATORC', delegate: 'GDELEGATEC', power: '100' },
    { delegator: 'GDELEGATORD', delegate: 'GDELEGATED', power: '100' },
    { delegator: 'GDELEGATORE', delegate: 'GDELEGATEE', power: '100' },
    { delegator: 'GDELEGATORF', delegate: 'GDELEGATEF', power: '100' },
    { delegator: 'GDELEGATORG', delegate: 'GDELEGATEG', power: '100' },
    { delegator: 'GDELEGATORH', delegate: 'GDELEGATEH', power: '100' },
    { delegator: 'GDELEGATORI', delegate: 'GDELEGATEI', power: '100' },
    { delegator: 'GDELEGATORJ', delegate: 'GDELEGATEJ', power: '100' },
  ],
  proposals: [
    {
      id: 1,
      status: 'Executed',
      votesFor: '400000',
      votesAgainst: '100000',
      eligibleVotingPower: '1000000',
      quorumRequired: '200000',
      voters: 25,
    },
  ],
};

const TREASURY_SNAPSHOT = {
  asOf: new Date().toISOString(),
  network: 'testnet',
  treasuryAccount: 'GTREASURYACCOUNT000000000000000000000000000000000000',
  updateCadenceHours: 24,
  assets: [
    {
      asset: 'XLM',
      decimals: 7,
      openingBalance: '1000000000',
      closingBalance: '1100000000',
      source: { kind: 'account', ref: 'GTREASURYACCOUNT' },
    },
  ],
  policy: {
    version: '2026-Q4',
    approvedAt: '2026-10-01T00:00:00.000Z',
    approvedBy: 'Treasury Committee',
    reference: 'https://github.com/Stellar-Unified-Price-Oracle/docs/treasury-policy',
    allocations: [{ policy: 'operations', targetShareBps: 10000 }],
  },
  entries: [
    {
      id: 'in-1',
      timestamp: '2026-10-19T10:00:00.000Z',
      direction: 'inflow',
      asset: 'XLM',
      amount: '200000000',
      category: 'slash',
      policy: 'operations',
      source: { kind: 'transaction', ref: 'abc123', url: 'https://stellar.expert/tx/abc123' },
    },
    {
      id: 'out-1',
      timestamp: '2026-10-19T12:00:00.000Z',
      direction: 'outflow',
      asset: 'XLM',
      amount: '100000000',
      category: 'audit',
      policy: 'operations',
      source: { kind: 'invoice', ref: 'invoice-1' },
    },
  ],
};

const RELEASE_CALENDAR = {
  asOf: '2026-10-20T00:00:00.000Z',
  releases: [
    {
      id: 'rel-1',
      version: 'v1.3.0',
      summary: 'Deviation threshold update',
      owner: 'Release Management',
      changes: [{ class: 'contract', description: 'SetDeviationThreshold(500)' }],
      announcedAt: '2026-10-01T00:00:00.000Z',
      releaseAt: '2026-10-22T00:00:00.000Z',
      feedbackChannels: ['https://github.com/Stellar-Unified-Price-Oracle/issues/1'],
      status: 'planned',
    },
  ],
};

let dir: string;

function write(name: string, payload: unknown): void {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(payload));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'governance-transparency-'));
  process.env.GOVERNANCE_TRANSPARENCY_DIR = dir;
  write('governance-snapshot.json', GOVERNANCE_SNAPSHOT);
  write('treasury-snapshot.json', TREASURY_SNAPSHOT);
  write('release-review.json', RELEASE_CALENDAR);
  write('rehearsal-report.json', runGovernanceRehearsal());
});

afterEach(() => {
  delete process.env.GOVERNANCE_TRANSPARENCY_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('governance transparency routes', () => {
  it('serves governance health with privacy-safe delegation aggregates', async () => {
    const res = await request(app).get('/api/v1/governance/health?trailingWindow=5');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.body.success).toBe(true);
    expect(res.body.data.quorum.attainmentRate).toBe(1);
    expect(res.body.data.delegation.delegateCount).toBe(10);
    expect(res.body.data.methodology.privacy.minCohortSize).toBe(10);
    expect(JSON.stringify(res.body)).not.toContain('GDELEGATE');
  });

  it('rejects an invalid trailing window', async () => {
    const res = await request(app).get('/api/v1/governance/health?trailingWindow=0');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
  });

  it('serves treasury reconciliation, filters by asset, and paginates the ledger', async () => {
    const all = await request(app).get('/api/v1/governance/treasury');
    expect(all.status).toBe(200);
    expect(all.body.data.status).toBe('reconciled');
    expect(all.body.data.ledger).toHaveLength(2);

    const filtered = await request(app).get('/api/v1/governance/treasury?asset=XLM&limit=1');
    expect(filtered.status).toBe(200);
    expect(filtered.body.data.reconciliation.assets).toHaveLength(1);
    expect(filtered.body.data.ledger).toHaveLength(1);
    expect(filtered.body.data.provenance.entries).toBe(2);

    const unknown = await request(app).get('/api/v1/governance/treasury?asset=USDC');
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('TREASURY_ASSET_NOT_FOUND');
  });

  it('serves release review windows and filters by lifecycle status', async () => {
    const all = await request(app).get('/api/v1/governance/release-windows');
    expect(all.status).toBe(200);
    expect(all.body.data.releases).toHaveLength(1);
    expect(all.body.data.feedbackChannels.length).toBeGreaterThan(0);

    const withdrawn = await request(app).get('/api/v1/governance/release-windows?status=withdrawn');
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body.data.releases).toHaveLength(0);
  });

  it('serves the latest published rehearsal report', async () => {
    const res = await request(app).get('/api/v1/governance/rehearsals/latest');

    expect(res.status).toBe(200);
    expect(res.body.data.summary.verdict).toBe('passed');
    expect(res.body.data.network).toBe('local-simulation');
    expect(res.body.data.source.modifiedAt).toBeTruthy();
  });

  it('lists the published transparency artifacts with owners and cadences', async () => {
    const res = await request(app).get('/api/v1/governance/transparency');

    expect(res.status).toBe(200);
    expect(res.body.data.artifacts).toHaveLength(4);
    expect(res.body.data.artifacts.map((artifact: { issue: number }) => artifact.issue)).toEqual([
      777, 779, 780, 781,
    ]);
  });

  it('returns 404 when a snapshot has not been published', async () => {
    fs.rmSync(path.join(dir, 'governance-snapshot.json'));

    const res = await request(app).get('/api/v1/governance/health');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('GOVERNANCE_DATA_UNAVAILABLE');
  });

  it('returns 422 when a published snapshot is not valid JSON', async () => {
    fs.writeFileSync(path.join(dir, 'treasury-snapshot.json'), '{');

    const res = await request(app).get('/api/v1/governance/treasury');

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('GOVERNANCE_DATA_INVALID');
  });

  it('returns 422 when a snapshot does not match the published schema', async () => {
    write('release-review.json', { asOf: 'not-a-date', releases: [] });

    const res = await request(app).get('/api/v1/governance/release-windows');

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('GOVERNANCE_DATA_INVALID');
  });
});

describe('treasury dashboard page', () => {
  it('ships a static page that reads the published treasury endpoint', () => {
    const htmlPath = path.resolve(__dirname, '../../public/governance/treasury.html');
    const scriptPath = path.resolve(__dirname, '../../public/governance/treasury.js');

    expect(fs.existsSync(htmlPath)).toBe(true);
    expect(fs.existsSync(scriptPath)).toBe(true);

    const html = fs.readFileSync(htmlPath, 'utf-8');
    const script = fs.readFileSync(scriptPath, 'utf-8');

    expect(html).toContain('/portal/governance/treasury.js');
    expect(script).toContain('/api/v1/governance/treasury');
  });
});
