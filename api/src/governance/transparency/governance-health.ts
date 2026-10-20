import type {
  Freshness,
} from './store';
import { describeFreshness } from './store';
import type { GovernanceProposalVoteRecord, GovernanceSnapshot } from './schema';

export const GOVERNANCE_METHODOLOGY_VERSION = '1.0.0';
export const GOVERNANCE_UPDATE_CADENCE_HOURS = 24;
export const DEFAULT_MIN_COHORT_SIZE = 10;
export const DEFAULT_TRAILING_WINDOW = 10;

const HHI_MODERATE = 0.15;
const HHI_HIGH = 0.25;
const TOP_DELEGATE_ALERT_SHARE = 1 / 3;
const QUORUM_ALERT_RATE = 0.5;

const CLOSED_STATUSES = new Set(['Queued', 'Ready', 'Executed', 'Defeated']);

export interface GovernanceHealthOptions {
  now?: Date;
  minCohortSize?: number;
  trailingWindow?: number;
}

export type DelegationConcentration = 'low' | 'moderate' | 'high' | 'unknown';

export interface DelegationHealth {
  /** False when the delegate cohort is smaller than the k-anonymity floor. */
  available: boolean;
  suppressed: boolean;
  reason: 'cohort_below_minimum' | null;
  minCohortSize: number;
  delegateCount: number | null;
  delegatorCount: number | null;
  delegatedShareOfPower: number | null;
  hhi: number | null;
  gini: number | null;
  effectiveDelegates: number | null;
  topDelegateShare: number | null;
  top5Share: number | null;
  concentration: DelegationConcentration;
}

export interface ParticipationHealth {
  available: boolean;
  eligibleVoters: number;
  activeVoters: number | null;
  voterTurnout: number | null;
  powerTurnout: number | null;
  proposalsMeasured: number;
  activeProposals: number;
}

export interface QuorumProposalHealth {
  id: number;
  status: GovernanceProposalVoteRecord['status'];
  quorumRequired: boolean;
  attained: boolean | null;
  marginBps: number | null;
}

export interface QuorumHealth {
  available: boolean;
  proposalsMeasured: number;
  proposalsAttained: number | null;
  attainmentRate: number | null;
  trailingWindow: number;
  trailingAttainmentRate: number | null;
  averageMarginBps: number | null;
  proposals: QuorumProposalHealth[];
}

export interface AbstentionHealth {
  available: boolean;
  /** Explicit abstain votes exist only on deployments that record a third option. */
  explicitAbstainSupported: boolean;
  explicitAbstentionRate: number | null;
  nonParticipationRate: number | null;
  proposalsMeasured: number;
}

export interface GovernanceHealthReport {
  generatedAt: string;
  asOf: string;
  network: string;
  token: { symbol: string; decimals: number };
  freshness: Freshness;
  methodology: {
    version: string;
    owner: string;
    updateCadenceHours: number;
    privacy: {
      minCohortSize: number;
      publishes: string[];
      withholds: string[];
      rounding: string;
    };
    definitions: Record<string, string>;
  };
  participation: ParticipationHealth;
  delegation: DelegationHealth;
  quorum: QuorumHealth;
  abstention: AbstentionHealth;
  alerts: string[];
}

const round = (value: number, digits = 4): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const mean = (values: number[]): number | null => {
  if (values.length === 0) return null;
  return values.reduce((acc, value) => acc + value, 0) / values.length;
};

const castPower = (proposal: GovernanceProposalVoteRecord): bigint =>
  BigInt(proposal.votesFor) + BigInt(proposal.votesAgainst);

const totalCastPower = (proposal: GovernanceProposalVoteRecord): bigint =>
  castPower(proposal) + BigInt(proposal.abstainPower ?? '0');

/**
 * Gini coefficient over delegate voting power. 0 means every delegate holds an
 * identical share; values approaching 1 mean one delegate holds everything.
 */
export function giniCoefficient(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((acc, value) => acc + value, 0);
  if (total <= 0) return 0;

  let weighted = 0;
  sorted.forEach((value, index) => {
    weighted += (index + 1) * value;
  });
  const n = sorted.length;
  const gini = (2 * weighted) / (n * total) - (n + 1) / n;
  return round(Math.min(1, Math.max(0, gini)));
}

export function participationHealth(snapshot: GovernanceSnapshot): ParticipationHealth {
  const measured = snapshot.proposals.filter((proposal) => BigInt(proposal.eligibleVotingPower) > 0n);
  const voterTurnouts =
    snapshot.eligibleVoters > 0
      ? measured.map((proposal) => proposal.voters / snapshot.eligibleVoters)
      : [];
  const powerTurnouts = measured.map(
    (proposal) => Number(castPower(proposal)) / Number(proposal.eligibleVotingPower),
  );

  const averageVoters = mean(measured.map((proposal) => proposal.voters));

  return {
    available: measured.length > 0 && snapshot.eligibleVoters > 0,
    eligibleVoters: snapshot.eligibleVoters,
    activeVoters: averageVoters === null ? null : Math.round(averageVoters),
    voterTurnout: mean(voterTurnouts) === null ? null : round(mean(voterTurnouts) as number),
    powerTurnout: mean(powerTurnouts) === null ? null : round(mean(powerTurnouts) as number),
    proposalsMeasured: measured.length,
    activeProposals: snapshot.proposals.filter((proposal) => proposal.status === 'Active').length,
  };
}

