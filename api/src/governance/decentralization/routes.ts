import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { adminAuthMiddleware } from '../auth';
import { auditLog } from '../audit-logger';
import { sendErrorResponse } from '../../infrastructure/error';
import { logger } from '../../observability/logger';
import {
  DEFAULT_SIGNER_INDEPENDENCE_POLICY,
  evaluateSignerIndependence,
} from './signer-independence';
import {
  getStageGateReport,
  recordConcentrationSnapshot,
  transitionStage,
} from './stage-gates';
import {
  publishReconciliationReport,
  reconcileGovernanceExecution,
  refreshReconciliationMetrics,
} from './execution-audit';
import {
  buildGrantStatusReport,
  grantOutcomesSummary,
  recordGrantOutcome,
  registerGrant,
  submitMilestoneEvidence,
  transitionGrantStatus,
} from './grant-outcomes';
import {
  getGrant,
  getSignerPolicy,
  getSignerRoster,
  listGrants,
  listReconciliationReports,
  findReconciliationReport,
  remediationKey,
  setRemediation,
  setSignerRoster,
} from './store';
import {
  GovernanceReportingError,
  type DiscrepancyKind,
  type GovernanceSurface,
  type GrantStatus,
  type RemediationStatus,
} from './types';
import type { ProposalAction, ProposalStatus } from '../proposal-types';

const router = Router();
const ADMIN_KEY_PREFIX = process.env.ADMIN_KEY_PREFIX || 'admin_';

// These reports expose signer identities and governance exposures, so they are
// admin-only like the rest of /api/v1/governance.
router.use(adminAuthMiddleware(ADMIN_KEY_PREFIX));

const CUSTODY_TYPES = [
  'hsm',
  'hardware_wallet',
  'cloud_kms',
  'multisig_agent',
  'software',
] as const;
const RELATIONSHIPS = ['employment', 'equity', 'custody', 'board', 'family', 'other'] as const;
const PROPOSAL_STATUSES = [
  'Active',
  'Queued',
  'Ready',
  'Executed',
  'Defeated',
  'Cancelled',
] as const;
const DISCREPANCY_KINDS = [
  'mismatch',
  'missing_change',
  'unapproved_change',
  'overdue_execution',
  'inconsistent_proposal',
  'unverifiable_effect',
] as const;
const REMEDIATION_STATUSES = ['open', 'in_progress', 'resolved', 'accepted_risk'] as const;
const GRANT_STATUSES = ['proposed', 'approved', 'active', 'completed', 'cancelled'] as const;

const conflictSchema = z.object({
  party: z.string().min(1),
  relationship: z.enum(RELATIONSHIPS),
  mitigation: z.string().min(1),
});

const signerSchema = z.object({
  address: z.string().min(1),
  organization: z.string().min(1),
  custody: z.enum(CUSTODY_TYPES),
  custodyProvider: z.string().min(1),
  region: z.string().min(1),
  addedAt: z.number().int().positive(),
  lastRotatedAt: z.number().int().positive(),
  availabilityPct: z.number().min(0).max(100),
  conflicts: z.array(conflictSchema),
});

const signerPolicySchema = z
  .object({
    minIndependentSigners: z.number().int().positive(),
    rotationIntervalDays: z.number().positive(),
    minAvailabilityPct: z.number().min(0).max(100),
    maxSignersPerCustodyProvider: z.number().int().positive(),
    maxSignersPerOrganization: z.number().int().positive(),
    disallowedCustody: z.array(z.enum(CUSTODY_TYPES)),
  })
  .partial();

const weightedEntitySchema = z.object({
  id: z.string().min(1),
  weight: z.number().nonnegative(),
});

const snapshotSchema = z.object({
  capturedAt: z.number().int().positive().optional(),
  provider: z.array(weightedEntitySchema).min(1),
  signer: z.array(weightedEntitySchema).min(1),
  governance: z.array(weightedEntitySchema).min(1),
  region: z.array(weightedEntitySchema).min(1),
});

const governanceConfigSchema = z.object({
  token: z.string(),
  votingPeriod: z.number(),
  timelockDelay: z.number(),
  quorum: z.number(),
  proposalThreshold: z.number(),
  guardian: z.string(),
});

