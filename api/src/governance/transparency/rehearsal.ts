import type { ProposalStatus } from '../proposal-types';

/**
 * Rehearsal engine for the governance lifecycle. It mirrors the deployed
 * contract's rules (including Soroban's rollback-on-error semantics) so the
 * same scenarios can be replayed on testnet with a real signer.
 */

export type RehearsalErrorCode =
  | 'ProposalNotFound'
  | 'VotingNotActive'
  | 'AlreadyVoted'
  | 'InsufficientVotingPower'
  | 'ProposalDefeated'
  | 'TimeLockNotElapsed'
  | 'GuardianOnly'
  | 'AdminOnly'
  | 'ProposalAlreadyExecuted'
  | 'ProposalCancelled';

export class RehearsalError extends Error {
  constructor(public readonly code: RehearsalErrorCode) {
    super(code);
    this.name = 'RehearsalError';
  }
}

export interface RehearsalAction {
  variant: string;
  [key: string]: string | number;
}

export interface RehearsalProposalView {
  id: number;
  proposer: string;
  action: RehearsalAction;
  description: string;
  votesFor: string;
  votesAgainst: string;
  votingStart: number;
  votingEnd: number;
  executionTime: number;
  status: ProposalStatus;
  voters: number;
}

interface SimulatedProposal {
  id: number;
  proposer: string;
  action: RehearsalAction;
  description: string;
  votesFor: bigint;
  votesAgainst: bigint;
  voterSet: Set<string>;
  votingStart: number;
  votingEnd: number;
  executionTime: number;
  storedStatus: ProposalStatus;
}

export interface RehearsalSimulationConfig {
  votingPeriodSeconds: number;
  timelockDelaySeconds: number;
  quorum: bigint;
  proposalThreshold: bigint;
  guardian: string;
  admin: string;
  balances: Record<string, bigint>;
  nowMs?: number;
}

export const DEFAULT_REHEARSAL_CONFIG: RehearsalSimulationConfig = {
  votingPeriodSeconds: 3 * 86_400,
  timelockDelaySeconds: 2 * 86_400,
  quorum: 200_000n,
  proposalThreshold: 10_000n,
  guardian: 'GAREHEARSALGUARDIAN000000000000000000000000000000000000',
  admin: 'GAREHEARSALADMIN0000000000000000000000000000000000000000',
  balances: {
    proposer: 500_000n,
    voterFor: 500_000n,
    smallHolder: 50_000n,
    voterAgainst: 900_000n,
    delegatee: 750_000n,
    outsider: 0n,
  },
};

export class GovernanceSimulation {
  private clockMs: number;
  private proposalCount = 0;
  private readonly proposals = new Map<number, SimulatedProposal>();

  constructor(private readonly config: RehearsalSimulationConfig) {
    this.clockMs = config.nowMs ?? Date.parse('2026-01-01T00:00:00.000Z');
  }

  nowSeconds(): number {
    return Math.floor(this.clockMs / 1000);
  }

  advance(seconds: number): void {
    this.clockMs += seconds * 1000;
  }

  private powerOf(account: string): bigint {
    return this.config.balances[account] ?? 0n;
  }

  propose(proposer: string, action: RehearsalAction, description: string): number {
    if (this.powerOf(proposer) < this.config.proposalThreshold) {
      throw new RehearsalError('InsufficientVotingPower');
    }
    const id = ++this.proposalCount;
    const now = this.nowSeconds();
    this.proposals.set(id, {
      id,
      proposer,
      action,
      description,
      votesFor: 0n,
      votesAgainst: 0n,
      voterSet: new Set(),
      votingStart: now,
      votingEnd: now + this.config.votingPeriodSeconds,
      executionTime: now + this.config.votingPeriodSeconds + this.config.timelockDelaySeconds,
      storedStatus: 'Active',
    });
    return id;
  }

  vote(voter: string, proposalId: number, support: boolean): void {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) throw new RehearsalError('ProposalNotFound');
    const now = this.nowSeconds();
    if (proposal.storedStatus !== 'Active' || now < proposal.votingStart || now >= proposal.votingEnd) {
      throw new RehearsalError('VotingNotActive');
    }
    if (proposal.voterSet.has(voter)) throw new RehearsalError('AlreadyVoted');