export function delegationHealth(
  snapshot: GovernanceSnapshot,
  minCohortSize: number,
): DelegationHealth {
  const powerByDelegate = new Map<string, bigint>();
  for (const record of snapshot.delegations) {
    powerByDelegate.set(
      record.delegate,
      (powerByDelegate.get(record.delegate) ?? 0n) + BigInt(record.power),
    );
  }

  const delegateCount = powerByDelegate.size;
  const suppressed = delegateCount < minCohortSize;
  const totalVotingPower = BigInt(snapshot.totalVotingPower);
  const delegatedPower = [...powerByDelegate.values()].reduce((acc, value) => acc + value, 0n);
  const delegatedShareOfPower =
    totalVotingPower > 0n && !suppressed
      ? round(Number((delegatedPower * 1_000_000n) / totalVotingPower) / 1_000_000, 6)
      : null;

  if (suppressed) {
    return {
      available: false,
      suppressed: true,
      reason: 'cohort_below_minimum',
      minCohortSize,
      delegateCount: null,
      delegatorCount: null,
      delegatedShareOfPower: null,
      hhi: null,
      gini: null,
      effectiveDelegates: null,
      topDelegateShare: null,
      top5Share: null,
      concentration: 'unknown',
    };
  }

  // Integer-safe shares: keep exact bigint division when computing percentages.
  const powers = [...powerByDelegate.values()].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  const delegatedTotal = powers.reduce((acc, value) => acc + value, 0n);
  const shareOf = (value: bigint): number =>
    delegatedTotal > 0n ? Number((value * 1_000_000n) / delegatedTotal) / 1_000_000 : 0;

  const shares = powers.map(shareOf);
  const hhi = round(shares.reduce((acc, share) => acc + share * share, 0));
  const top1 = shares[0] ?? 0;
  const top5 = shares.slice(0, 5).reduce((acc, share) => acc + share, 0);

  return {
    available: true,
    suppressed: false,
    reason: null,
    minCohortSize,
    delegateCount,
    delegatorCount: snapshot.delegations.length,
    delegatedShareOfPower,
    hhi,
    gini: giniCoefficient(powers.map((value) => Number(value))),
    effectiveDelegates: hhi > 0 ? round(1 / hhi, 2) : null,
    topDelegateShare: round(top1),
    top5Share: round(top5),
    concentration: hhi >= HHI_HIGH ? 'high' : hhi >= HHI_MODERATE ? 'moderate' : 'low',
  };
}

export function quorumHealth(
  snapshot: GovernanceSnapshot,
  trailingWindow: number,
): QuorumHealth {
  const closed = snapshot.proposals
    .filter((proposal) => CLOSED_STATUSES.has(proposal.status))
    .sort((a, b) => b.id - a.id);
  const quorumScoped = closed.filter((proposal) => BigInt(proposal.quorumRequired) > 0n);

  const proposals: QuorumProposalHealth[] = quorumScoped.map((proposal) => {
    const quorum = BigInt(proposal.quorumRequired);
    const cast = castPower(proposal);
    const attained = cast >= quorum;
    const marginBps = Number(((cast - quorum) * 10_000n) / quorum);
    return {
      id: proposal.id,
      status: proposal.status,
      quorumRequired: true,
      attained,
      marginBps,
    };
  });

  const trailing = proposals.slice(0, trailingWindow);
  const attainedCount = proposals.filter((proposal) => proposal.attained).length;
  const trailingAttained = trailing.filter((proposal) => proposal.attained).length;
  const margins = proposals.map((proposal) => proposal.marginBps as number);

  return {
    available: proposals.length > 0,
    proposalsMeasured: proposals.length,
    proposalsAttained: proposals.length > 0 ? attainedCount : null,
    attainmentRate: proposals.length > 0 ? round(attainedCount / proposals.length) : null,
    trailingWindow,
    trailingAttainmentRate:
      trailing.length > 0 ? round(trailingAttained / trailing.length) : null,
    averageMarginBps:
      margins.length > 0
        ? Math.round(margins.reduce((acc, value) => acc + value, 0) / margins.length)
        : null,
    proposals,
  };
}

