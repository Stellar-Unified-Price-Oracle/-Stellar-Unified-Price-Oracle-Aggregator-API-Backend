import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildGrantStatusReport,
  grantOutcomesSummary,
  recordGrantOutcome,
  registerGrant,
  submitMilestoneEvidence,
  transitionGrantStatus,
} from '../../src/governance/decentralization/grant-outcomes';
import { resetForTesting, setGrantPolicy } from '../../src/governance/decentralization/store';
import type { GrantRecord } from '../../src/governance/decentralization/types';

const NOW = 1_766_200_000;
const SHA = 'a'.repeat(64);
const EVIDENCE_URI = 'https://evidence.example.org/milestone-1.pdf';

function grant(overrides: Partial<GrantRecord> = {}): GrantRecord {
  return {
    id: 'grant-1',
    title: 'Oracle provider diversity study',
    recipient: 'Research Collective',
    owner: 'governance-council',
    status: 'proposed',
    objectives: [
      {
        id: 'providers-onboarded',
        description: 'Onboard independent oracle providers',
        metric: 'providers_onboarded',
        target: 3,
        unit: 'providers',
        direction: 'min',
      },
      {
        id: 'cost-per-feed',
        description: 'Keep the delivery cost per feed under budget',
        metric: 'cost_per_feed',
        target: 12,
        unit: 'USD',
        direction: 'max',
      },
    ],
    milestones: [
      {
        id: 'm1',
        title: 'Publish methodology',
        dueAt: NOW - 10 * 86_400,
        acceptanceCriteria: 'Public methodology document with reproducible measurements',
      },
    ],
    conflicts: { disclosed: false, conflicts: [] },
    ...overrides,
  };
}

function verifiedEvidence(submittedAt = NOW - 60 * 86_400, verifiedAt = NOW - 50 * 86_400) {
  return {
    uri: EVIDENCE_URI,
    sha256: SHA,
    submittedAt,
    verifiedAt,
    verifiedBy: 'gov-ops',
  };
}

function completedGrant(overrides: Partial<GrantRecord> = {}): GrantRecord {
  return grant({
    status: 'completed',
    completedAt: NOW - 40 * 86_400,
    milestones: [
      {
        id: 'm1',
        title: 'Publish methodology',
        dueAt: NOW - 60 * 86_400,
        acceptanceCriteria: 'Public methodology document',
        evidence: verifiedEvidence(),
      },
    ],
    ...overrides,
  });
}