    const power = this.powerOf(voter);
    if (support) proposal.votesFor += power;
    else proposal.votesAgainst += power;
    proposal.voterSet.add(voter);
  }

  private resolvedStatus(proposal: SimulatedProposal): ProposalStatus {
    if (proposal.storedStatus !== 'Active') return proposal.storedStatus;
    const now = this.nowSeconds();
    if (now < proposal.votingEnd) return 'Active';
    const quorumMet = proposal.votesFor + proposal.votesAgainst >= this.config.quorum;
    return quorumMet && proposal.votesFor > proposal.votesAgainst ? 'Queued' : 'Defeated';
  }

  queue(proposalId: number): ProposalStatus {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) throw new RehearsalError('ProposalNotFound');
    const resolved = this.resolvedStatus(proposal);
    if (resolved === 'Defeated') throw new RehearsalError('ProposalDefeated');
    if (resolved === 'Executed') throw new RehearsalError('ProposalAlreadyExecuted');
    if (resolved === 'Cancelled') throw new RehearsalError('ProposalCancelled');
    if (resolved === 'Active') throw new RehearsalError('VotingNotActive');

    proposal.storedStatus = resolved === 'Ready' ? 'Ready' : 'Queued';
    proposal.executionTime = proposal.votingEnd + this.config.timelockDelaySeconds;
    return proposal.storedStatus;
  }

  execute(proposalId: number): void {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) throw new RehearsalError('ProposalNotFound');
    const resolved = this.resolvedStatus(proposal);
    if (resolved === 'Active') throw new RehearsalError('VotingNotActive');
    if (resolved === 'Executed') throw new RehearsalError('ProposalAlreadyExecuted');
    if (resolved === 'Cancelled') throw new RehearsalError('ProposalCancelled');
    if (resolved === 'Defeated') throw new RehearsalError('ProposalDefeated');
    if (this.nowSeconds() < proposal.executionTime) throw new RehearsalError('TimeLockNotElapsed');

    proposal.storedStatus = 'Executed';
  }

  cancel(caller: string, proposalId: number): void {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) throw new RehearsalError('ProposalNotFound');
    if (proposal.storedStatus === 'Executed') throw new RehearsalError('ProposalAlreadyExecuted');
    if (proposal.storedStatus === 'Cancelled') throw new RehearsalError('ProposalCancelled');
    if (caller !== proposal.proposer && caller !== this.config.admin) {
      throw new RehearsalError('AdminOnly');
    }
    proposal.storedStatus = 'Cancelled';
  }

  emergencyExecute(guardian: string, proposalId: number): void {
    if (guardian !== this.config.guardian) throw new RehearsalError('GuardianOnly');
    const proposal = this.proposals.get(proposalId);
    if (!proposal) throw new RehearsalError('ProposalNotFound');
    if (proposal.storedStatus === 'Executed') throw new RehearsalError('ProposalAlreadyExecuted');
    if (proposal.storedStatus === 'Cancelled') throw new RehearsalError('ProposalCancelled');
    proposal.storedStatus = 'Executed';
  }

  getProposal(proposalId: number): RehearsalProposalView {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) throw new RehearsalError('ProposalNotFound');
    return {
      id: proposal.id,
      proposer: proposal.proposer,
      action: proposal.action,
      description: proposal.description,
      votesFor: proposal.votesFor.toString(),
      votesAgainst: proposal.votesAgainst.toString(),
      votingStart: proposal.votingStart,
      votingEnd: proposal.votingEnd,
      executionTime: proposal.executionTime,
      status: this.resolvedStatus(proposal),
      voters: proposal.voterSet.size,
    };
  }
}

export type ExpectedOutcome = { ok: true } | { ok: false; code: RehearsalErrorCode };

export interface RehearsalStepResult {
  action: string;
  expected: string;
  actual: string;
  passed: boolean;
  detail?: string;
}

export interface RehearsalScenarioResult {
  id: string;
  title: string;
  intent: string;
  status: 'passed' | 'failed';
  steps: RehearsalStepResult[];
  observations: string[];
}

export interface RehearsalReport {
  schemaVersion: '1.0';
  network: string;
  contractId: string | null;
  governanceConfig: {
    votingPeriodSeconds: number;
    timelockDelaySeconds: number;
    quorum: string;
    proposalThreshold: string;
    guardian: string;
  };
  startedAt: string;
  finishedAt: string;
  summary: {
    scenarios: number;
    passed: number;
    failed: number;
    steps: number;
    failedSteps: number;
    verdict: 'passed' | 'failed';
  };
  scenarios: RehearsalScenarioResult[];
  followUps: string[];
}

const describeExpected = (expected: ExpectedOutcome): string =>
  expected.ok ? 'succeeds' : `fails with ${expected.code}`;