export function abstentionHealth(snapshot: GovernanceSnapshot): AbstentionHealth {
  const measured = snapshot.proposals.filter(
    (proposal) => BigInt(proposal.eligibleVotingPower) > 0n,
  );
  const explicitSupported = snapshot.proposals.some(
    (proposal) => proposal.abstainPower !== undefined,
  );

  const totalCastWithAbstain = measured.reduce(
    (acc, proposal) => acc + totalCastPower(proposal),
    0n,
  );
  const totalExplicitAbstain = measured.reduce(
    (acc, proposal) => acc + BigInt(proposal.abstainPower ?? '0'),
    0n,
  );

  const nonParticipationRates = measured.map(
    (proposal) => 1 - Number(castPower(proposal)) / Number(proposal.eligibleVotingPower),
  );

  return {
    available: measured.length > 0,
    explicitAbstainSupported: explicitSupported,
    explicitAbstentionRate:
      explicitSupported && totalCastWithAbstain > 0n
        ? round(Number((totalExplicitAbstain * 1_000_000n) / totalCastWithAbstain) / 1_000_000)
        : null,
    nonParticipationRate:
      mean(nonParticipationRates) === null
        ? null
        : round(mean(nonParticipationRates) as number),
    proposalsMeasured: measured.length,
  };
}

export function computeGovernanceHealth(
  snapshot: GovernanceSnapshot,
  options: GovernanceHealthOptions = {},
): GovernanceHealthReport {
  const now = options.now ?? new Date();
  const minCohortSize = options.minCohortSize ?? DEFAULT_MIN_COHORT_SIZE;
  const trailingWindow = options.trailingWindow ?? DEFAULT_TRAILING_WINDOW;

  const participation = participationHealth(snapshot);
  const delegation = delegationHealth(snapshot, minCohortSize);
  const quorum = quorumHealth(snapshot, trailingWindow);
  const abstention = abstentionHealth(snapshot);
  const freshness = describeFreshness(snapshot.asOf, GOVERNANCE_UPDATE_CADENCE_HOURS, now);

  const alerts: string[] = [];
  if (freshness.status === 'stale') {
    alerts.push(
      `snapshot_stale: last measurement is ${freshness.ageHours}h old (cadence ${GOVERNANCE_UPDATE_CADENCE_HOURS}h)`,
    );
  }
  if (delegation.available && delegation.concentration === 'high') {
    alerts.push(`delegation_concentrated: HHI ${delegation.hhi} exceeds ${HHI_HIGH}`);
  }
  if (delegation.available && (delegation.topDelegateShare ?? 0) >= TOP_DELEGATE_ALERT_SHARE) {
    alerts.push(
      `top_delegate_dominant: largest delegate holds ${((delegation.topDelegateShare ?? 0) * 100).toFixed(1)}% of delegated power`,
    );
  }
  if (quorum.attainmentRate !== null && quorum.attainmentRate < QUORUM_ALERT_RATE) {
    alerts.push(`quorum_attainment_low: ${(quorum.attainmentRate * 100).toFixed(1)}% of closed proposals reached quorum`);
  }
  if (!delegation.available) {
    alerts.push(`delegation_metrics_suppressed: delegate cohort below k=${minCohortSize}`);
  }

  return {
    generatedAt: now.toISOString(),
    asOf: snapshot.asOf,
    network: snapshot.network,
    token: snapshot.token,
    freshness,
    methodology: {
      version: GOVERNANCE_METHODOLOGY_VERSION,
      owner: 'Governance Working Group',
      updateCadenceHours: GOVERNANCE_UPDATE_CADENCE_HOURS,
      privacy: {
        minCohortSize,
        publishes: [
          'aggregate turnout, quorum and abstention ratios',
          'delegation concentration statistics (HHI, Gini, top-N shares)',
        ],
        withholds: [
          'voter, delegator and delegate addresses',
          'individual voting power and delegation edges',
          'any cohort statistic backed by fewer than k members',
        ],
        rounding: 'ratios rounded to 4 decimal places; counts reported as integers',
      },
      definitions: {
        voterTurnout:
          'mean over proposals of (wallets that voted / eligible wallets at the snapshot)',
        powerTurnout:
          'mean over proposals of (voting power cast for+against / eligible voting power)',
        quorumAttainment:
          'share of closed proposals where votes for+against met the configured quorum',
        quorumMarginBps:
          '(cast power - quorum) / quorum in basis points; negative means quorum was missed',
        nonParticipationRate:
          'mean over proposals of eligible power that did not vote for or against; this is the abstention measure available on a binary vote contract',
        explicitAbstentionRate:
          'explicit abstain power / (for + against + abstain); only when the deployment records a third option',
        delegationHhi:
          'sum of squared delegate power shares; 1/HHI is the effective number of delegates',
        delegationGini: 'Gini coefficient of delegate voting power (0 = equal, 1 = one holder)',
      },
    },
    participation,
    delegation,
    quorum,
    abstention,
    alerts,
  };
}
