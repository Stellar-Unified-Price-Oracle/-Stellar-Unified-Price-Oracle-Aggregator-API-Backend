import { governanceAuditDiscrepancies } from '../../observability/metrics';
import type { ProposalAction } from '../proposal-types';
import {
  getRemediation,
  nextId,
  remediationKey,
  storeReconciliationReport,
} from './store';
import {
  GovernanceReportingError,
  type AuditableProposal,
  type Discrepancy,
  type DiscrepancyKind,
  type ExecutionAuditInput,
  type GovernanceState,
  type GovernanceSurface,
  type ReconciliationReport,
  type StateValue,
} from './types';

const DAY_SECONDS = 86_400;
const DEFAULT_MAX_EXECUTION_DELAY_SECONDS = 30 * DAY_SECONDS;

interface Effect {
  surface: GovernanceSurface;
  key: string;
  op: 'set' | 'add' | 'remove';
  value?: StateValue;
}

function governanceConfigEffects(action: Extract<ProposalAction, { variant: 'UpdateGovernanceConfig' }>): Effect[] {
  const config = action.config;
  const effects: Array<[string, StateValue]> = [
    ['governance.token', config.token],
    ['governance.votingPeriod', config.votingPeriod],
    ['governance.timelockDelay', config.timelockDelay],
    ['governance.quorum', config.quorum],
    ['governance.proposalThreshold', config.proposalThreshold],
    ['governance.guardian', config.guardian],
  ];
  return effects.map(([key, value]) => ({ surface: 'onchain', key, op: 'set', value }));
}

function effectsFor(action: ProposalAction): Effect[] {
  switch (action.variant) {
    case 'AddSigner':
      return [{ surface: 'onchain', key: 'multisig.signers', op: 'add', value: action.signer }];
    case 'RemoveSigner':
      return [{ surface: 'onchain', key: 'multisig.signers', op: 'remove', value: action.signer }];
    case 'SetThreshold':
      return [{ surface: 'onchain', key: 'multisig.threshold', op: 'set', value: action.threshold }];
    case 'SetAdmin':
    case 'TransferAdmin':
      return [{ surface: 'onchain', key: 'admin.address', op: 'set', value: action.newAdmin }];
    case 'AddOracleSource':
    case 'AddSource':
      return [{ surface: 'onchain', key: 'oracle.sources', op: 'add', value: action.source }];
    case 'RemoveOracleSource':
    case 'RemoveSource':
      return [{ surface: 'onchain', key: 'oracle.sources', op: 'remove', value: action.source }];
    case 'SetTrustedAsset':
      return [
        {
          surface: 'onchain',
          key: 'assets.trusted',
          op: action.trusted === 0 ? 'remove' : 'add',
          value: action.asset,
        },
      ];
    case 'SetDeviationThreshold':
      return [
        {
          surface: 'onchain',
          key: 'oracle.deviationThresholdBps',
          op: 'set',
          value: action.thresholdBps,
        },
      ];
    case 'ResetReputation':
      return [
        {
          surface: 'offchain',
          key: `source.reputation.${action.source}`,
          op: 'set',
          value: 0,
        },
      ];
    case 'UpdateGovernanceConfig':
      return governanceConfigEffects(action);
    default: {
      const unknown = action as { variant?: string };
      throw new GovernanceReportingError(
        'UNMAPPABLE_ACTION',
        `No execution effect is defined for action "${unknown.variant ?? 'unknown'}"`,
      );
    }
  }
}

function cloneState(state: GovernanceState): GovernanceState {
  return {
    onchain: { ...state.onchain },
    offchain: { ...state.offchain },
  };
}

function applyEffect(state: GovernanceState, effect: Effect): void {
  const bucket = state[effect.surface];

  if (effect.op === 'set') {
    bucket[effect.key] = effect.value ?? null;
    return;
  }

  const current = bucket[effect.key];
  const list = Array.isArray(current) ? [...current] : [];
  const value = typeof effect.value === 'string' ? effect.value : null;

  if (effect.op === 'add') {
    if (value !== null && !list.includes(value)) list.push(value);
  } else {
    const index = list.indexOf(value ?? '');
    if (index >= 0) list.splice(index, 1);
  }

  bucket[effect.key] = list;
}