const proposalActionSchema = z.discriminatedUnion('variant', [
  z.object({ variant: z.literal('AddSource'), source: z.string(), name: z.string() }),
  z.object({ variant: z.literal('RemoveSource'), source: z.string() }),
  z.object({
    variant: z.literal('SetTrustedAsset'),
    asset: z.string(),
    trusted: z.number(),
  }),
  z.object({ variant: z.literal('TransferAdmin'), newAdmin: z.string() }),
  z.object({ variant: z.literal('SetDeviationThreshold'), thresholdBps: z.number() }),
  z.object({ variant: z.literal('ResetReputation'), source: z.string() }),
  z.object({ variant: z.literal('AddSigner'), signer: z.string() }),
  z.object({ variant: z.literal('RemoveSigner'), signer: z.string() }),
  z.object({ variant: z.literal('SetThreshold'), threshold: z.number() }),
  z.object({ variant: z.literal('SetAdmin'), newAdmin: z.string() }),
  z.object({ variant: z.literal('AddOracleSource'), source: z.string(), name: z.string() }),
  z.object({ variant: z.literal('RemoveOracleSource'), source: z.string() }),
  z.object({ variant: z.literal('UpdateGovernanceConfig'), config: governanceConfigSchema }),
]);

const stateValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
  z.null(),
]);

const governanceStateSchema = z.object({
  onchain: z.record(z.string(), stateValueSchema),
  offchain: z.record(z.string(), stateValueSchema),
});

const auditableProposalSchema = z.object({
  id: z.number().int().positive(),
  status: z.enum(PROPOSAL_STATUSES),
  action: proposalActionSchema,
  approvedAt: z.number().int().positive(),
  executedAt: z.number().int().positive().optional(),
  executionTime: z.number().int().positive().optional(),
  description: z.string().optional(),
});

const executionAuditSchema = z.object({
  baseline: governanceStateSchema,
  observed: governanceStateSchema,
  proposals: z.array(auditableProposalSchema),
  maxExecutionDelaySeconds: z.number().int().positive().optional(),
});

const remediationSchema = z.object({
  key: z.string().min(1),
  surface: z.enum(['onchain', 'offchain']),
  kind: z.enum(DISCREPANCY_KINDS),
  status: z.enum(REMEDIATION_STATUSES),
  owner: z.string().min(1).optional(),
  note: z.string().optional(),
});

const evidenceSchema = z.object({
  uri: z.string().url(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/i),
  submittedAt: z.number().int().positive(),
  verifiedAt: z.number().int().positive().optional(),
  verifiedBy: z.string().min(1).optional(),
});

const objectiveSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  metric: z.string().min(1),
  target: z.number().finite(),
  unit: z.string().min(1),
  direction: z.enum(['min', 'max']).default('min'),
});

const milestoneSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  dueAt: z.number().int().positive(),
  acceptanceCriteria: z.string().min(1),
  evidence: evidenceSchema.optional(),
});

const grantSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  recipient: z.string().min(1),
  owner: z.string().min(1),
  status: z.enum(GRANT_STATUSES).optional(),
  approvedAt: z.number().int().positive().optional(),
  completedAt: z.number().int().positive().optional(),
  objectives: z.array(objectiveSchema).min(1),
  milestones: z.array(milestoneSchema).min(1),
  conflicts: z.object({
    disclosed: z.boolean(),
    conflicts: z.array(conflictSchema),
  }),
});

const outcomeSchema = z.object({
  summary: z.string().min(1),
  reportedAt: z.number().int().positive().optional(),
  results: z
    .array(
      z.object({
        objectiveId: z.string().min(1),
        actual: z.number().finite(),
        evidenceUri: z.string().url(),
      }),
    )
    .min(1),
});

function parseBody<S extends z.ZodTypeAny>(
  schema: S,
  req: Request,
  res: Response,
  path: string,
): z.output<S> | null {
  const result = schema.safeParse(req.body);
  if (result.success) return result.data;

  const message = result.error.issues
    .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
    .join('; ');
  sendErrorResponse(res, 400, 'INVALID_REQUEST', message, { path, method: req.method });
  return null;
}

