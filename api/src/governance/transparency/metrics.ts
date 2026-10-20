import {
  governanceAbstentionRate,
  governanceDelegationHhi,
  governancePowerTurnoutRatio,
  governanceQuorumAttainmentRatio,
  governanceSnapshotAgeSeconds,
  governanceTopDelegateShare,
  governanceVoterTurnoutRatio,
  releaseReviewNonCompliant,
  releaseReviewOpenWindows,
  treasuryBalanceBreaks,
  treasuryReconciled,
  treasurySnapshotAgeSeconds,
} from '../../observability/metrics';
import type { GovernanceHealthReport } from './governance-health';
import type { ReleaseReviewReport } from './release-review';
import type { TreasuryReport } from './treasury';

const setIfPresent = (gauge: { set: (value: number) => void }, value: number | null): void => {
  if (value !== null) gauge.set(value);
};

export function recordGovernanceHealthMetrics(report: GovernanceHealthReport): void {
  setIfPresent(governanceVoterTurnoutRatio, report.participation.voterTurnout);
  setIfPresent(governancePowerTurnoutRatio, report.participation.powerTurnout);
  setIfPresent(governanceQuorumAttainmentRatio, report.quorum.attainmentRate);
  setIfPresent(governanceDelegationHhi, report.delegation.hhi);
  setIfPresent(governanceTopDelegateShare, report.delegation.topDelegateShare);
  setIfPresent(governanceAbstentionRate, report.abstention.nonParticipationRate);
  governanceSnapshotAgeSeconds.set(Math.round(report.freshness.ageHours * 3600));
}

export function recordTreasuryMetrics(report: TreasuryReport): void {
  treasuryReconciled.set(report.status === 'reconciled' ? 1 : 0);
  treasuryBalanceBreaks.set(report.breaks.filter((item) => item.severity === 'error').length);
  treasurySnapshotAgeSeconds.set(Math.round(report.freshness.ageHours * 3600));
}

export function recordReleaseReviewMetrics(report: ReleaseReviewReport): void {
  releaseReviewNonCompliant.set(report.summary.nonCompliant);
  releaseReviewOpenWindows.set(report.summary.open);
}
