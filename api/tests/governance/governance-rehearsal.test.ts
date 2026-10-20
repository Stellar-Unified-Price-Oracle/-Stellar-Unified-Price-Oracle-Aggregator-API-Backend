import { describe, it, expect } from 'vitest';
import {
  DEFAULT_REHEARSAL_CONFIG,
  GovernanceSimulation,
  RehearsalError,
  renderRehearsalMarkdown,
  runGovernanceRehearsal,
} from '../../src/governance/transparency/rehearsal';

const NOW = new Date('2026-10-20T00:00:00.000Z');
const ACTION = { variant: 'SetDeviationThreshold', thresholdBps: 500 };

function simulation(): GovernanceSimulation {
  return new GovernanceSimulation({ ...DEFAULT_REHEARSAL_CONFIG });
}

describe('governance rehearsal (#780)', () => {
  it('runs the full scenario matrix and publishes a passing report', () => {
    const report = runGovernanceRehearsal({ now: NOW });

    expect(report.network).toBe('local-simulation');
    expect(report.contractId).toBeNull();
    expect(report.summary.verdict).toBe('passed');
    expect(report.summary.scenarios).toBe(6);
    expect(report.summary.failed).toBe(0);
    expect(report.scenarios.map((scenario) => scenario.id)).toEqual([
      'happy_path',
      'quorum_not_met',
      'majority_rejected',
      'cancellation',
      'emergency_override',
      'guardrails',
    ]);
    for (const scenario of report.scenarios) {
      expect(scenario.status).toBe('passed');
      expect(scenario.steps.every((step) => step.passed)).toBe(true);
    }
    expect(report.followUps).toContainEqual(
      expect.stringContaining('local simulation'),
    );
  });

  it('renders a publishable Markdown report with outcomes and follow-ups', () => {
    const markdown = renderRehearsalMarkdown(runGovernanceRehearsal({ now: NOW }));

    expect(markdown).toContain('# Governance Rehearsal Report');
    expect(markdown).toContain('**PASSED**');
    expect(markdown).toContain('| Scenario | Intent | Result | Steps |');
    expect(markdown).toContain('## Observations');
    expect(markdown).toContain('## Follow-up actions');
    expect(markdown).toContain('happy_path');
    expect(markdown).toContain('guardrails');
  });

  it('does not persist a defeat when queue fails, matching Soroban rollback semantics', () => {
    const sim = simulation();
    const id = sim.propose('proposer', ACTION, 'quorum miss');
    sim.vote('smallHolder', id, true);
    sim.advance(DEFAULT_REHEARSAL_CONFIG.votingPeriodSeconds + 1);

    expect(() => sim.queue(id)).toThrowError(
      expect.objectContaining({ code: 'ProposalDefeated' }),
    );
    expect(sim.getProposal(id).status).toBe('Defeated');
    expect(() => sim.queue(id)).toThrowError(
      expect.objectContaining({ code: 'ProposalDefeated' }),
    );
  });

  it('permits execution exactly at the end of the timelock', () => {
    const sim = simulation();
    const id = sim.propose('proposer', ACTION, 'timelock boundary');
    sim.vote('voterFor', id, true);
    sim.vote('delegatee', id, true);
    sim.advance(DEFAULT_REHEARSAL_CONFIG.votingPeriodSeconds + 1);

    sim.queue(id);
    const executionTime = sim.getProposal(id).executionTime;
    const remaining = executionTime - sim.nowSeconds() - 1;
    sim.advance(remaining);

    expect(() => sim.execute(id)).toThrowError(
      expect.objectContaining({ code: 'TimeLockNotElapsed' }),
    );
    sim.advance(1);
    sim.execute(id);
    expect(sim.getProposal(id).status).toBe('Executed');
  });

  it('rejects votes, duplicate votes and executions outside their allowed windows', () => {
    const sim = simulation();
    const id = sim.propose('proposer', ACTION, 'guardrails');

    sim.vote('voterFor', id, true);
    expect(() => sim.vote('voterFor', id, false)).toThrowError(
      expect.objectContaining({ code: 'AlreadyVoted' }),
    );
    expect(() => sim.execute(id)).toThrowError(
      expect.objectContaining({ code: 'VotingNotActive' }),
    );

    sim.advance(DEFAULT_REHEARSAL_CONFIG.votingPeriodSeconds + 1);
    expect(() => sim.vote('voterAgainst', id, false)).toThrowError(
      expect.objectContaining({ code: 'VotingNotActive' }),
    );
  });

  it('enforces proposer threshold, guardian authority and cancellation finality', () => {
    const sim = simulation();

    expect(() => sim.propose('outsider', ACTION, 'no power')).toThrowError(
      expect.objectContaining({ code: 'InsufficientVotingPower' }),
    );

    const id = sim.propose('proposer', ACTION, 'cancellation');
    expect(() => sim.cancel('outsider', id)).toThrowError(
      expect.objectContaining({ code: 'AdminOnly' }),
    );
    expect(() => sim.emergencyExecute('outsider', id)).toThrowError(
      expect.objectContaining({ code: 'GuardianOnly' }),
    );

    sim.cancel('proposer', id);
    expect(sim.getProposal(id).status).toBe('Cancelled');
    expect(() => sim.emergencyExecute(DEFAULT_REHEARSAL_CONFIG.guardian, id)).toThrowError(
      expect.objectContaining({ code: 'ProposalCancelled' }),
    );
  });

  it('exposes RehearsalError with the contract error code for callers to assert on', () => {
    const sim = simulation();
    try {
      sim.getProposal(404);
      throw new Error('expected a RehearsalError');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(RehearsalError);
      expect((err as RehearsalError).code).toBe('ProposalNotFound');
    }
  });
});