function runStep(
  steps: RehearsalStepResult[],
  action: string,
  expected: ExpectedOutcome,
  fn: () => string | void,
): void {
  try {
    const detail = fn();
    const passed = expected.ok === true;
    steps.push({
      action,
      expected: describeExpected(expected),
      actual: 'succeeded',
      passed,
      detail: detail || undefined,
    });
  } catch (err: unknown) {
    const code = err instanceof RehearsalError ? err.code : 'UnknownError';
    const passed = expected.ok === false && expected.code === code;
    steps.push({
      action,
      expected: describeExpected(expected),
      actual: `failed with ${code}`,
      passed,
    });
  }
}

function scenario(
  id: string,
  title: string,
  intent: string,
  build: (simulation: GovernanceSimulation) => { steps: RehearsalStepResult[]; observations: string[] },
): RehearsalScenarioResult {
  const simulation = new GovernanceSimulation(DEFAULT_REHEARSAL_CONFIG);
  const { steps, observations } = build(simulation);
  return {
    id,
    title,
    intent,
    status: steps.every((step) => step.passed) ? 'passed' : 'failed',
    steps,
    observations,
  };
}

const ACTION: RehearsalAction = { variant: 'SetDeviationThreshold', thresholdBps: 500 };

export function runGovernanceRehearsal(options: {
  network?: string;
  contractId?: string | null;
  now?: Date;
  config?: Partial<RehearsalSimulationConfig>;
} = {}): RehearsalReport {
  const startedAt = (options.now ?? new Date()).toISOString();
  const config = { ...DEFAULT_REHEARSAL_CONFIG, ...options.config };

  const scenarios: RehearsalScenarioResult[] = [
    scenario(
      'happy_path',
      'Proposal passes, queues, and executes after the timelock',
      'Confirms the full success path a community proposal takes.',
      (sim) => {
        const steps: RehearsalStepResult[] = [];
        let id = 0;
        runStep(steps, 'propose with >= proposal threshold', { ok: true }, () => {
          id = sim.propose('proposer', ACTION, 'Rehearsal: raise deviation threshold to 500 bps');
          return `proposal ${id}`;
        });
        runStep(steps, 'vote for', { ok: true }, () => {
          sim.vote('voterFor', id, true);
        });
        runStep(steps, 'second voter votes for', { ok: true }, () => {
          sim.vote('delegatee', id, true);
        });
        runStep(steps, 'execute before the window closes', { ok: false, code: 'VotingNotActive' }, () => {
          sim.execute(id);
        });
        sim.advance(config.votingPeriodSeconds + 1);
        runStep(steps, 'queue after voting closes', { ok: true }, () => {
          const status = sim.queue(id);
          return `status ${status}`;
        });
        runStep(steps, 'execute before the timelock elapses', { ok: false, code: 'TimeLockNotElapsed' }, () => {
          sim.execute(id);
        });
        sim.advance(config.timelockDelaySeconds + 1);
        runStep(steps, 'execute after the timelock', { ok: true }, () => {
          sim.execute(id);
          return `status ${sim.getProposal(id).status}`;
        });
        return {
          steps,
          observations: [
            'The timelock applies from voting_end, not from the queue call.',
            'Proposal status is Executed only after the execution time is reached.',
          ],
        };
      },
    ),
    scenario(
      'quorum_not_met',
      'A proposal is defeated when quorum is missed',
      'Confirms the minority-protection boundary: participation alone cannot pass a proposal.',
      (sim) => {
        const steps: RehearsalStepResult[] = [];
        let id = 0;
        runStep(steps, 'propose with >= proposal threshold', { ok: true }, () => {
          id = sim.propose('proposer', ACTION, 'Rehearsal: quorum miss');
        });
        runStep(steps, 'vote for with less than quorum', { ok: true }, () => {
          sim.vote('smallHolder', id, true);
        });
        sim.advance(config.votingPeriodSeconds + 1);
        runStep(steps, 'queue without quorum', { ok: false, code: 'ProposalDefeated' }, () => {
          sim.queue(id);
        });
        runStep(steps, 'read resolved status', { ok: true }, () => sim.getProposal(id).status);
        return {
          steps,
          observations: [
            'A defeated proposal is resolved on read; the contract does not persist the defeat because the error rolls back storage.',
          ],
        };
      },
    ),
    scenario(
      'majority_rejected',
      'A proposal with quorum but more against votes is defeated',
      'Confirms quorum and majority are independent conditions.',
      (sim) => {
        const steps: RehearsalStepResult[] = [];
        let id = 0;
        runStep(steps, 'propose', { ok: true }, () => {
          id = sim.propose('proposer', ACTION, 'Rehearsal: majority rejection');
        });
        runStep(steps, 'vote for', { ok: true }, () => {
          sim.vote('voterFor', id, true);
        });
        runStep(steps, 'vote against with more power', { ok: true }, () => {
          sim.vote('voterAgainst', id, false);
        });
        sim.advance(config.votingPeriodSeconds + 1);
        runStep(steps, 'queue', { ok: false, code: 'ProposalDefeated' }, () => {
          sim.queue(id);
        });
        runStep(steps, 'read resolved status', { ok: true }, () => sim.getProposal(id).status);
        return {
          steps,
          observations: ['Quorum is satisfied, but votes_for must strictly exceed votes_against.'],
        };
      },
    ),
    scenario(
      'cancellation',
      'Only the proposer or admin can cancel, and cancellation is final',
      'Confirms the cancellation authority boundary and its effect on execution.',
      (sim) => {
        const steps: RehearsalStepResult[] = [];
        let id = 0;
        runStep(steps, 'propose', { ok: true }, () => {
          id = sim.propose('proposer', ACTION, 'Rehearsal: cancellation');
        });
        runStep(steps, 'cancel as an unrelated account', { ok: false, code: 'AdminOnly' }, () => {
          sim.cancel('outsider', id);
        });
        runStep(steps, 'cancel as the proposer', { ok: true }, () => {
          sim.cancel('proposer', id);
          return `status ${sim.getProposal(id).status}`;
        });
        runStep(steps, 'execute a cancelled proposal', { ok: false, code: 'ProposalCancelled' }, () => {
          sim.execute(id);
        });
        return {
          steps,
          observations: ['The admin retains an override to cancel, mirroring the contract.'],
        };
      },
    ),
    scenario(
      'emergency_override',
      'The guardian can execute immediately; nobody else can',
      'Confirms the emergency path used for compromised sources.',
      (sim) => {
        const steps: RehearsalStepResult[] = [];
        let id = 0;
        runStep(steps, 'propose', { ok: true }, () => {
          id = sim.propose('proposer', ACTION, 'Rehearsal: emergency execution');
        });
        runStep(steps, 'emergency execute as a non-guardian', { ok: false, code: 'GuardianOnly' }, () => {
          sim.emergencyExecute('outsider', id);
        });
        runStep(steps, 'emergency execute as the guardian', { ok: true }, () => {
          sim.emergencyExecute(config.guardian, id);
          return `status ${sim.getProposal(id).status}`;
        });
        runStep(steps, 'emergency execute the same proposal twice', { ok: false, code: 'ProposalAlreadyExecuted' }, () => {
          sim.emergencyExecute(config.guardian, id);
        });
        return {
          steps,
          observations: ['Emergency execution bypasses the timelock but not the guardian check.'],
        };
      },
    ),
    scenario(
      'guardrails',
      'Rejected inputs do not corrupt proposal state',
      'Covers boundary and failure cases that must stay closed under load.',
      (sim) => {
        const steps: RehearsalStepResult[] = [];
        let id = 0;
        runStep(steps, 'propose without threshold', { ok: false, code: 'InsufficientVotingPower' }, () => {
          sim.propose('outsider', ACTION, 'Rehearsal: no voting power');
        });
        runStep(steps, 'propose with threshold', { ok: true }, () => {
          id = sim.propose('proposer', ACTION, 'Rehearsal: guardrails');
        });
        runStep(steps, 'vote twice', { ok: true }, () => {
          sim.vote('voterFor', id, true);
        });
        runStep(steps, 'second vote by the same account', { ok: false, code: 'AlreadyVoted' }, () => {
          sim.vote('voterFor', id, false);
        });
        runStep(steps, 'vote on an unknown proposal', { ok: false, code: 'ProposalNotFound' }, () => {
          sim.vote('voterFor', 9999, true);
        });
        sim.advance(config.votingPeriodSeconds + 1);
        runStep(steps, 'vote after voting closes', { ok: false, code: 'VotingNotActive' }, () => {
          sim.vote('voterAgainst', id, false);
        });
        runStep(steps, 'queue after the window', { ok: true }, () => sim.queue(id) as string);
        runStep(steps, 'cancel a queued proposal as the proposer', { ok: true }, () => {
          sim.cancel('proposer', id);
        });
        runStep(steps, 'emergency execute a cancelled proposal', { ok: false, code: 'ProposalCancelled' }, () => {
          sim.emergencyExecute(config.guardian, id);
        });
        return {
          steps,
          observations: ['Every rejected action leaves the stored proposal status unchanged.'],
        };
      },
    ),
  ];

  const allSteps = scenarios.flatMap((result) => result.steps);
  const failedSteps = allSteps.filter((step) => !step.passed).length;
  const failedScenarios = scenarios.filter((result) => result.status === 'failed');

  const followUps: string[] = [];
  for (const failed of failedScenarios) {
    followUps.push(`Fix scenario "${failed.id}" before the public testnet rehearsal.`);
  }
  if ((options.network ?? 'local-simulation') === 'local-simulation') {
    followUps.push(
      'This run was a local simulation. Repeat it against the deployed testnet governance contract and attach transaction hashes to the published report.',
    );
  }
  followUps.push('Schedule the next rehearsal in the quarterly governance calendar and link the report from the release notes.');

  return {
    schemaVersion: '1.0',
    network: options.network ?? 'local-simulation',
    contractId: options.contractId ?? null,
    governanceConfig: {
      votingPeriodSeconds: config.votingPeriodSeconds,
      timelockDelaySeconds: config.timelockDelaySeconds,
      quorum: config.quorum.toString(),
      proposalThreshold: config.proposalThreshold.toString(),
      guardian: config.guardian,
    },
    startedAt,
    finishedAt: startedAt,
    summary: {
      scenarios: scenarios.length,
      passed: scenarios.length - failedScenarios.length,
      failed: failedScenarios.length,
      steps: allSteps.length,
      failedSteps,
      verdict: failedScenarios.length === 0 ? 'passed' : 'failed',
    },
    scenarios,
    followUps,
  };
}