describe('grant outcome tracking (#785)', () => {
  beforeEach(() => {
    resetForTesting();
  });

  it('registers a grant with measurable objectives and reports pending evidence', () => {
    const registered = registerGrant(grant());

    expect(registered.status).toBe('proposed');
    const report = buildGrantStatusReport(registered, NOW);
    expect(report.evidenceCoverage).toBe(0);
    expect(report.outcomeStatus).toBe('not_due');
    expect(report.violations).toContain('MILESTONE_OVERDUE:m1');
    expect(report.attainment.map((entry) => entry.met)).toEqual([null, null]);
  });

  it('rejects a grant with no measurable objectives', () => {
    expect(() => registerGrant(grant({ objectives: [] }))).toThrowError(
      /at least one measurable objective/,
    );
  });

  it('rejects an objective without a metric or numeric target', () => {
    const objectives = [
      {
        ...grant().objectives[0],
        metric: ' ',
      },
    ];
    expect(() => registerGrant(grant({ objectives }))).toThrowError(/description, metric and unit/);

    const badTarget = [{ ...grant().objectives[0], target: Number.NaN }];
    expect(() => registerGrant(grant({ objectives: badTarget }))).toThrowError(/numeric target/);
  });

  it('rejects duplicate objective and milestone identifiers', () => {
    const objectives = [grant().objectives[0], grant().objectives[0]];
    expect(() => registerGrant(grant({ objectives }))).toThrowError(/duplicated/);

    const milestones = [grant().milestones[0], grant().milestones[0]];
    expect(() => registerGrant(grant({ milestones }))).toThrowError(/duplicated/);
  });

  it('fails closed when conflicts are not explicitly disclosed', () => {
    expect(() =>
      registerGrant(grant({ conflicts: {} as GrantRecord['conflicts'] })),
    ).toThrowError(/explicitly disclose or deny/);
  });

  it('rejects a denial that still lists a conflict', () => {
    expect(() =>
      registerGrant(
        grant({
          conflicts: {
            disclosed: false,
            conflicts: [
              { party: 'Board member', relationship: 'board', mitigation: 'Recused' },
            ],
          },
        }),
      ),
    ).toThrowError(/declaration is inconsistent/);
  });

  it('requires every disclosed conflict to carry a mitigation', () => {
    expect(() =>
      registerGrant(
        grant({
          conflicts: {
            disclosed: true,
            conflicts: [{ party: 'Vendor', relationship: 'equity', mitigation: '' }],
          },
        }),
      ),
    ).toThrowError(/party, relationship and mitigation/);
  });

  it('rejects duplicate grant ids', () => {
    registerGrant(grant());
    expect(() => registerGrant(grant())).toThrowError(/already registered/);
  });

  it('rejects evidence without a pinned digest or a non-http URL', () => {
    registerGrant(grant());

    expect(() =>
      submitMilestoneEvidence('grant-1', 'm1', {
        uri: EVIDENCE_URI,
        sha256: 'not-a-digest',
        submittedAt: NOW,
      }),
    ).toThrowError(/sha256/);

    expect(() =>
      submitMilestoneEvidence('grant-1', 'm1', {
        uri: 'ipfs://evidence',
        sha256: SHA,
        submittedAt: NOW,
      }),
    ).toThrowError(/http\(s\)/);
  });

  it('requires a named verifier when evidence is marked verified', () => {
    registerGrant(grant());

    expect(() =>
      submitMilestoneEvidence('grant-1', 'm1', {
        uri: EVIDENCE_URI,
        sha256: SHA,
        submittedAt: NOW - 10,
        verifiedAt: NOW,
      }),
    ).toThrowError(/name the verifier/);
  });

  it('blocks completion until every milestone has verified evidence', () => {
    registerGrant(grant());
    transitionGrantStatus('grant-1', 'approved', NOW);
    transitionGrantStatus('grant-1', 'active', NOW);

    expect(() => transitionGrantStatus('grant-1', 'completed', NOW)).toThrowError(
      /milestones without verified evidence/,
    );
  });

  it('completes a grant once verified evidence covers every milestone', () => {
    registerGrant(grant());
    transitionGrantStatus('grant-1', 'approved', NOW);
    transitionGrantStatus('grant-1', 'active', NOW);
    submitMilestoneEvidence('grant-1', 'm1', verifiedEvidence());
    const completed = transitionGrantStatus('grant-1', 'completed', NOW);

    expect(completed.status).toBe('completed');
    expect(completed.completedAt).toBe(NOW);
    expect(buildGrantStatusReport(completed, NOW).evidenceCoverage).toBe(1);
  });

  it('keeps verified evidence immutable', () => {
    registerGrant(grant());
    submitMilestoneEvidence('grant-1', 'm1', verifiedEvidence());

    expect(() =>
      submitMilestoneEvidence('grant-1', 'm1', {
        uri: 'https://evidence.example.org/replacement.pdf',
        sha256: 'b'.repeat(64),
        submittedAt: NOW,
      }),
    ).toThrowError(/cannot be replaced/);
  });

  it('rejects an outcome before the grant is completed', () => {
    registerGrant(grant());

    expect(() =>
      recordGrantOutcome('grant-1', {
        summary: 'Premature report',
        results: [{ objectiveId: 'providers-onboarded', actual: 3, evidenceUri: EVIDENCE_URI }],
      }),
    ).toThrowError(/only be recorded for completed grants/);
  });

  it('records a post-completion outcome and measures objective attainment', () => {
    registerGrant(completedGrant());

    const updated = recordGrantOutcome(
      'grant-1',
      {
        summary: 'Three providers onboarded and the per-feed cost held at 11 USD',
        results: [
          { objectiveId: 'providers-onboarded', actual: 3, evidenceUri: EVIDENCE_URI },
          { objectiveId: 'cost-per-feed', actual: 11, evidenceUri: EVIDENCE_URI },
        ],
      },
      NOW,
    );

    const report = buildGrantStatusReport(updated, NOW);
    expect(report.outcomeStatus).toBe('recorded');
    expect(report.objectivesMet).toBe(2);
    expect(report.attainment).toEqual([
      { objectiveId: 'providers-onboarded', target: 3, actual: 3, unit: 'providers', met: true },
      { objectiveId: 'cost-per-feed', target: 12, actual: 11, unit: 'USD', met: true },
    ]);
  });

  it('treats a max-direction objective above target as unmet', () => {
    registerGrant(completedGrant());
    const updated = recordGrantOutcome(
      'grant-1',
      {
        summary: 'Cost overrun',
        results: [
          { objectiveId: 'providers-onboarded', actual: 3, evidenceUri: EVIDENCE_URI },
          { objectiveId: 'cost-per-feed', actual: 20, evidenceUri: EVIDENCE_URI },
        ],
      },
      NOW,
    );

    const report = buildGrantStatusReport(updated, NOW);
    expect(report.attainment.find((entry) => entry.objectiveId === 'cost-per-feed')?.met).toBe(
      false,
    );
    expect(report.objectivesMet).toBe(1);
  });

  it('rejects an outcome that omits an objective', () => {
    registerGrant(completedGrant());

    expect(() =>
      recordGrantOutcome(
        'grant-1',
        {
          summary: 'Partial report',
          results: [
            { objectiveId: 'providers-onboarded', actual: 3, evidenceUri: EVIDENCE_URI },
          ],
        },
        NOW,
      ),
    ).toThrowError(/does not report objective/);
  });

  it('rejects an outcome that references an unpublished objective', () => {
    registerGrant(completedGrant());

    expect(() =>
      recordGrantOutcome(
        'grant-1',
        {
          summary: 'Unknown objective',
          results: [
            { objectiveId: 'not-published', actual: 1, evidenceUri: EVIDENCE_URI },
          ],
        },
        NOW,
      ),
    ).toThrowError(/unknown objective/);
  });

  it('rejects a second outcome report', () => {
    registerGrant(completedGrant());
    const results = [
      { objectiveId: 'providers-onboarded', actual: 3, evidenceUri: EVIDENCE_URI },
      { objectiveId: 'cost-per-feed', actual: 11, evidenceUri: EVIDENCE_URI },
    ];
    recordGrantOutcome('grant-1', { summary: 'First', results }, NOW);

    expect(() =>
      recordGrantOutcome('grant-1', { summary: 'Second', results }, NOW),
    ).toThrowError(/already has an outcome/);
  });

  it('summarises overdue outcomes and fails the program verdict', () => {
    registerGrant(completedGrant());
    setGrantPolicy({ outcomeWindowDays: 30 });

    const summary = grantOutcomesSummary(NOW);

    expect(summary.grantCount).toBe(1);
    expect(summary.completed).toBe(1);
    expect(summary.evidenceCoverage).toBe(1);
    expect(summary.outcomesOverdue).toEqual(['grant-1']);
    expect(summary.verdict).toBe('fail');
    expect(summary.grants[0].outcomeStatus).toBe('overdue');
  });

  it('returns a passing program verdict when outcomes are reported within the window', () => {
    registerGrant(completedGrant({ completedAt: NOW - 5 * 86_400 }));
    recordGrantOutcome(
      'grant-1',
      {
        summary: 'All objectives reported on time',
        results: [
          { objectiveId: 'providers-onboarded', actual: 4, evidenceUri: EVIDENCE_URI },
          { objectiveId: 'cost-per-feed', actual: 10, evidenceUri: EVIDENCE_URI },
        ],
      },
      NOW,
    );

    const summary = grantOutcomesSummary(NOW);
    expect(summary.verdict).toBe('pass');
    expect(summary.attainmentRate).toBe(1);
    expect(summary.objectivesMet).toBe(2);
  });

  it('rejects an illegal status transition', () => {
    registerGrant(grant());
    transitionGrantStatus('grant-1', 'approved', NOW);
    transitionGrantStatus('grant-1', 'active', NOW);
    expect(() => transitionGrantStatus('grant-1', 'approved', NOW)).toThrowError(
      /cannot move from active to approved/,
    );
  });
});