import { describe, it, expect } from 'vitest';
import {
  computeGovernanceHealth,
  delegationHealth,
  giniCoefficient,
} from '../../src/governance/transparency/governance-health';
import type { GovernanceSnapshot } from '../../src/governance/transparency/schema';

const NOW = new Date('2026-10-20T12:00:00.000Z');

function baselineSnapshot(): GovernanceSnapshot {
  const powers = [100, 90, 80, 70, 60, 50, 40, 30, 20, 10];
  return {
    asOf: '2026-10-20T00:00:00.000Z',
    network: 'testnet',
    token: { symbol: 'ORACLE', decimals: 7 },
    eligibleVoters: 100,
    totalVotingPower: '1000000',
    delegations: powers.map((power, index) => ({
      delegator: `GDELEGATOR${index.toString().padStart(2, '0')}`,
      delegate: `GDELEGATE${index.toString().padStart(2, '0')}`,
      power: String(power),
    })),
    proposals: [
      {
        id: 1,
        status: 'Executed',
        votesFor: '300000',
        votesAgainst: '100000',
        eligibleVotingPower: '1000000',
        quorumRequired: '200000',
        voters: 40,
      },
      {
        id: 2,
        status: 'Defeated',
        votesFor: '100000',
        votesAgainst: '50000',
        eligibleVotingPower: '1000000',
        quorumRequired: '200000',
        voters: 20,
      },
    ],
  };
}

describe('governance health (#777)', () => {
  it('derives participation, quorum, delegation and abstention metrics from a snapshot', () => {
    const report = computeGovernanceHealth(baselineSnapshot(), { now: NOW });

    expect(report.participation.voterTurnout).toBe(0.3);
    expect(report.participation.powerTurnout).toBe(0.275);
    expect(report.participation.proposalsMeasured).toBe(2);

    expect(report.quorum.proposalsMeasured).toBe(2);
    expect(report.quorum.attainmentRate).toBe(0.5);
    expect(report.quorum.averageMarginBps).toBe(3750);
    expect(report.quorum.proposals.map((proposal) => proposal.marginBps)).toEqual([-2500, 10000]);

    expect(report.delegation.available).toBe(true);
    expect(report.delegation.delegateCount).toBe(10);
    expect(report.delegation.hhi).toBeCloseTo(0.1273, 4);
    expect(report.delegation.concentration).toBe('low');
    expect(report.delegation.topDelegateShare).toBeCloseTo(0.1818, 4);
    expect(report.delegation.top5Share).toBeCloseTo(0.7273, 4);
    expect(report.delegation.delegatedShareOfPower).toBeCloseTo(0.00055, 6);

    expect(report.abstention.nonParticipationRate).toBe(0.725);
    expect(report.abstention.explicitAbstainSupported).toBe(false);
    expect(report.abstention.explicitAbstentionRate).toBeNull();

    expect(report.freshness.status).toBe('fresh');
    expect(report.alerts).toEqual([]);
  });

  it('suppresses delegation statistics below the k-anonymity cohort floor', () => {
    const snapshot = baselineSnapshot();
    snapshot.delegations = snapshot.delegations.slice(0, 9);

    const report = computeGovernanceHealth(snapshot, { now: NOW });

    expect(report.delegation.available).toBe(false);
    expect(report.delegation.suppressed).toBe(true);
    expect(report.delegation.reason).toBe('cohort_below_minimum');
    expect(report.delegation.hhi).toBeNull();
    expect(report.delegation.gini).toBeNull();
    expect(report.delegation.topDelegateShare).toBeNull();
    expect(report.delegation.delegateCount).toBeNull();
    expect(report.alerts).toContainEqual(expect.stringContaining('delegation_metrics_suppressed'));
  });

  it('reports delegation statistics at exactly the cohort floor', () => {
    const snapshot = baselineSnapshot();
    snapshot.delegations = snapshot.delegations.slice(0, 10);

    const health = delegationHealth(snapshot, 10);
    expect(health.available).toBe(true);
    expect(health.suppressed).toBe(false);
  });

  it('never publishes voter, delegator or delegate addresses', () => {
    const report = computeGovernanceHealth(baselineSnapshot(), { now: NOW });
    const serialized = JSON.stringify(report);

    expect(serialized).not.toContain('GDELEGATE');
    expect(serialized).not.toContain('GDELEGATOR');
    expect(report.methodology.privacy.withholds).toContain(
      'voter, delegator and delegate addresses',
    );
  });

  it('alerts on stale snapshots, low quorum attainment and delegated concentration', () => {
    const snapshot = baselineSnapshot();
    snapshot.proposals = [
      {
        id: 7,
        status: 'Defeated',
        votesFor: '10000',
        votesAgainst: '5000',
        eligibleVotingPower: '1000000',
        quorumRequired: '200000',
        voters: 5,
      },
    ];
    snapshot.delegations = [
      { delegator: 'GDELEGATORA', delegate: 'GDELEGATEA', power: '900000' },
      { delegator: 'GDELEGATORB', delegate: 'GDELEGATEB', power: '10000' },
      { delegator: 'GDELEGATORC', delegate: 'GDELEGATEC', power: '10000' },
      { delegator: 'GDELEGATORD', delegate: 'GDELEGATED', power: '10000' },
      { delegator: 'GDELEGATORE', delegate: 'GDELEGATEE', power: '10000' },
      { delegator: 'GDELEGATORF', delegate: 'GDELEGATEF', power: '10000' },
      { delegator: 'GDELEGATORG', delegate: 'GDELEGATEG', power: '10000' },
      { delegator: 'GDELEGATORH', delegate: 'GDELEGATEH', power: '10000' },
      { delegator: 'GDELEGATORI', delegate: 'GDELEGATEI', power: '10000' },
      { delegator: 'GDELEGATORJ', delegate: 'GDELEGATEJ', power: '10000' },
    ];

    const report = computeGovernanceHealth(snapshot, {
      now: new Date('2026-10-25T00:00:00.000Z'),
    });

    expect(report.freshness.status).toBe('stale');
    expect(report.quorum.attainmentRate).toBe(0);
    expect(report.delegation.concentration).toBe('high');
    expect(report.alerts).toEqual(
      expect.arrayContaining([
        expect.stringContaining('snapshot_stale'),
        expect.stringContaining('delegation_concentrated'),
        expect.stringContaining('top_delegate_dominant'),
        expect.stringContaining('quorum_attainment_low'),
      ]),
    );
  });

  it('handles an empty governance history without dividing by zero', () => {
    const report = computeGovernanceHealth(
      {
        asOf: NOW.toISOString(),
        network: 'local',
        token: { symbol: 'XLM', decimals: 7 },
        eligibleVoters: 0,
        totalVotingPower: '0',
        delegations: [],
        proposals: [],
      },
      { now: NOW },
    );

    expect(report.participation.voterTurnout).toBeNull();
    expect(report.participation.powerTurnout).toBeNull();
    expect(report.quorum.attainmentRate).toBeNull();
    expect(report.quorum.averageMarginBps).toBeNull();
    expect(report.abstention.nonParticipationRate).toBeNull();
    expect(report.delegation.delegatedShareOfPower).toBeNull();
  });

  it('computes a Gini coefficient that distinguishes equal from concentrated power', () => {
    expect(giniCoefficient([10, 10, 10, 10])).toBe(0);
    expect(giniCoefficient([100, 0, 0, 0])).toBeCloseTo(0.75, 4);
    expect(giniCoefficient([])).toBeNull();
  });
});