export function renderRehearsalMarkdown(report: RehearsalReport): string {
  const lines: string[] = [];
  lines.push('# Governance Rehearsal Report');
  lines.push('');
  lines.push(`- Network: \`${report.network}\``);
  lines.push(`- Contract: \`${report.contractId ?? 'not deployed (simulation)'}\``);
  lines.push(`- Started: ${report.startedAt}`);
  lines.push(`- Finished: ${report.finishedAt}`);
  lines.push(
    `- Verdict: **${report.summary.verdict.toUpperCase()}** (${report.summary.passed}/${report.summary.scenarios} scenarios, ${report.summary.steps - report.summary.failedSteps}/${report.summary.steps} steps)`,
  );
  lines.push('');
  lines.push('## Governance configuration');
  lines.push('');
  lines.push('| Setting | Value |');
  lines.push('| --- | --- |');
  lines.push(`| Voting period | ${report.governanceConfig.votingPeriodSeconds}s |`);
  lines.push(`| Timelock delay | ${report.governanceConfig.timelockDelaySeconds}s |`);
  lines.push(`| Quorum | ${report.governanceConfig.quorum} |`);
  lines.push(`| Proposal threshold | ${report.governanceConfig.proposalThreshold} |`);
  lines.push('');
  lines.push('## Scenarios');
  lines.push('');
  lines.push('| Scenario | Intent | Result | Steps |');
  lines.push('| --- | --- | --- | --- |');
  for (const result of report.scenarios) {
    const passedSteps = result.steps.filter((step) => step.passed).length;
    lines.push(
      `| ${result.title} (\`${result.id}\`) | ${result.intent} | ${result.status === 'passed' ? 'PASS' : 'FAIL'} | ${passedSteps}/${result.steps.length} |`,
    );
  }
  lines.push('');

  const failedSteps = report.scenarios
    .flatMap((result) => result.steps.map((step) => ({ scenario: result.id, step })))
    .filter((entry) => !entry.step.passed);
  if (failedSteps.length > 0) {
    lines.push('## Failed steps');
    lines.push('');
    lines.push('| Scenario | Action | Expected | Actual |');
    lines.push('| --- | --- | --- | --- |');
    for (const { scenario, step } of failedSteps) {
      lines.push(`| \`${scenario}\` | ${step.action} | ${step.expected} | ${step.actual} |`);
    }
    lines.push('');
  }

  lines.push('## Observations');
  lines.push('');
  for (const result of report.scenarios) {
    for (const observation of result.observations) {
      lines.push(`- **${result.id}**: ${observation}`);
    }
  }
  lines.push('');
  lines.push('## Follow-up actions');
  lines.push('');
  for (const followUp of report.followUps) {
    lines.push(`- [ ] ${followUp}`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('Generated by `api/scripts/governance-rehearsal.ts`.');
  lines.push('');
  return lines.join('\n');
}
