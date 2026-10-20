import type { ProposalAction, ProposalStatus } from '../proposal-types';

export class GovernanceReportingError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GovernanceReportingError';
  }
}

// ── Signer independence (#782) ───────────────────────────────────────────────

export type CustodyType =
  | 'hsm'
  | 'hardware_wallet'
  | 'cloud_kms'
  | 'multisig_agent'
  | 'software';

export type ConflictRelationship =
  | 'employment'
  | 'equity'
  | 'custody'
  | 'board'
  | 'family'
  | 'other';

export interface SignerConflict {
  party: string;
  relationship: ConflictRelationship;
  mitigation: string;
}

export interface SignerProfile {
  address: string;
  organization: string;
  custody: CustodyType;
  custodyProvider: string;
  region: string;
  addedAt: number;
  lastRotatedAt: number;
  availabilityPct: number;
  conflicts: SignerConflict[];
}

export interface SignerIndependencePolicy {
  minIndependentSigners: number;
  rotationIntervalDays: number;
  minAvailabilityPct: number;
  maxSignersPerCustodyProvider: number;
  maxSignersPerOrganization: number;
  disallowedCustody: CustodyType[];
}

export interface SignerAssessment {
  address: string;
  organization: string;
  custody: CustodyType;
  custodyProvider: string;
  region: string;
  independent: boolean;
  daysSinceRotation: number;
  availabilityPct: number;
  violations: string[];
}

export interface SharedControlFinding {
  signers: [string, string];
  organization: string;
}

export interface SignerFinding {
  code: string;
  severity: 'critical' | 'high' | 'medium';
  message: string;
  signers: string[];
}

export interface SignerIndependenceReport {
  generatedAt: number;
  policy: SignerIndependencePolicy;
  signerCount: number;
  independentSignerCount: number;
  quorumRequired: number;
  maxIndependentQuorum: number;
  quorumReachable: boolean;
  custodyDiversity: {
    distinctTypes: number;
    distinctProviders: number;
    byType: Record<string, number>;
    byProvider: Record<string, number>;
  };
  rotation: {
    compliant: number;
    overdue: string[];
  };
  availability: {
    belowPolicy: string[];
    medianPct: number;
  };
  conflictDisclosure: {
    declared: number;
    unmitigated: number;
    undisclosedSharedControl: SharedControlFinding[];
  };
  signers: SignerAssessment[];
  findings: SignerFinding[];
  verdict: 'pass' | 'fail';
}

// ── Decentralization stage gates (#783) ──────────────────────────────────────

export type ConcentrationDimension = 'provider' | 'signer' | 'governance' | 'region';

export interface WeightedEntity {
  id: string;
  weight: number;
}

export interface ConcentrationMeasures {
  dimension: ConcentrationDimension;
  entityCount: number;
  totalWeight: number;
  hhi: number;
  top1Share: number;
  nakamotoCoefficient: number;
  shares: Array<{ id: string; share: number }>;
}

export interface StageGateThresholds {
  minEntities: number;
  maxTop1Share: number;
  maxHhi: number;
  minNakamoto: number;
}

export interface StageDefinition {
  id: string;
  name: string;
  description: string;
  gates: Record<ConcentrationDimension, StageGateThresholds>;
}

export interface ConcentrationSnapshot {
  id: string;
  capturedAt: number;
  inputs: Record<ConcentrationDimension, WeightedEntity[]>;
}

export interface GateCheck {
  criterion: 'minEntities' | 'maxTop1Share' | 'maxHhi' | 'minNakamoto';
  actual: number;
  required: number;
  comparison: '>=' | '<=';
  passed: boolean;
}

export interface DimensionGateResult {
  dimension: ConcentrationDimension;
  measured: ConcentrationMeasures;
  checks: GateCheck[];
  passed: boolean;
}

export interface DecentralizationStageReport {
  stage: string;
  passed: boolean;
  dimensions: DimensionGateResult[];
}

export interface StageGateReport {
  generatedAt: number;
  snapshotId: string;
  currentStage: string;
  achievedStage: string;
  nextStage: string | null;
  eligibleForNextStage: boolean;
  sustain: {
    requiredSnapshots: number;
    consecutivePassingSnapshots: number;
    satisfied: boolean;
  };
  regression: boolean;
  baseline: Record<ConcentrationDimension, ConcentrationMeasures> | null;
  target: DecentralizationStageReport | null;
  stages: DecentralizationStageReport[];
  findings: string[];
}

