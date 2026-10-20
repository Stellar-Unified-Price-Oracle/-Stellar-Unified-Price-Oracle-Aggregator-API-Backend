import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../src/governance/auth', () => ({
  adminAuthMiddleware: () => (req: any, res: any, next: any) => {
    if (!req.headers['x-api-key']) {
      res.status(401).json({ success: false, error: { code: 'MISSING_API_KEY' } });
      return;
    }
    req.apiKey = 'admin_test_key';
    next();
  },
}));

vi.mock('../../src/governance/audit-logger', () => ({
  auditLog: vi.fn(),
}));

import decentralizationRoutes from '../../src/governance/decentralization/routes';
import { resetForTesting } from '../../src/governance/decentralization/store';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/governance/decentralization', decentralizationRoutes);
  return app;
}

const NOW = Math.floor(Date.now() / 1000);
const AUTH = { 'x-api-key': 'test-key' };

const SIGNERS = [
  {
    address: 'GAAA1',
    organization: 'Org A',
    custody: 'hsm',
    custodyProvider: 'provider-a',
    region: 'eu',
    addedAt: NOW - 400 * 86_400,
    lastRotatedAt: NOW - 10 * 86_400,
    availabilityPct: 99.9,
    conflicts: [],
  },
  {
    address: 'GAAA2',
    organization: 'Org B',
    custody: 'hardware_wallet',
    custodyProvider: 'provider-b',
    region: 'us',
    addedAt: NOW - 400 * 86_400,
    lastRotatedAt: NOW - 10 * 86_400,
    availabilityPct: 99.9,
    conflicts: [],
  },
  {
    address: 'GAAA3',
    organization: 'Org C',
    custody: 'cloud_kms',
    custodyProvider: 'provider-c',
    region: 'ap',
    addedAt: NOW - 400 * 86_400,
    lastRotatedAt: NOW - 10 * 86_400,
    availabilityPct: 99.9,
    conflicts: [],
  },
];