function statusForError(error: GovernanceReportingError): number {
  if (error.code.endsWith('_NOT_FOUND')) return 404;
  if (error.code.startsWith('DUPLICATE') || error.code === 'EVIDENCE_IMMUTABLE') return 409;
  if (
    [
      'STAGE_GATE_NOT_MET',
      'INVALID_STAGE_TRANSITION',
      'OUTCOME_BEFORE_COMPLETION',
      'OUTCOME_ALREADY_RECORDED',
      'EVIDENCE_MISSING_FOR_COMPLETION',
      'GRANT_CANCELLED',
    ].includes(error.code)
  ) {
    return 409;
  }
  if (error.code === 'UNKNOWN_STAGE' || error.code === 'NO_SNAPSHOT') return 404;
  return 400;
}

function failure(res: Response, error: unknown, context: string): void {
  if (error instanceof GovernanceReportingError) {
    sendErrorResponse(res, statusForError(error), error.code, error.message, {
      path: res.req.path,
    });
    return;
  }
  logger.error(context, error);
  const message = error instanceof Error ? error.message : 'Internal error';
  sendErrorResponse(res, 500, 'INTERNAL', message, { path: res.req.path });
}

// ── Signer independence (#782) ───────────────────────────────────────────────

router.put('/signers', (req: Request, res: Response) => {
  const body = parseBody(
    z.object({ signers: z.array(signerSchema).min(1), policy: signerPolicySchema.optional() }),
    req,
    res,
    '/governance/decentralization/signers',
  );
  if (!body) return;

  try {
    const policy = {
      ...DEFAULT_SIGNER_INDEPENDENCE_POLICY,
      ...body.policy,
      disallowedCustody:
        body.policy?.disallowedCustody ?? DEFAULT_SIGNER_INDEPENDENCE_POLICY.disallowedCustody,
    };
    setSignerRoster(body.signers, policy);
    auditLog('governance.signer_roster_updated', {
      apiKeyPrefix: req.apiKey?.substring(0, 8),
      details: { signers: body.signers.length },
    });
    res.json({ success: true, data: evaluateSignerIndependence(body.signers, policy) });
  } catch (error) {
    failure(res, error, 'Failed to update signer roster');
  }
});

router.get('/signers/independence', (_req: Request, res: Response) => {
  try {
    const roster = getSignerRoster();
    if (roster.length === 0) {
      return sendErrorResponse(
        res,
        404,
        'SIGNER_ROSTER_NOT_SET',
        'No signer roster has been registered; PUT /governance/decentralization/signers first',
        { path: '/governance/decentralization/signers/independence' },
      );
    }
    const policy = getSignerPolicy() ?? DEFAULT_SIGNER_INDEPENDENCE_POLICY;
    res.json({ success: true, data: evaluateSignerIndependence(roster, policy) });
  } catch (error) {
    failure(res, error, 'Failed to evaluate signer independence');
  }
});

// ── Decentralization stage gates (#783) ──────────────────────────────────────

router.post('/stage-gates/snapshots', (req: Request, res: Response) => {
  const body = parseBody(
    snapshotSchema,
    req,
    res,
    '/governance/decentralization/stage-gates/snapshots',
  );
  if (!body) return;

  try {
    const report = recordConcentrationSnapshot(
      {
        provider: body.provider,
        signer: body.signer,
        governance: body.governance,
        region: body.region,
      },
      body.capturedAt,
    );
    auditLog('governance.concentration_snapshot_recorded', {
      apiKeyPrefix: req.apiKey?.substring(0, 8),
      details: {
        snapshotId: report.snapshotId,
        achievedStage: report.achievedStage,
        currentStage: report.currentStage,
      },
    });
    res.status(201).json({ success: true, data: report });
  } catch (error) {
    failure(res, error, 'Failed to record concentration snapshot');
  }
});

router.get('/stage-gates', (_req: Request, res: Response) => {
  try {
    res.json({ success: true, data: getStageGateReport() });
  } catch (error) {
    failure(res, error, 'Failed to evaluate stage gates');
  }
});