// ── Governance execution audit (#784) ────────────────────────────────────────

export type GovernanceSurface = 'onchain' | 'offchain';
export type StateValue = string | number | boolean | string[] | null;

export interface GovernanceState {
  onchain: Record<string, StateValue>;
  offchain: Record<string, StateValue>;
}

export interface AuditableProposal {
  id: number;
  status: ProposalStatus;
  action: ProposalAction;
  approvedAt: number;
  executedAt?: number;
  executionTime?: number;
  description?: string;
}

export type DiscrepancyKind =
  | 'mismatch'
  | 'missing_change'
  | 'unapproved_change'
  | 'overdue_execution'
  | 'inconsistent_proposal'
  | 'unverifiable_effect';

export type RemediationStatus = 'open' | 'in_progress' | 'resolved' | 'accepted_risk';

export interface RemediationState {
  status: RemediationStatus;
  owner?: string;
  note?: string;
  updatedAt: number;
}

export interface Discrepancy {
  key: string;
  surface: GovernanceSurface;
  kind: DiscrepancyKind;
  severity: 'critical' | 'high' | 'medium';
  expected?: StateValue;
  observed?: StateValue;
  proposalIds: number[];
  remediationStatus: RemediationStatus | 'untriaged';
  remediation?: RemediationState;
}

export interface ReconciliationReport {
  id: string;
  generatedAt: number;
  proposalsChecked: number;
  appliedProposalIds: number[];
  pendingProposalIds: number[];
  matchedKeys: string[];
  discrepancies: Discrepancy[];
  summary: {
    critical: number;
    high: number;
    medium: number;
    untriaged: number;
    resolved: number;
  };
}

export interface ExecutionAuditInput {
  baseline: GovernanceState;
  proposals: AuditableProposal[];
  observed: GovernanceState;
  now?: number;
  maxExecutionDelaySeconds?: number;
}

// ── Grant outcomes (#785) ────────────────────────────────────────────────────

export type GrantStatus = 'proposed' | 'approved' | 'active' | 'completed' | 'cancelled';

export type ObjectiveDirection = 'min' | 'max';

export interface GrantObjective {
  id: string;
  description: string;
  metric: string;
  target: number;
  unit: string;
  direction: ObjectiveDirection;
}

export interface MilestoneEvidence {
  uri: string;
  sha256: string;
  submittedAt: number;
  verifiedAt?: number;
  verifiedBy?: string;
}

export interface GrantMilestone {
  id: string;
  title: string;
  dueAt: number;
  acceptanceCriteria: string;
  evidence?: MilestoneEvidence;
}

export interface GrantConflict {
  party: string;
  relationship: ConflictRelationship;
  mitigation: string;
}

export interface GrantConflictDisclosure {
  disclosed: boolean;
  conflicts: GrantConflict[];
}

export interface GrantOutcomeResult {
  objectiveId: string;
  actual: number;
  evidenceUri: string;
}

export interface GrantOutcomeReport {
  reportedAt: number;
  results: GrantOutcomeResult[];
  summary: string;
}

export interface GrantRecord {
  id: string;
  title: string;
  recipient: string;
  owner: string;
  status: GrantStatus;
  approvedAt?: number;
  completedAt?: number;
  objectives: GrantObjective[];
  milestones: GrantMilestone[];
  conflicts: GrantConflictDisclosure;
  outcome?: GrantOutcomeReport;
}

export interface GrantObjectiveAttainment {
  objectiveId: string;
  target: number;
  actual: number | null;
  unit: string;
  met: boolean | null;
}

export interface GrantStatusReport {
  grantId: string;
  title: string;
  status: GrantStatus;
  milestonesTotal: number;
  milestonesVerified: number;
  evidenceCoverage: number;
  objectivesTotal: number;
  objectivesMet: number;
  attainment: GrantObjectiveAttainment[];
  outcomeStatus: 'not_due' | 'recorded' | 'overdue' | 'missing';
  violations: string[];
}

export interface GrantOutcomesSummary {
  generatedAt: number;
  grantCount: number;
  completed: number;
  completionRate: number;
  objectivesPublished: number;
  objectivesMet: number;
  attainmentRate: number | null;
  evidenceCoverage: number;
  disclosureCompliant: number;
  outcomesOverdue: string[];
  grants: GrantStatusReport[];
  verdict: 'pass' | 'fail';
}

export interface GrantPolicy {
  outcomeWindowDays: number;
}