function valuesEqual(expected: StateValue, observed: StateValue): boolean {
  if (Array.isArray(expected) && Array.isArray(observed)) {
    if (expected.length !== observed.length) return false;
    const left = [...expected].sort();
    const right = [...observed].sort();
    return left.every((value, index) => value === right[index]);
  }
  return expected === observed;
}

function severityFor(kind: DiscrepancyKind): Discrepancy['severity'] {
  switch (kind) {
    case 'unapproved_change':
    case 'inconsistent_proposal':
      return 'critical';
    case 'mismatch':
    case 'missing_change':
    case 'unverifiable_effect':
      return 'high';
    case 'overdue_execution':
      return 'medium';
  }
}

function formatValue(value: StateValue | undefined): string {
  if (value === undefined) return '<absent>';
  return Array.isArray(value) ? `[${value.join(', ')}]` : String(value);
}

export function reconcileGovernanceExecution(input: ExecutionAuditInput): ReconciliationReport {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const maxDelay = input.maxExecutionDelaySeconds ?? DEFAULT_MAX_EXECUTION_DELAY_SECONDS;

  const proposalIds = new Set<number>();
  for (const proposal of input.proposals) {
    if (proposalIds.has(proposal.id)) {
      throw new GovernanceReportingError(
        'DUPLICATE_PROPOSAL',
        `Proposal ${proposal.id} appears more than once in the audit input`,
      );
    }
    proposalIds.add(proposal.id);
  }

  const expected = cloneState(input.baseline);
  const lastWriters = new Map<string, number[]>();
  const applied: AuditableProposal[] = [];
  const pending: AuditableProposal[] = [];
  const discrepancies: Discrepancy[] = [];

  const pushDiscrepancy = (
    surface: GovernanceSurface,
    key: string,
    kind: DiscrepancyKind,
    detail: { expected?: StateValue; observed?: StateValue; proposalIds: number[] },
  ): void => {
    const dedupKey = remediationKey(surface, key, kind);
    const remediation = getRemediation(dedupKey);
    discrepancies.push({
      key,
      surface,
      kind,
      severity: severityFor(kind),
      expected: detail.expected,
      observed: detail.observed,
      proposalIds: detail.proposalIds,
      remediationStatus: remediation?.status ?? 'untriaged',
      remediation,
    });
  };

  const ordered = [...input.proposals].sort((left, right) => {
    const leftAt = left.executedAt ?? left.approvedAt;
    const rightAt = right.executedAt ?? right.approvedAt;
    return leftAt === rightAt ? left.id - right.id : leftAt - rightAt;
  });

  for (const proposal of ordered) {
    if (proposal.status === 'Executed') {
      applied.push(proposal);
      if (proposal.executedAt === undefined) {
        pushDiscrepancy('onchain', `proposal.${proposal.id}.execution`, 'inconsistent_proposal', {
          expected: 'executedAt timestamp recorded',
          observed: null,
          proposalIds: [proposal.id],
        });
        continue;
      }

      let effects: Effect[] = [];
      try {
        effects = effectsFor(proposal.action);
      } catch {
        pushDiscrepancy('onchain', `proposal.${proposal.id}.effect`, 'unverifiable_effect', {
          expected: `a reconcilable effect for ${proposal.action.variant}`,
          observed: null,
          proposalIds: [proposal.id],
        });
        continue;
      }

      for (const effect of effects) {
        applyEffect(expected, effect);
        const dedup = `${effect.surface}:${effect.key}`;
        const writers = lastWriters.get(dedup) ?? [];
        if (!writers.includes(proposal.id)) writers.push(proposal.id);
        lastWriters.set(dedup, writers);
      }
      continue;
    }

    if (proposal.status === 'Queued' || proposal.status === 'Ready') {
      pending.push(proposal);
      const deadline = (proposal.executionTime ?? proposal.approvedAt) + maxDelay;
      if (now > deadline) {
        pushDiscrepancy('onchain', `proposal.${proposal.id}.execution`, 'overdue_execution', {
          expected: deadline,
          observed: now,
          proposalIds: [proposal.id],
        });
      }
    }
  }

  const matchedKeys: string[] = [];

  for (const surface of ['onchain', 'offchain'] as GovernanceSurface[]) {
    const expectedBucket = expected[surface];
    const observedBucket = input.observed[surface];
    const keys = new Set([...Object.keys(expectedBucket), ...Object.keys(observedBucket)]);

    for (const key of keys) {
      const expectedValue = expectedBucket[key];
      const observedValue = observedBucket[key];
      const writers = lastWriters.get(`${surface}:${key}`) ?? [];

      if (expectedValue === undefined && observedValue !== undefined) {
        pushDiscrepancy(surface, key, 'unapproved_change', {
          expected: undefined,
          observed: observedValue,
          proposalIds: [],
        });
        continue;
      }

      if (expectedValue !== undefined && observedValue === undefined) {
        pushDiscrepancy(surface, key, 'missing_change', {
          expected: expectedValue,
          observed: undefined,
          proposalIds: writers,
        });
        continue;
      }

      if (expectedValue !== undefined && observedValue !== undefined) {
        if (valuesEqual(expectedValue, observedValue)) {
          matchedKeys.push(`${surface}:${key}`);
        } else {
          pushDiscrepancy(surface, key, 'mismatch', {
            expected: expectedValue,
            observed: observedValue,
            proposalIds: writers,
          });
        }
      }
    }
  }

  discrepancies.sort((left, right) => left.key.localeCompare(right.key));

  const report: ReconciliationReport = {
    id: nextId('recon'),
    generatedAt: now,
    proposalsChecked: input.proposals.length,
    appliedProposalIds: applied.map((proposal) => proposal.id),
    pendingProposalIds: pending.map((proposal) => proposal.id),
    matchedKeys,
    discrepancies,
    summary: {
      critical: discrepancies.filter((d) => d.severity === 'critical').length,
      high: discrepancies.filter((d) => d.severity === 'high').length,
      medium: discrepancies.filter((d) => d.severity === 'medium').length,
      untriaged: discrepancies.filter((d) => d.remediationStatus === 'untriaged').length,
      resolved: discrepancies.filter((d) => d.remediationStatus === 'resolved').length,
    },
  };

  return report;
}