router.post('/stage-gates/transition', (req: Request, res: Response) => {
  const body = parseBody(
    z.object({ stage: z.enum(['stage-0', 'stage-1', 'stage-2', 'stage-3']) }),
    req,
    res,
    '/governance/decentralization/stage-gates/transition',
  );
  if (!body) return;

  try {
    const report = transitionStage(body.stage);
    auditLog('governance.stage_transition', {
      apiKeyPrefix: req.apiKey?.substring(0, 8),
      details: { stage: body.stage },
    });
    res.json({ success: true, data: report });
  } catch (error) {
    failure(res, error, 'Failed to transition decentralization stage');
  }
});

// ── Governance execution audit (#784) ────────────────────────────────────────

router.post('/execution-audit', (req: Request, res: Response) => {
  const body = parseBody(
    executionAuditSchema,
    req,
    res,
    '/governance/decentralization/execution-audit',
  );
  if (!body) return;

  try {
    const report = reconcileGovernanceExecution({
      baseline: body.baseline,
      observed: body.observed,
      proposals: body.proposals.map((proposal) => ({
        ...proposal,
        action: proposal.action as ProposalAction,
        status: proposal.status as ProposalStatus,
      })),
      maxExecutionDelaySeconds: body.maxExecutionDelaySeconds,
    });
    publishReconciliationReport(report);
    auditLog('governance.execution_reconciled', {
      apiKeyPrefix: req.apiKey?.substring(0, 8),
      details: {
        reportId: report.id,
        discrepancies: report.discrepancies.length,
        critical: report.summary.critical,
      },
    });
    res.status(201).json({ success: true, data: report });
  } catch (error) {
    failure(res, error, 'Failed to reconcile governance execution');
  }
});

router.get('/execution-audit', (_req: Request, res: Response) => {
  try {
    res.json({ success: true, data: { reports: listReconciliationReports() } });
  } catch (error) {
    failure(res, error, 'Failed to list reconciliation reports');
  }
});

router.post('/execution-audit/:reportId/remediation', (req: Request, res: Response) => {
  const body = parseBody(
    remediationSchema,
    req,
    res,
    '/governance/decentralization/execution-audit/:reportId/remediation',
  );
  if (!body) return;

  try {
    const report = findReconciliationReport(req.params.reportId);
    if (!report) {
      return sendErrorResponse(
        res,
        404,
        'REPORT_NOT_FOUND',
        `Reconciliation report ${req.params.reportId} not found`,
        { path: res.req.path },
      );
    }

    const discrepancy = report.discrepancies.find(
      (candidate) =>
        candidate.key === body.key &&
        candidate.surface === body.surface &&
        candidate.kind === body.kind,
    );
    if (!discrepancy) {
      return sendErrorResponse(
        res,
        404,
        'DISCREPANCY_NOT_FOUND',
        `No ${body.kind} discrepancy for ${body.surface} key "${body.key}" in this report`,
        { path: res.req.path },
      );
    }

    const remediation = {
      status: body.status as RemediationStatus,
      owner: body.owner,
      note: body.note,
      updatedAt: Math.floor(Date.now() / 1000),
    };
    setRemediation(
      remediationKey(body.surface as GovernanceSurface, body.key, body.kind as DiscrepancyKind),
      remediation,
    );

    discrepancy.remediation = remediation;
    discrepancy.remediationStatus = remediation.status;
    report.summary = {
      critical: report.discrepancies.filter((d) => d.severity === 'critical').length,
      high: report.discrepancies.filter((d) => d.severity === 'high').length,
      medium: report.discrepancies.filter((d) => d.severity === 'medium').length,
      untriaged: report.discrepancies.filter((d) => d.remediationStatus === 'untriaged').length,
      resolved: report.discrepancies.filter((d) => d.remediationStatus === 'resolved').length,
    };
    refreshReconciliationMetrics(report);

    auditLog('governance.remediation_updated', {
      apiKeyPrefix: req.apiKey?.substring(0, 8),
      details: { reportId: report.id, key: body.key, status: body.status },
    });

    res.json({ success: true, data: { reportId: report.id, discrepancy, summary: report.summary } });
  } catch (error) {
    failure(res, error, 'Failed to update remediation');
  }
});

