import { randomUUID } from 'crypto';
import type {
  ConcentrationSnapshot,
  GrantPolicy,
  GrantRecord,
  ReconciliationReport,
  RemediationState,
  SignerIndependencePolicy,
  SignerProfile,
} from './types';

const MAX_SNAPSHOTS = 500;
const MAX_REPORTS = 100;

let signerRoster: SignerProfile[] = [];
let signerPolicy: SignerIndependencePolicy | null = null;

let snapshots: ConcentrationSnapshot[] = [];
let currentStage = 'stage-0';

const reconciliationReports: ReconciliationReport[] = [];
const remediations = new Map<string, RemediationState>();

const grants = new Map<string, GrantRecord>();
let grantPolicy: GrantPolicy = { outcomeWindowDays: 30 };

export function nextId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

// ── Signer roster ────────────────────────────────────────────────────────────

export function setSignerRoster(
  profiles: SignerProfile[],
  policy: SignerIndependencePolicy,
): void {
  signerRoster = profiles.map((profile) => ({
    ...profile,
    conflicts: profile.conflicts.map((conflict) => ({ ...conflict })),
  }));
  signerPolicy = { ...policy, disallowedCustody: [...policy.disallowedCustody] };
}

export function getSignerRoster(): SignerProfile[] {
  return signerRoster.map((profile) => ({
    ...profile,
    conflicts: profile.conflicts.map((conflict) => ({ ...conflict })),
  }));
}

export function getSignerPolicy(): SignerIndependencePolicy | null {
  return signerPolicy
    ? { ...signerPolicy, disallowedCustody: [...signerPolicy.disallowedCustody] }
    : null;
}

// ── Concentration snapshots ──────────────────────────────────────────────────

export function appendSnapshot(snapshot: ConcentrationSnapshot): void {
  snapshots.push(snapshot);
  if (snapshots.length > MAX_SNAPSHOTS) {
    snapshots.splice(0, snapshots.length - MAX_SNAPSHOTS);
  }
}

export function getSnapshots(): ConcentrationSnapshot[] {
  return snapshots.map((snapshot) => ({
    id: snapshot.id,
    capturedAt: snapshot.capturedAt,
    inputs: {
      provider: [...snapshot.inputs.provider],
      signer: [...snapshot.inputs.signer],
      governance: [...snapshot.inputs.governance],
      region: [...snapshot.inputs.region],
    },
  }));
}

export function getLatestSnapshot(): ConcentrationSnapshot | null {
  return snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
}

export function getBaselineSnapshot(): ConcentrationSnapshot | null {
  return snapshots.length > 0 ? snapshots[0] : null;
}

export function getCurrentStage(): string {
  return currentStage;
}

export function setCurrentStage(stage: string): void {
  currentStage = stage;
}

// ── Reconciliation reports and remediation ───────────────────────────────────

export function remediationKey(surface: string, key: string, kind: string): string {
  return `${surface}:${key}:${kind}`;
}

export function storeReconciliationReport(report: ReconciliationReport): void {
  reconciliationReports.unshift(report);
  if (reconciliationReports.length > MAX_REPORTS) {
    reconciliationReports.length = MAX_REPORTS;
  }
}

export function listReconciliationReports(): ReconciliationReport[] {
  return reconciliationReports.map((report) => ({
    ...report,
    discrepancies: report.discrepancies.map((discrepancy) => ({
      ...discrepancy,
      remediation: discrepancy.remediation ? { ...discrepancy.remediation } : undefined,
    })),
  }));
}

export function findReconciliationReport(id: string): ReconciliationReport | null {
  return reconciliationReports.find((report) => report.id === id) ?? null;
}

export function setRemediation(dedupKey: string, state: RemediationState): void {
  remediations.set(dedupKey, { ...state });
}

export function getRemediation(dedupKey: string): RemediationState | undefined {
  const state = remediations.get(dedupKey);
  return state ? { ...state } : undefined;
}

// ── Grants ───────────────────────────────────────────────────────────────────

export function saveGrant(grant: GrantRecord): void {
  grants.set(grant.id, {
    ...grant,
    objectives: grant.objectives.map((objective) => ({ ...objective })),
    milestones: grant.milestones.map((milestone) => ({
      ...milestone,
      evidence: milestone.evidence ? { ...milestone.evidence } : undefined,
    })),
    conflicts: {
      disclosed: grant.conflicts.disclosed,
      conflicts: grant.conflicts.conflicts.map((conflict) => ({ ...conflict })),
    },
    outcome: grant.outcome
      ? { ...grant.outcome, results: grant.outcome.results.map((result) => ({ ...result })) }
      : undefined,
  });
}

export function getGrant(id: string): GrantRecord | null {
  const grant = grants.get(id);
  if (!grant) return null;
  return {
    ...grant,
    objectives: grant.objectives.map((objective) => ({ ...objective })),
    milestones: grant.milestones.map((milestone) => ({
      ...milestone,
      evidence: milestone.evidence ? { ...milestone.evidence } : undefined,
    })),
    conflicts: {
      disclosed: grant.conflicts.disclosed,
      conflicts: grant.conflicts.conflicts.map((conflict) => ({ ...conflict })),
    },
    outcome: grant.outcome
      ? { ...grant.outcome, results: grant.outcome.results.map((result) => ({ ...result })) }
      : undefined,
  };
}

export function listGrants(): GrantRecord[] {
  return Array.from(grants.keys()).map((id) => getGrant(id)!);
}

export function getGrantPolicy(): GrantPolicy {
  return { ...grantPolicy };
}

export function setGrantPolicy(policy: GrantPolicy): void {
  grantPolicy = { ...policy };
}

export function resetForTesting(): void {
  signerRoster = [];
  signerPolicy = null;
  snapshots = [];
  currentStage = 'stage-0';
  reconciliationReports.length = 0;
  remediations.clear();
  grants.clear();
  grantPolicy = { outcomeWindowDays: 30 };
}