export function refreshReconciliationMetrics(report: ReconciliationReport): void {
  governanceAuditDiscrepancies.reset();
  for (const discrepancy of report.discrepancies) {
    if (discrepancy.remediationStatus === 'resolved') continue;
    governanceAuditDiscrepancies.inc(
      { kind: discrepancy.kind, severity: discrepancy.severity },
      1,
    );
  }
}

export function publishReconciliationReport(report: ReconciliationReport): ReconciliationReport {
  storeReconciliationReport(report);
  refreshReconciliationMetrics(report);
  return report;
}

export function describeDiscrepancy(discrepancy: Discrepancy): string {
  switch (discrepancy.kind) {
    case 'unapproved_change':
      return `${discrepancy.surface} key "${discrepancy.key}" changed to ` +
        `${formatValue(discrepancy.observed)} with no approved proposal authorising it`;
    case 'missing_change':
      return `${discrepancy.surface} key "${discrepancy.key}" should be ` +
        `${formatValue(discrepancy.expected)} but is absent`;
    case 'mismatch':
      return `${discrepancy.surface} key "${discrepancy.key}" is ` +
        `${formatValue(discrepancy.observed)}; approved proposals require ` +
        `${formatValue(discrepancy.expected)}`;
    case 'overdue_execution':
      return `Proposal ${discrepancy.proposalIds.join(', ')} was approved but not executed by ` +
        `${formatValue(discrepancy.expected)}`;
    case 'inconsistent_proposal':
      return `Executed proposal ${discrepancy.proposalIds.join(', ')} has no execution timestamp`;
    case 'unverifiable_effect':
      return `Proposal ${discrepancy.proposalIds.join(', ')} has no reconcilable execution effect`;
  }
}
