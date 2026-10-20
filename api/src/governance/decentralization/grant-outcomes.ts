import { grantObjectiveAttainmentRatio, grantOutcomesOverdue } from '../../observability/metrics';
import { getGrant, getGrantPolicy, listGrants, saveGrant } from './store';
import {
  GovernanceReportingError,
  type GrantObjective,
  type GrantObjectiveAttainment,
  type GrantOutcomeReport,
  type GrantPolicy,
  type GrantRecord,
  type GrantStatus,
  type GrantStatusReport,
  type GrantOutcomesSummary,
  type MilestoneEvidence,
} from './types';

const DAY_SECONDS = 86_400;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

const ALLOWED_TRANSITIONS: Record<GrantStatus, GrantStatus[]> = {
  proposed: ['approved', 'cancelled'],
  approved: ['active', 'cancelled'],
  active: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

function fail(code: string, message: string): never {
  throw new GovernanceReportingError(code, message);
}

function validateEvidenceUri(uri: string, field: string): void {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    fail('INVALID_EVIDENCE', `${field} must be an absolute URL`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    fail('INVALID_EVIDENCE', `${field} must use http(s)`);
  }
}

function validateObjectives(objectives: GrantObjective[]): void {
  if (objectives.length === 0) {
    fail('OBJECTIVES_REQUIRED', 'A grant must publish at least one measurable objective');
  }

  const ids = new Set<string>();
  for (const objective of objectives) {
    if (!objective.id.trim()) fail('INVALID_OBJECTIVE', 'Objective id must not be empty');
    if (ids.has(objective.id)) {
      fail('DUPLICATE_OBJECTIVE', `Objective id "${objective.id}" is duplicated`);
    }
    ids.add(objective.id);

    if (!objective.description.trim() || !objective.metric.trim() || !objective.unit.trim()) {
      fail(
        'INVALID_OBJECTIVE',
        `Objective "${objective.id}" must declare a description, metric and unit`,
      );
    }
    if (!Number.isFinite(objective.target)) {
      fail('INVALID_OBJECTIVE', `Objective "${objective.id}" must declare a numeric target`);
    }
    if (objective.direction !== 'min' && objective.direction !== 'max') {
      fail('INVALID_OBJECTIVE', `Objective "${objective.id}" must declare direction min or max`);
    }
  }
}

function validateMilestones(record: GrantRecord): void {
  if (record.milestones.length === 0) {
    fail('MILESTONES_REQUIRED', 'A grant must publish at least one milestone');
  }

  const ids = new Set<string>();
  for (const milestone of record.milestones) {
    if (!milestone.id.trim() || !milestone.title.trim()) {
      fail('INVALID_MILESTONE', 'Milestone id and title must not be empty');
    }
    if (ids.has(milestone.id)) {
      fail('DUPLICATE_MILESTONE', `Milestone id "${milestone.id}" is duplicated`);
    }
    ids.add(milestone.id);

    if (!milestone.acceptanceCriteria.trim()) {
      fail(
        'INVALID_MILESTONE',
        `Milestone "${milestone.id}" must declare acceptance criteria`,
      );
    }
    if (!Number.isFinite(milestone.dueAt) || milestone.dueAt <= 0) {
      fail('INVALID_MILESTONE', `Milestone "${milestone.id}" must declare a due date`);
    }
    if (milestone.evidence) validateEvidence(milestone.evidence, milestone.id);
  }
}

function validateEvidence(evidence: MilestoneEvidence, milestoneId: string): void {
  validateEvidenceUri(evidence.uri, `Evidence for milestone "${milestoneId}"`);
  if (!SHA256_PATTERN.test(evidence.sha256)) {
    fail(
      'INVALID_EVIDENCE',
      `Evidence for milestone "${milestoneId}" must pin a 64-character sha256 digest`,
    );
  }
  if (!Number.isFinite(evidence.submittedAt) || evidence.submittedAt <= 0) {
    fail('INVALID_EVIDENCE', `Evidence for milestone "${milestoneId}" has an invalid submittedAt`);
  }
  if (evidence.verifiedAt !== undefined) {
    if (!evidence.verifiedBy?.trim()) {
      fail(
        'INVALID_EVIDENCE',
        `Verified evidence for milestone "${milestoneId}" must name the verifier`,
      );
    }
    if (evidence.verifiedAt < evidence.submittedAt) {
      fail(
        'INVALID_EVIDENCE',
        `Evidence for milestone "${milestoneId}" was verified before it was submitted`,
      );
    }
  }
}

function validateConflicts(record: GrantRecord): void {
  if (typeof record.conflicts.disclosed !== 'boolean') {
    fail('CONFLICTS_NOT_DISCLOSED', 'Grant must explicitly disclose or deny conflicts');
  }
  if (!record.conflicts.disclosed) {
    if (record.conflicts.conflicts.length > 0) {
      fail(
        'UNDISCLOSED_CONFLICT',
        'Grant denies conflicts but lists conflicts; declaration is inconsistent',
      );
    }
    return;
  }

  for (const conflict of record.conflicts.conflicts) {
    if (!conflict.party.trim() || !conflict.relationship || !conflict.mitigation.trim()) {
      fail(
        'UNDISCLOSED_CONFLICT',
        'Every disclosed conflict must name the party, relationship and mitigation',
      );
    }
  }
}

function validateOutcome(record: GrantRecord, outcome: GrantOutcomeReport): void {
  if (record.outcome) {
    fail('OUTCOME_ALREADY_RECORDED', `Grant "${record.id}" already has an outcome report`);
  }
  if (!outcome.summary.trim()) {
    fail('INVALID_OUTCOME', 'Outcome report must include a written summary');
  }

  const expected = new Set(record.objectives.map((objective) => objective.id));
  const reported = new Set<string>();

  for (const result of outcome.results) {
    if (!expected.has(result.objectiveId)) {
      fail('INVALID_OUTCOME', `Outcome references unknown objective "${result.objectiveId}"`);
    }
    if (reported.has(result.objectiveId)) {
      fail('INVALID_OUTCOME', `Outcome reports objective "${result.objectiveId}" twice`);
    }
    reported.add(result.objectiveId);
    if (!Number.isFinite(result.actual)) {
      fail('INVALID_OUTCOME', `Outcome for "${result.objectiveId}" must be numeric`);
    }
    validateEvidenceUri(result.evidenceUri, `Outcome evidence for "${result.objectiveId}"`);
  }

  for (const objectiveId of expected) {
    if (!reported.has(objectiveId)) {
      fail('OUTCOME_INCOMPLETE', `Outcome does not report objective "${objectiveId}"`);
    }
  }
}

function objectiveMet(objective: GrantObjective, actual: number): boolean {
  return objective.direction === 'min' ? actual >= objective.target : actual <= objective.target;
}

export function registerGrant(
  input: Omit<GrantRecord, 'status'> & { status?: GrantStatus },
): GrantRecord {
  if (!input.id.trim() || !input.title.trim() || !input.recipient.trim() || !input.owner.trim()) {
    fail('INVALID_GRANT', 'Grant id, title, recipient and owner must not be empty');
  }
  if (getGrant(input.id)) {
    fail('DUPLICATE_GRANT', `Grant "${input.id}" is already registered`);
  }

  const record: GrantRecord = {
    ...input,
    status: input.status ?? 'proposed',
  };

  validateObjectives(record.objectives);
  validateMilestones(record);
  validateConflicts(record);
  if (record.outcome) validateOutcome(record, record.outcome);
  if (record.status === 'completed') {
    if (record.completedAt === undefined) {
      fail(
        'INVALID_GRANT',
        'A grant registered as completed must declare completedAt so outcome reporting can be timed',
      );
    }
    assertCompletionEvidence(record);
  }

  saveGrant(record);
  return getGrant(record.id)!;
}

function assertCompletionEvidence(record: GrantRecord): void {
  const unverified = record.milestones.filter((milestone) => !milestone.evidence?.verifiedAt);
  if (unverified.length > 0) {
    fail(
      'EVIDENCE_MISSING_FOR_COMPLETION',
      `Cannot complete grant "${record.id}": milestones without verified evidence: ` +
        unverified.map((milestone) => milestone.id).join(', '),
    );
  }
}

export function submitMilestoneEvidence(
  grantId: string,
  milestoneId: string,
  evidence: MilestoneEvidence,
): GrantRecord {
  const record = getGrant(grantId);
  if (!record) fail('GRANT_NOT_FOUND', `Grant "${grantId}" is not registered`);
  if (record.status === 'cancelled') {
    fail('GRANT_CANCELLED', `Grant "${grantId}" is cancelled`);
  }

  const milestone = record.milestones.find((candidate) => candidate.id === milestoneId);
  if (!milestone) {
    fail('MILESTONE_NOT_FOUND', `Milestone "${milestoneId}" is not part of grant "${grantId}"`);
  }
  if (milestone.evidence?.verifiedAt) {
    fail(
      'EVIDENCE_IMMUTABLE',
      `Verified evidence for milestone "${milestoneId}" cannot be replaced`,
    );
  }

  validateEvidence(
    { ...evidence, submittedAt: evidence.submittedAt || Math.floor(Date.now() / 1000) },
    milestoneId,
  );

  milestone.evidence = {
    ...evidence,
    submittedAt: evidence.submittedAt || Math.floor(Date.now() / 1000),
  };
  saveGrant(record);
  return getGrant(grantId)!;
}

export function transitionGrantStatus(
  grantId: string,
  status: GrantStatus,
  now: number = Math.floor(Date.now() / 1000),
): GrantRecord {
  const record = getGrant(grantId);
  if (!record) fail('GRANT_NOT_FOUND', `Grant "${grantId}" is not registered`);

  if (!ALLOWED_TRANSITIONS[record.status].includes(status)) {
    fail(
      'INVALID_STATUS_TRANSITION',
      `Grant "${grantId}" cannot move from ${record.status} to ${status}`,
    );
  }

  if (status === 'completed') {
    assertCompletionEvidence(record);
    record.completedAt = now;
  }
  if (status === 'approved' && record.approvedAt === undefined) {
    record.approvedAt = now;
  }

  record.status = status;
  saveGrant(record);
  return getGrant(grantId)!;
}

export function recordGrantOutcome(
  grantId: string,
  outcome: Omit<GrantOutcomeReport, 'reportedAt'> & { reportedAt?: number },
  now: number = Math.floor(Date.now() / 1000),
): GrantRecord {
  const record = getGrant(grantId);
  if (!record) fail('GRANT_NOT_FOUND', `Grant "${grantId}" is not registered`);
  if (record.status !== 'completed') {
    fail(
      'OUTCOME_BEFORE_COMPLETION',
      'Post-completion outcome reports can only be recorded for completed grants',
    );
  }

  const report: GrantOutcomeReport = {
    ...outcome,
    reportedAt: outcome.reportedAt ?? now,
  };
  validateOutcome(record, report);

  record.outcome = report;
  saveGrant(record);
  return getGrant(grantId)!;
}

function evidenceCoverage(record: GrantRecord): number {
  if (record.milestones.length === 0) return 0;
  const verified = record.milestones.filter((milestone) => milestone.evidence?.verifiedAt).length;
  return verified / record.milestones.length;
}

function isDisclosureCompliant(record: GrantRecord): boolean {
  if (typeof record.conflicts.disclosed !== 'boolean') return false;
  if (!record.conflicts.disclosed) return record.conflicts.conflicts.length === 0;
  return record.conflicts.conflicts.every(
    (conflict) => conflict.party.trim() && conflict.mitigation.trim(),
  );
}

function outcomeStatus(
  record: GrantRecord,
  now: number,
  policy: GrantPolicy,
): GrantStatusReport['outcomeStatus'] {
  if (record.status !== 'completed') return 'not_due';
  if (record.outcome) return 'recorded';
  const completedAt = record.completedAt ?? now;
  const deadline = completedAt + policy.outcomeWindowDays * DAY_SECONDS;
  return now > deadline ? 'overdue' : 'missing';
}

export function buildGrantStatusReport(
  record: GrantRecord,
  now: number = Math.floor(Date.now() / 1000),
  policy: GrantPolicy = getGrantPolicy(),
): GrantStatusReport {
  const violations: string[] = [];

  if (record.status === 'completed' && evidenceCoverage(record) < 1) {
    violations.push('EVIDENCE_MISSING_FOR_COMPLETION');
  }
  for (const milestone of record.milestones) {
    if (!milestone.evidence?.verifiedAt && now > milestone.dueAt) {
      violations.push(`MILESTONE_OVERDUE:${milestone.id}`);
    }
  }
  if (!isDisclosureCompliant(record)) {
    violations.push('CONFLICTS_NOT_DISCLOSED');
  }

  const attainment: GrantObjectiveAttainment[] = record.objectives.map((objective) => {
    const result = record.outcome?.results.find((entry) => entry.objectiveId === objective.id);
    return {
      objectiveId: objective.id,
      target: objective.target,
      actual: result?.actual ?? null,
      unit: objective.unit,
      met: result ? objectiveMet(objective, result.actual) : null,
    };
  });

  return {
    grantId: record.id,
    title: record.title,
    status: record.status,
    milestonesTotal: record.milestones.length,
    milestonesVerified: record.milestones.filter((milestone) => milestone.evidence?.verifiedAt)
      .length,
    evidenceCoverage: evidenceCoverage(record),
    objectivesTotal: record.objectives.length,
    objectivesMet: attainment.filter((entry) => entry.met === true).length,
    attainment,
    outcomeStatus: outcomeStatus(record, now, policy),
    violations,
  };
}

export function grantOutcomesSummary(
  now: number = Math.floor(Date.now() / 1000),
): GrantOutcomesSummary {
  const policy = getGrantPolicy();
  const records = listGrants();
  const reports = records.map((record) => buildGrantStatusReport(record, now, policy));

  const completed = reports.filter((report) => report.status === 'completed').length;
  const objectivesPublished = reports.reduce((sum, report) => sum + report.objectivesTotal, 0);
  const reportedObjectives = reports.reduce(
    (sum, report) => sum + report.attainment.filter((entry) => entry.met !== null).length,
    0,
  );
  const objectivesMet = reports.reduce((sum, report) => sum + report.objectivesMet, 0);
  const milestonesTotal = reports.reduce((sum, report) => sum + report.milestonesTotal, 0);
  const milestonesVerified = reports.reduce(
    (sum, report) => sum + report.milestonesVerified,
    0,
  );
  const outcomesOverdue = reports
    .filter((report) => report.outcomeStatus === 'overdue')
    .map((report) => report.grantId);
  const disclosureCompliantCount = records.filter((record) =>
    isDisclosureCompliant(record),
  ).length;
  const attainmentRate = reportedObjectives > 0 ? objectivesMet / reportedObjectives : null;

  if (attainmentRate !== null) {
    grantObjectiveAttainmentRatio.set(attainmentRate);
  }
  grantOutcomesOverdue.set(outcomesOverdue.length);

  return {
    generatedAt: now,
    grantCount: reports.length,
    completed,
    completionRate: reports.length > 0 ? completed / reports.length : 0,
    objectivesPublished,
    objectivesMet,
    attainmentRate,
    evidenceCoverage: milestonesTotal > 0 ? milestonesVerified / milestonesTotal : 0,
    disclosureCompliant: disclosureCompliantCount,
    outcomesOverdue,
    grants: reports,
    verdict:
      outcomesOverdue.length === 0 && disclosureCompliantCount === records.length
        ? 'pass'
        : 'fail',
  };
}
