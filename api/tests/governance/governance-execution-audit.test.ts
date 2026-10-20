import { describe, it, expect, beforeEach } from 'vitest';
import {
  publishReconciliationReport,
  reconcileGovernanceExecution,
} from '../../src/governance/decentralization/execution-audit';
import {
  getRemediation,
  remediationKey,
  resetForTesting,
  setRemediation,
} from '../../src/governance/decentralization/store';
import type {
  AuditableProposal,
  GovernanceState,
} from '../../src/governance/decentralization/types';
import type { ProposalAction } from '../../src/governance/proposal-types';

const NOW = 1_766_200_000;

const BASELINE: GovernanceState = {
  onchain: {
    'multisig.signers': ['GA', 'GB'],
    'multisig.threshold': 2,
    'oracle.sources': ['GSOURCE1'],
    'admin.address': 'GADMIN',
  },
  offchain: {},
};

function proposal(
  id: number,
  action: ProposalAction,
  overrides: Partial<AuditableProposal> = {},
): AuditableProposal {
  return {
    id,
    action,
    status: 'Executed',
    approvedAt: NOW - 86_400,
    executedAt: NOW - 3_600,
    ...overrides,
  };
}

function observe(patch: GovernanceState['onchain'] = {}): GovernanceState {
  return {
    onchain: {
      'multisig.signers': ['GC', 'GB'],
      'multisig.threshold': 3,
      'oracle.sources': ['GSOURCE1'],
      'admin.address': 'GADMIN',
      ...patch,
    },
    offchain: {},
  };
}

const EXECUTED_CHANGES: AuditableProposal[] = [
  proposal(10, { variant: 'SetThreshold', threshold: 3 }),
  proposal(11, { variant: 'AddSigner', signer: 'GC' }),
  proposal(12, { variant: 'RemoveSigner', signer: 'GA' }),
];