// ── Grant outcomes (#785) ────────────────────────────────────────────────────

router.post('/grants', (req: Request, res: Response) => {
  const body = parseBody(grantSchema, req, res, '/governance/decentralization/grants');
  if (!body) return;

  try {
    const grant = registerGrant({
      ...body,
      status: body.status as GrantStatus | undefined,
    });
    auditLog('governance.grant_registered', {
      apiKeyPrefix: req.apiKey?.substring(0, 8),
      details: { grantId: grant.id, objectives: grant.objectives.length },
    });
    res.status(201).json({ success: true, data: buildGrantStatusReport(grant) });
  } catch (error) {
    failure(res, error, 'Failed to register grant');
  }
});

router.get('/grants/outcomes/report', (_req: Request, res: Response) => {
  try {
    res.json({ success: true, data: grantOutcomesSummary() });
  } catch (error) {
    failure(res, error, 'Failed to build grant outcomes report');
  }
});

router.get('/grants', (_req: Request, res: Response) => {
  try {
    res.json({
      success: true,
      data: { grants: listGrants().map((grant) => buildGrantStatusReport(grant)) },
    });
  } catch (error) {
    failure(res, error, 'Failed to list grants');
  }
});

router.post('/grants/:grantId/milestones/:milestoneId/evidence', (req: Request, res: Response) => {
  const body = parseBody(
    evidenceSchema,
    req,
    res,
    '/governance/decentralization/grants/:grantId/milestones/:milestoneId/evidence',
  );
  if (!body) return;

  try {
    const grant = submitMilestoneEvidence(req.params.grantId, req.params.milestoneId, body);
    auditLog('governance.grant_evidence_submitted', {
      apiKeyPrefix: req.apiKey?.substring(0, 8),
      details: {
        grantId: req.params.grantId,
        milestoneId: req.params.milestoneId,
        verified: body.verifiedAt !== undefined,
      },
    });
    res.json({ success: true, data: buildGrantStatusReport(grant) });
  } catch (error) {
    failure(res, error, 'Failed to submit milestone evidence');
  }
});

router.post('/grants/:grantId/status', (req: Request, res: Response) => {
  const body = parseBody(
    z.object({ status: z.enum(GRANT_STATUSES) }),
    req,
    res,
    '/governance/decentralization/grants/:grantId/status',
  );
  if (!body) return;

  try {
    const grant = transitionGrantStatus(req.params.grantId, body.status as GrantStatus);
    auditLog('governance.grant_status_changed', {
      apiKeyPrefix: req.apiKey?.substring(0, 8),
      details: { grantId: req.params.grantId, status: body.status },
    });
    res.json({ success: true, data: buildGrantStatusReport(grant) });
  } catch (error) {
    failure(res, error, 'Failed to change grant status');
  }
});

router.post('/grants/:grantId/outcome', (req: Request, res: Response) => {
  const body = parseBody(
    outcomeSchema,
    req,
    res,
    '/governance/decentralization/grants/:grantId/outcome',
  );
  if (!body) return;

  try {
    const grant = recordGrantOutcome(req.params.grantId, body);
    auditLog('governance.grant_outcome_recorded', {
      apiKeyPrefix: req.apiKey?.substring(0, 8),
      details: { grantId: req.params.grantId, results: body.results.length },
    });
    res.status(201).json({ success: true, data: buildGrantStatusReport(grant) });
  } catch (error) {
    failure(res, error, 'Failed to record grant outcome');
  }
});

router.get('/grants/:grantId', (req: Request, res: Response) => {
  try {
    const grant = getGrant(req.params.grantId);
    if (!grant) {
      return sendErrorResponse(
        res,
        404,
        'GRANT_NOT_FOUND',
        `Grant "${req.params.grantId}" is not registered`,
        { path: res.req.path },
      );
    }
    res.json({ success: true, data: buildGrantStatusReport(grant) });
  } catch (error) {
    failure(res, error, 'Failed to read grant');
  }
});

export default router;