function weighted(prefix: string, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}${index + 1}`,
    weight: 1,
  }));
}

const SNAPSHOT = {
  capturedAt: NOW,
  provider: weighted('provider-', 7),
  signer: weighted('signer-', 7),
  governance: weighted('voter-', 10),
  region: weighted('region-', 4),
};

const GRANT = {
  id: 'grant-1',
  title: 'Oracle provider diversity study',
  recipient: 'Research Collective',
  owner: 'governance-council',
  objectives: [
    {
      id: 'providers-onboarded',
      description: 'Onboard independent oracle providers',
      metric: 'providers_onboarded',
      target: 3,
      unit: 'providers',
    },
  ],
  milestones: [
    {
      id: 'm1',
      title: 'Publish methodology',
      dueAt: NOW + 30 * 86_400,
      acceptanceCriteria: 'Public methodology document',
    },
  ],
  conflicts: { disclosed: false, conflicts: [] },
};

describe('decentralization governance routes (#782-#785)', () => {
  beforeEach(() => {
    resetForTesting();
  });

  it('requires admin authentication', async () => {
    const response = await request(makeApp()).get('/governance/decentralization/signers/independence');
    expect(response.status).toBe(401);
  });

  it('registers a signer roster and returns its independence report', async () => {
    const app = makeApp();
    const put = await request(app)
      .put('/governance/decentralization/signers')
      .set(AUTH)
      .send({ signers: SIGNERS });

    expect(put.status).toBe(200);
    expect(put.body.data.verdict).toBe('pass');
    expect(put.body.data.maxIndependentQuorum).toBe(3);

    const get = await request(app)
      .get('/governance/decentralization/signers/independence')
      .set(AUTH);

    expect(get.status).toBe(200);
    expect(get.body.data.signerCount).toBe(3);
  });

  it('returns 404 for independence before a roster exists', async () => {
    const response = await request(makeApp())
      .get('/governance/decentralization/signers/independence')
      .set(AUTH);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('SIGNER_ROSTER_NOT_SET');
  });

  it('rejects a signer payload that fails validation', async () => {
    const response = await request(makeApp())
      .put('/governance/decentralization/signers')
      .set(AUTH)
      .send({ signers: [{ address: 'GAAA1' }] });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_REQUEST');
  });

  it('records concentration snapshots and refuses an unearned stage transition', async () => {
    const app = makeApp();
    const recorded = await request(app)
      .post('/governance/decentralization/stage-gates/snapshots')
      .set(AUTH)
      .send(SNAPSHOT);

    expect(recorded.status).toBe(201);
    expect(recorded.body.data.achievedStage).toBe('stage-3');
    expect(recorded.body.data.eligibleForNextStage).toBe(false);

    const transition = await request(app)
      .post('/governance/decentralization/stage-gates/transition')
      .set(AUTH)
      .send({ stage: 'stage-1' });

    expect(transition.status).toBe(409);
    expect(transition.body.error.code).toBe('STAGE_GATE_NOT_MET');

    const current = await request(app)
      .get('/governance/decentralization/stage-gates')
      .set(AUTH);
    expect(current.status).toBe(200);
    expect(current.body.data.snapshotId).toBe(recorded.body.data.snapshotId);
  });

  it('publishes an execution reconciliation and records remediation', async () => {
    const app = makeApp();
    const audit = await request(app)
      .post('/governance/decentralization/execution-audit')
      .set(AUTH)
      .send({
        baseline: {
          onchain: { 'multisig.threshold': 2 },
          offchain: {},
        },
        observed: {
          onchain: { 'multisig.threshold': 2, 'oracle.deviationThresholdBps': 500 },
          offchain: {},
        },
        proposals: [
          {
            id: 1,
            status: 'Executed',
            action: { variant: 'SetThreshold', threshold: 2 },
            approvedAt: NOW - 86_400,
            executedAt: NOW - 3_600,
          },
        ],
      });

    expect(audit.status).toBe(201);
    expect(audit.body.data.discrepancies).toHaveLength(1);
    expect(audit.body.data.discrepancies[0].kind).toBe('unapproved_change');

    const reportId = audit.body.data.id;
    const remediation = await request(app)
      .post(`/governance/decentralization/execution-audit/${reportId}/remediation`)
      .set(AUTH)
      .send({
        key: 'oracle.deviationThresholdBps',
        surface: 'onchain',
        kind: 'unapproved_change',
        status: 'resolved',
        owner: 'gov-ops',
      });

    expect(remediation.status).toBe(200);
    expect(remediation.body.data.discrepancy.remediationStatus).toBe('resolved');
    expect(remediation.body.data.summary.resolved).toBe(1);

    const list = await request(app)
      .get('/governance/decentralization/execution-audit')
      .set(AUTH);
    expect(list.status).toBe(200);
    expect(list.body.data.reports).toHaveLength(1);
  });

  it('returns 404 for remediation against an unknown report', async () => {
    const response = await request(makeApp())
      .post('/governance/decentralization/execution-audit/recon_missing/remediation')
      .set(AUTH)
      .send({
        key: 'multisig.threshold',
        surface: 'onchain',
        kind: 'mismatch',
        status: 'open',
      });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('REPORT_NOT_FOUND');
  });

  it('registers a grant and exposes the outcomes report', async () => {
    const app = makeApp();
    const created = await request(app)
      .post('/governance/decentralization/grants')
      .set(AUTH)
      .send(GRANT);

    expect(created.status).toBe(201);
    expect(created.body.data.grantId).toBe('grant-1');
    expect(created.body.data.objectivesTotal).toBe(1);

    const report = await request(app)
      .get('/governance/decentralization/grants/outcomes/report')
      .set(AUTH);

    expect(report.status).toBe(200);
    expect(report.body.data.grantCount).toBe(1);
    expect(report.body.data.objectivesPublished).toBe(1);

    const list = await request(app).get('/governance/decentralization/grants').set(AUTH);
    expect(list.body.data.grants).toHaveLength(1);
  });

  it('rejects a grant without measurable objectives', async () => {
    const response = await request(makeApp())
      .post('/governance/decentralization/grants')
      .set(AUTH)
      .send({ ...GRANT, objectives: [] });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_REQUEST');
  });

  it('returns 404 for an unknown grant', async () => {
    const response = await request(makeApp())
      .get('/governance/decentralization/grants/missing')
      .set(AUTH);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('GRANT_NOT_FOUND');
  });

  it('requires verification evidence before an endpoint can complete a grant', async () => {
    const app = makeApp();
    await request(app).post('/governance/decentralization/grants').set(AUTH).send(GRANT);
    await request(app)
      .post('/governance/decentralization/grants/grant-1/status')
      .set(AUTH)
      .send({ status: 'approved' });
    await request(app)
      .post('/governance/decentralization/grants/grant-1/status')
      .set(AUTH)
      .send({ status: 'active' });

    const illegal = await request(app)
      .post('/governance/decentralization/grants/grant-1/status')
      .set(AUTH)
      .send({ status: 'completed' });
    expect(illegal.status).toBe(409);
    expect(illegal.body.error.code).toBe('EVIDENCE_MISSING_FOR_COMPLETION');

    const evidence = await request(app)
      .post('/governance/decentralization/grants/grant-1/milestones/m1/evidence')
      .set(AUTH)
      .send({
        uri: 'https://evidence.example.org/m1.pdf',
        sha256: 'a'.repeat(64),
        submittedAt: NOW - 100,
        verifiedAt: NOW - 50,
        verifiedBy: 'gov-ops',
      });
    expect(evidence.status).toBe(200);
    expect(evidence.body.data.evidenceCoverage).toBe(1);

    const completed = await request(app)
      .post('/governance/decentralization/grants/grant-1/status')
      .set(AUTH)
      .send({ status: 'completed' });
    expect(completed.status).toBe(200);
    expect(completed.body.data.status).toBe('completed');
  });
});