describe('governance execution reconciliation (#784)', () => {
  beforeEach(() => {
    resetForTesting();
  });

  it('matches observed state to the state approved proposals should produce', () => {
    const report = reconcileGovernanceExecution({
      baseline: BASELINE,
      proposals: EXECUTED_CHANGES,
      observed: observe({ 'multisig.signers': ['GB', 'GC'] }),
      now: NOW,
    });

    expect(report.discrepancies).toEqual([]);
    expect(report.appliedProposalIds).toEqual([10, 11, 12]);
    expect(report.matchedKeys).toContain('onchain:multisig.threshold');
    expect(report.matchedKeys).toContain('onchain:multisig.signers');
    expect(report.summary.critical).toBe(0);
  });

  it('reports a mismatch against the proposal that last wrote the key', () => {
    const report = reconcileGovernanceExecution({
      baseline: BASELINE,
      proposals: EXECUTED_CHANGES,
      observed: observe({ 'multisig.threshold': 2 }),
      now: NOW,
    });

    expect(report.discrepancies).toHaveLength(1);
    expect(report.discrepancies[0]).toMatchObject({
      key: 'multisig.threshold',
      kind: 'mismatch',
      severity: 'high',
      expected: 3,
      observed: 2,
      proposalIds: [10],
      remediationStatus: 'untriaged',
    });
  });

  it('reports a missing change when an approved effect never landed', () => {
    const observed = observe();
    delete observed.onchain['multisig.signers'];

    const report = reconcileGovernanceExecution({
      baseline: BASELINE,
      proposals: EXECUTED_CHANGES,
      observed,
      now: NOW,
    });

    const discrepancy = report.discrepancies.find((d) => d.kind === 'missing_change');
    expect(discrepancy?.key).toBe('multisig.signers');
    expect(discrepancy?.proposalIds).toEqual([11, 12]);
  });

  it('flags unattributable state as an unapproved change (critical)', () => {
    const report = reconcileGovernanceExecution({
      baseline: BASELINE,
      proposals: EXECUTED_CHANGES,
      observed: observe({ 'oracle.deviationThresholdBps': 500 }),
      now: NOW,
    });

    expect(report.discrepancies).toHaveLength(1);
    expect(report.discrepancies[0]).toMatchObject({
      key: 'oracle.deviationThresholdBps',
      kind: 'unapproved_change',
      severity: 'critical',
      proposalIds: [],
    });
  });

  it('applies removals and detects when a removed entry is still present', () => {
    const report = reconcileGovernanceExecution({
      baseline: BASELINE,
      proposals: [proposal(20, { variant: 'RemoveSource', source: 'GSOURCE1' })],
      observed: { onchain: { ...BASELINE.onchain }, offchain: {} },
      now: NOW,
    });

    const discrepancy = report.discrepancies.find((d) => d.key === 'oracle.sources');
    expect(discrepancy?.kind).toBe('mismatch');
    expect(discrepancy?.expected).toEqual([]);
    expect(discrepancy?.observed).toEqual(['GSOURCE1']);
  });

  it('expands UpdateGovernanceConfig into its on-chain keys', () => {
    const observed: GovernanceState = {
      onchain: {
        ...BASELINE.onchain,
        'governance.token': 'GTOKEN',
        'governance.votingPeriod': 604_800,
        'governance.timelockDelay': 172_800,
        'governance.quorum': 1_000,
        'governance.proposalThreshold': 100,
        'governance.guardian': 'GGUARDIAN',
      },
      offchain: {},
    };

    const report = reconcileGovernanceExecution({
      baseline: BASELINE,
      proposals: [
        proposal(30, {
          variant: 'UpdateGovernanceConfig',
          config: {
            token: 'GTOKEN',
            votingPeriod: 604_800,
            timelockDelay: 172_800,
            quorum: 1_000,
            proposalThreshold: 100,
            guardian: 'GGUARDIAN',
          },
        }),
      ],
      observed,
      now: NOW,
    });

    expect(report.discrepancies).toEqual([]);
    expect(report.matchedKeys).toContain('onchain:governance.quorum');
  });

  it('flags approved proposals that were never executed past the deadline', () => {
    const report = reconcileGovernanceExecution({
      baseline: BASELINE,
      proposals: [
        proposal(
          40,
          { variant: 'SetThreshold', threshold: 4 },
          { status: 'Queued', executedAt: undefined, approvedAt: NOW - 40 * 86_400 },
        ),
      ],
      observed: { onchain: { ...BASELINE.onchain }, offchain: {} },
      now: NOW,
    });

    const overdue = report.discrepancies.find((d) => d.kind === 'overdue_execution');
    expect(overdue).toMatchObject({
      key: 'proposal.40.execution',
      severity: 'medium',
      proposalIds: [40],
    });
    expect(report.pendingProposalIds).toEqual([40]);
  });

  it('flags executed proposals without an execution timestamp', () => {
    const report = reconcileGovernanceExecution({
      baseline: BASELINE,
      proposals: [
        proposal(
          50,
          { variant: 'SetThreshold', threshold: 4 },
          { executedAt: undefined },
        ),
      ],
      observed: { onchain: { ...BASELINE.onchain }, offchain: {} },
      now: NOW,
    });

    expect(report.discrepancies[0]).toMatchObject({
      kind: 'inconsistent_proposal',
      severity: 'critical',
      proposalIds: [50],
    });
  });

  it('fails closed on an action without a reconciliation mapping', () => {
    const report = reconcileGovernanceExecution({
      baseline: BASELINE,
      proposals: [
        proposal(60, { variant: 'FutureAction' } as unknown as ProposalAction),
      ],
      observed: { onchain: { ...BASELINE.onchain }, offchain: {} },
      now: NOW,
    });

    expect(report.discrepancies[0]).toMatchObject({
      kind: 'unverifiable_effect',
      severity: 'high',
      proposalIds: [60],
    });
  });

  it('carries remediation status onto later reconciliation runs', () => {
    const first = reconcileGovernanceExecution({
      baseline: BASELINE,
      proposals: EXECUTED_CHANGES,
      observed: observe({ 'oracle.deviationThresholdBps': 500 }),
      now: NOW,
    });
    expect(first.discrepancies[0].remediationStatus).toBe('untriaged');

    setRemediation(
      remediationKey('onchain', 'oracle.deviationThresholdBps', 'unapproved_change'),
      { status: 'resolved', owner: 'gov-ops', note: 'Reversed by proposal 91', updatedAt: NOW },
    );

    const second = reconcileGovernanceExecution({
      baseline: BASELINE,
      proposals: EXECUTED_CHANGES,
      observed: observe({ 'oracle.deviationThresholdBps': 500 }),
      now: NOW + 3_600,
    });

    expect(second.discrepancies[0].remediationStatus).toBe('resolved');
    expect(second.discrepancies[0].remediation?.owner).toBe('gov-ops');
    expect(second.summary.resolved).toBe(1);
    expect(second.summary.untriaged).toBe(0);
    expect(getRemediation(
      remediationKey('onchain', 'oracle.deviationThresholdBps', 'unapproved_change'),
    )?.status).toBe('resolved');
  });

  it('publishes a report without throwing and keeps its discrepancies', () => {
    const report = reconcileGovernanceExecution({
      baseline: BASELINE,
      proposals: EXECUTED_CHANGES,
      observed: observe({ 'multisig.threshold': 2 }),
      now: NOW,
    });

    const published = publishReconciliationReport(report);
    expect(published.id).toMatch(/^recon_/);
    expect(published.discrepancies).toHaveLength(1);
  });

  it('rejects a duplicated proposal id instead of double-applying it', () => {
    expect(() =>
      reconcileGovernanceExecution({
        baseline: BASELINE,
        proposals: [
          proposal(10, { variant: 'SetThreshold', threshold: 3 }),
          proposal(10, { variant: 'SetThreshold', threshold: 3 }),
        ],
        observed: observe(),
        now: NOW,
      }),
    ).toThrowError(/appears more than once/);
  });

  it('leaves unapproved proposals out of the expected state', () => {
    const report = reconcileGovernanceExecution({
      baseline: BASELINE,
      proposals: [
        proposal(
          70,
          { variant: 'SetThreshold', threshold: 5 },
          { status: 'Defeated', executedAt: undefined },
        ),
      ],
      observed: { onchain: { ...BASELINE.onchain }, offchain: {} },
      now: NOW,
    });

    expect(report.appliedProposalIds).toEqual([]);
    expect(report.discrepancies).toEqual([]);
  });
});
