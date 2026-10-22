/**
 * Catalog governance HTTP surface (#774, #775, #776, #778).
 *
 *   GET  /catalog/policy
 *   GET  /catalog/policy/versions/:version
 *   POST /catalog/proposals
 *   GET  /catalog/proposals
 *   GET  /catalog/proposals/:id
 *   POST /catalog/proposals/:id/reviews
 *   POST /catalog/proposals/:id/impact
 *   GET  /catalog/proposals/:id/impact
 *   POST /catalog/proposals/:id/activate
 *   POST /catalog/rollbacks
 *
 *   GET  /coi/disclosures
 *   POST /coi/disclosures
 *   POST /coi/disclosures/:id/withdraw
 *   POST /coi/attestations
 *   GET  /coi/eligibility
 *
 *   GET  /emergency
 *   POST /emergency
 *   GET  /emergency/monitoring
 *   GET  /emergency/:id
 *   POST /emergency/:id/review
 *   POST /emergency/:id/renew
 *   POST /emergency/:id/revoke
 *   POST /emergency/:id/disclosure
 *
 * Everything is mounted under the existing admin-authenticated
 * `/api/v1/governance` prefix.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { adminAuthMiddleware } from './auth';
import { auditLog } from './audit-logger';
import { sendErrorResponse } from '../infrastructure/error';
import { logger } from '../observability/logger';
import * as proposalService from './proposal-service';
import {
  CatalogGovernance,
  CatalogGovernanceError,
  canonicalJson,
  validateCatalogChange,
  type CatalogProposalStatus,
  type CatalogPolicyChange,
  type FeedPolicy,
  type OnChainAction,
  type OnChainExecution,
} from './catalog-policy';
import {
  ImpactSimulationError,
  simulateCatalogImpact,
  type ConsumerDependency,
  type ImpactCostModel,
} from './impact-simulator';
import { CoiError, CoiRegister } from './coi-register';
import {
  EmergencyActionError,
  EmergencyActionRegistry,
  type EmergencyActionStatus,
} from './emergency-actions';

const ADMIN_KEY_PREFIX = process.env.ADMIN_KEY_PREFIX || 'admin_';

export interface CatalogGovernanceStores {
  catalog: CatalogGovernance;
  coi: CoiRegister;
  emergency: EmergencyActionRegistry;
}

export interface CatalogGovernanceRouterOptions {
  now?: () => Date;
  genesisFeeds?: FeedPolicy[];
  /**
   * Confirms that `onChainProposalId` carries exactly this plan action on-chain.
   * Defaults to reading the multisig proposal store; injectable for tests and
   * for a real Soroban RPC reader.
   */
  verifyOnChainAction?: (action: OnChainAction, onChainProposalId: number) => Promise<boolean>;
}

// ── Schemas ──────────────────────────────────────────────────────────────────

const feedPolicySchema = z.object({
  asset: z.string(),
  sources: z.array(z.string()).min(1).max(8),
  minSources: z.number().int(),
  maxDeviationBps: z.number().int(),
  stalenessSeconds: z.number().int(),
  freshnessProfile: z.enum(['realtime', 'standard', 'delayed']).optional(),
  freshnessWarnSeconds: z.number().int().optional(),
  quoteUnit: z.object({
    currency: z.enum(['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD']),
    denomination: z.string(),
    scaleDecimals: z.number().int(),
    displayDecimals: z.number().int(),
    rounding: z.enum(['half-up', 'half-even', 'down']),
  }).optional(),
  enabled: z.boolean(),
});

const changeSchema = z.object({
  baseVersion: z.number().int().positive(),
  kind: z.enum(['standard', 'rollback']).default('standard'),
  upserts: z.array(feedPolicySchema).max(100).default([]),
  removals: z.array(z.string()).max(100).default([]),
});

const sourceAddressesSchema = z.record(z.string().min(1));

const createProposalSchema = z.object({
  description: z.string().min(1).max(2000),
  change: changeSchema,
  sourceAddresses: sourceAddressesSchema.optional(),
});

const reviewSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  attested: z.boolean(),
});

const consumerSchema = z.object({
  id: z.string().min(1),
  assets: z.array(z.string()).default([]),
  tier: z.string().optional(),
});

const impactSchema = z.object({
  consumers: z.array(consumerSchema).max(10_000).default([]),
  costModel: z
    .object({
      pollIntervalSeconds: z.number().positive(),
      perSourceFetchCost: z.number().min(0),
      perOnChainPublishCost: z.number().min(0),
      currency: z.string().optional(),
    })
    .optional(),
});

const activationSchema = z.object({
  executions: z
    .array(
      z.object({
        actionIndex: z.number().int().min(0),
        onChainProposalId: z.number().int().positive(),
      }),
    )
    .max(200)
    .default([]),
});

const rollbackSchema = z.object({
  targetVersion: z.number().int().positive(),
  description: z.string().max(2000).optional(),
  sourceAddresses: sourceAddressesSchema.optional(),
});

const coiDisclosureSchema = z.object({
  relationship: z.enum(['financial', 'employment', 'provider-affiliation', 'token-holding', 'family', 'other']),
  counterparty: z.string().min(1).max(120),
  scope: z.enum(['asset', 'source', 'protocol']),
  details: z.string().max(2000).optional(),
  expiresAt: z.string().datetime().optional(),
  attested: z.boolean(),
});

const coiAttestationSchema = z.object({
  statement: z.string().max(500).optional(),
});

const emergencyOpenSchema = z.object({
  kind: z.enum(['pause-feed', 'freeze-source', 'halt-publishing']),
  reason: z.string().min(1).max(500),
  asset: z.string().min(1).max(12).optional(),
  source: z.string().min(1).max(64).optional(),
  expiresAt: z.string().datetime().optional(),
  durationSeconds: z.number().int().positive().optional(),
});

const emergencyReviewSchema = z.object({
  decision: z.enum(['confirm', 'overturn']),
  attested: z.boolean(),
});

const emergencyRenewSchema = z.object({
  expiresAt: z.string().datetime().optional(),
  durationSeconds: z.number().int().positive().optional(),
});

const emergencyRevokeSchema = z.object({
  reason: z.string().max(500).optional(),
});

const emergencyDisclosureSchema = z.object({
  summary: z.string().min(1).max(2000),
});

const DEFAULT_COST_MODEL: ImpactCostModel = {
  pollIntervalSeconds: 30,
  perSourceFetchCost: 0.0004,
  perOnChainPublishCost: 0.002,
  currency: 'USD',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Decision-makers are identified by the credential they authenticated with,
 * never by a body field: independence between proposer, reviewers and
 * emergency authors only means something if one caller cannot claim to be
 * another. Deployments must issue a distinct admin credential per reviewer.
 */
function actorOf(req: Request): string {
  return req.apiKey?.substring(0, 16) || 'anonymous';
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'Internal error';
}

interface DomainErrorShape {
  code: string;
  status: number;
  details?: Record<string, unknown>;
}

function domainError(err: unknown): DomainErrorShape | null {
  if (
    err instanceof CatalogGovernanceError ||
    err instanceof CoiError ||
    err instanceof EmergencyActionError
  ) {
    return { code: err.code, status: err.status, details: err.details };
  }
  if (err instanceof ImpactSimulationError) {
    return { code: err.code, status: err.status };
  }
  return null;
}

function sendDomainError(res: Response, err: unknown): void {
  const shape = domainError(err);
  if (!shape) {
    logger.error('Catalog governance request failed', err);
    sendErrorResponse(res, 500, 'INTERNAL', messageOf(err));
    return;
  }
  if (shape.status >= 500) logger.error('Catalog governance request failed', err);
  else logger.warn(`Catalog governance rejected: ${shape.code} (${shape.status})`);
  res.status(shape.status).json({
    success: false,
    error: {
      code: shape.code,
      message: messageOf(err),
      ...(shape.details ? { details: shape.details } : {}),
    },
  });
}

function invalid(res: Response, path: string, issues: z.ZodIssue[]): void {
  logger.warn(`Catalog governance rejected: INVALID_REQUEST (${path})`);
  res.status(400).json({
    success: false,
    error: {
      code: 'INVALID_REQUEST',
      message: 'Request body failed validation',
      details: { issues },
    },
  });
}

const PROPOSAL_STATUSES: readonly CatalogProposalStatus[] = [
  'InReview',
  'Approved',
  'Rejected',
  'Activated',
  'Expired',
];

const EMERGENCY_STATUSES: readonly EmergencyActionStatus[] = [
  'Active',
  'Reviewed',
  'Expired',
  'Revoked',
  'ExpiredUnreviewed',
];

function statusOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

function proposalIdOf(req: Request, res: Response, path: string): number | null {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    sendErrorResponse(res, 400, 'INVALID_ID', 'Invalid proposal id', { path, method: req.method });
    return null;
  }
  return id;
}

/** Maps an API plan action onto the contract's proposal-action variants. */
function toProposalAction(action: OnChainAction): Record<string, unknown> {
  switch (action.action) {
    case 'SetTrustedAsset':
      return {
        variant: 'SetTrustedAsset',
        asset: String(action.params.asset),
        trusted: action.params.trusted ? 1 : 0,
      };
    case 'AddSource':
      return {
        variant: 'AddSource',
        source: String(action.params.source),
        name: String(action.params.name),
      };
    case 'RemoveSource':
      return { variant: 'RemoveSource', source: String(action.params.source) };
    case 'SetDeviationThreshold':
      return { variant: 'SetDeviationThreshold', thresholdBps: Number(action.params.thresholdBps) };
  }
}

async function defaultVerifyOnChainAction(
  action: OnChainAction,
  onChainProposalId: number,
): Promise<boolean> {
  const proposal = await proposalService.getMultiSigProposal(onChainProposalId);
  if (!proposal || proposal.executed !== 1) return false;
  return canonicalJson(proposal.action) === canonicalJson(toProposalAction(action));
}

// ── Router factory ───────────────────────────────────────────────────────────

export function createCatalogGovernanceRouter(
  options: CatalogGovernanceRouterOptions = {},
): { router: Router; stores: CatalogGovernanceStores } {
  const now = options.now ?? (() => new Date());
  const coi = new CoiRegister({ now });
  const emergency = new EmergencyActionRegistry({
    now,
    isRecused: (actor, request) => coi.recusalReasons(actor, request),
  });
  const catalog = new CatalogGovernance(
    {
      now,
      isRecused: (actor, request) => coi.recusalReasons(actor, request),
      isFrozen: (asset) => emergency.isFrozen(asset),
    },
    options.genesisFeeds,
  );

  const ensureEligible = (
    res: Response,
    actor: string,
    request: { assets: string[]; sources: string[] },
  ): boolean => {
    const eligibility = coi.checkEligibility(actor, request);
    if (eligibility.eligible) return true;
    res.status(409).json({
      success: false,
      error: {
        code: eligibility.code ?? 'CONFLICT_OF_INTEREST',
        message: `${actor} cannot participate: ${eligibility.reasons.join('; ')}`,
        details: { reasons: eligibility.reasons },
      },
    });
    return false;
  };
  const verifyOnChainAction = options.verifyOnChainAction ?? defaultVerifyOnChainAction;

  const router = Router();
  router.use(adminAuthMiddleware(ADMIN_KEY_PREFIX));

  // ── Catalog policy ─────────────────────────────────────────────────────────

  router.get('/catalog/policy', (_req: Request, res: Response) => {
    res.json({
      success: true,
      data: { policy: catalog.currentPolicy(), history: catalog.policyHistory() },
    });
  });

  router.get('/catalog/policy/versions/:version', (req: Request, res: Response) => {
    const version = Number.parseInt(req.params.version, 10);
    if (!Number.isInteger(version) || version <= 0) {
      return sendErrorResponse(res, 400, 'INVALID_VERSION', 'Invalid policy version', {
        path: '/catalog/policy/versions/:version',
        method: 'GET',
      });
    }
    try {
      res.json({ success: true, data: catalog.policyVersion(version) });
    } catch (err) {
      sendDomainError(res, err);
    }
  });

  // ── Proposals ──────────────────────────────────────────────────────────────

  router.post('/catalog/proposals', (req: Request, res: Response) => {
    const parsed = createProposalSchema.safeParse(req.body);
    if (!parsed.success) {
      return invalid(res, '/catalog/proposals', parsed.error.issues);
    }
    try {
      const proposal = catalog.createProposal({
        proposer: actorOf(req),
        description: parsed.data.description,
        change: parsed.data.change as CatalogPolicyChange,
        sourceAddresses: parsed.data.sourceAddresses,
      });
      auditLog('governance.catalog_proposal_created', {
        apiKeyPrefix: req.apiKey?.substring(0, 8),
        details: {
          proposalId: proposal.id,
          baseVersion: proposal.change.baseVersion,
          highImpact: proposal.highImpact,
          requiredApprovals: proposal.requiredApprovals,
          onChainActions: proposal.onChainPlan.actions.length,
        },
      });
      res.status(201).json({ success: true, data: proposal });
    } catch (err) {
      sendDomainError(res, err);
    }
  });

  router.get('/catalog/proposals', (req: Request, res: Response) => {
    const status = statusOf(req.query.status, PROPOSAL_STATUSES);
    res.json({ success: true, data: { proposals: catalog.listProposals({ status }) } });
  });

  router.get('/catalog/proposals/:id', (req: Request, res: Response) => {
    const id = proposalIdOf(req, res, '/catalog/proposals/:id');
    if (id === null) return;
    try {
      res.json({ success: true, data: catalog.getProposal(id) });
    } catch (err) {
      sendDomainError(res, err);
    }
  });

  router.post('/catalog/proposals/:id/reviews', (req: Request, res: Response) => {
    const id = proposalIdOf(req, res, '/catalog/proposals/:id/reviews');
    if (id === null) return;
    const parsed = reviewSchema.safeParse(req.body);
    if (!parsed.success) {
      return invalid(res, '/catalog/proposals/:id/reviews', parsed.error.issues);
    }
    try {
      const reviewer = actorOf(req);
      const existing = catalog.getProposal(id);
      const assets = new Set<string>(existing.change.removals);
      const sources = new Set<string>();
      for (const feed of existing.change.upserts) {
        assets.add(feed.asset);
        for (const source of feed.sources) sources.add(source);
      }
      if (
        !ensureEligible(res, reviewer, {
          assets: [...assets],
          sources: [...sources],
        })
      ) {
        return;
      }
      const proposal = catalog.recordReview(id, reviewer, parsed.data.decision, {
        attested: parsed.data.attested,
      });
      auditLog('governance.catalog_proposal_reviewed', {
        apiKeyPrefix: req.apiKey?.substring(0, 8),
        details: {
          proposalId: id,
          decision: parsed.data.decision,
          status: proposal.status,
          approvals: proposal.reviews.filter((review) => review.decision === 'approve').length,
        },
      });
      res.json({ success: true, data: proposal });
    } catch (err) {
      sendDomainError(res, err);
    }
  });

  router.post('/catalog/proposals/:id/impact', (req: Request, res: Response) => {
    const id = proposalIdOf(req, res, '/catalog/proposals/:id/impact');
    if (id === null) return;
    const parsed = impactSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return invalid(res, '/catalog/proposals/:id/impact', parsed.error.issues);
    }
    try {
      const proposal = catalog.getProposal(id);
      const current = catalog.currentPolicy();
      const validation = validateCatalogChange(current, proposal.change);
      const report = simulateCatalogImpact({
        current,
        nextFeeds: validation.nextFeeds,
        diff: validation.diff,
        findings: validation.findings,
        highImpact: proposal.highImpact,
        consumers: parsed.data.consumers as ConsumerDependency[],
        costModel: parsed.data.costModel ?? DEFAULT_COST_MODEL,
      });
      const updated = catalog.attachImpact(id, {
        generatedAt: report.generatedAt,
        deterministicHash: report.deterministicHash,
        risk: report.risk,
        approvalBlocked: report.approvalBlocked,
        warnings: report.warnings,
        details: report as unknown as Record<string, unknown>,
      });
      auditLog('governance.impact_simulated', {
        apiKeyPrefix: req.apiKey?.substring(0, 8),
        details: {
          proposalId: id,
          risk: report.risk,
          affectedConsumers: report.affectedConsumers.total,
          deterministicHash: report.deterministicHash,
        },
      });
      res.json({ success: true, data: { report, proposal: updated } });
    } catch (err) {
      sendDomainError(res, err);
    }
  });

  router.get('/catalog/proposals/:id/impact', (req: Request, res: Response) => {
    const id = proposalIdOf(req, res, '/catalog/proposals/:id/impact');
    if (id === null) return;
    try {
      const proposal = catalog.getProposal(id);
      if (!proposal.impact) {
        return sendErrorResponse(res, 404, 'IMPACT_NOT_AVAILABLE', 'No impact analysis recorded yet', {
          path: '/catalog/proposals/:id/impact',
          method: 'GET',
        });
      }
      res.json({ success: true, data: proposal.impact.details ?? proposal.impact });
    } catch (err) {
      sendDomainError(res, err);
    }
  });

  router.post('/catalog/proposals/:id/activate', async (req: Request, res: Response) => {
    const id = proposalIdOf(req, res, '/catalog/proposals/:id/activate');
    if (id === null) return;
    const parsed = activationSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return invalid(res, '/catalog/proposals/:id/activate', parsed.error.issues);
    }
    try {
      const proposal = catalog.getProposal(id);
      const executions: OnChainExecution[] = parsed.data.executions.map((execution) => ({
        actionIndex: execution.actionIndex,
        onChainProposalId: execution.onChainProposalId,
      }));

      for (const execution of executions) {
        const action = proposal.onChainPlan.actions[execution.actionIndex];
        if (!action) continue;
        const verified = await verifyOnChainAction(action, execution.onChainProposalId);
        if (!verified) {
          return sendErrorResponse(
            res,
            409,
            'ON_CHAIN_ACTION_MISMATCH',
            `On-chain proposal ${execution.onChainProposalId} does not carry plan action ${execution.actionIndex}`,
            { path: '/catalog/proposals/:id/activate', method: 'POST' },
          );
        }
      }

      const activated = catalog.activate(id, actorOf(req), executions);
      auditLog('governance.catalog_policy_activated', {
        apiKeyPrefix: req.apiKey?.substring(0, 8),
        details: {
          proposalId: id,
          policyVersion: activated.activatedVersion,
          digest: activated.onChainPlan.digest,
          onChainExecutions: executions.length,
        },
        newState: { catalogPolicyVersion: activated.activatedVersion },
      });
      res.json({ success: true, data: { proposal: activated, policy: catalog.currentPolicy() } });
    } catch (err) {
      sendDomainError(res, err);
    }
  });

  router.post('/catalog/rollbacks', (req: Request, res: Response) => {
    const parsed = rollbackSchema.safeParse(req.body);
    if (!parsed.success) {
      return invalid(res, '/catalog/rollbacks', parsed.error.issues);
    }
    try {
      const proposal = catalog.createRollbackProposal({
        proposer: actorOf(req),
        targetVersion: parsed.data.targetVersion,
        description: parsed.data.description,
        sourceAddresses: parsed.data.sourceAddresses,
      });
      auditLog('governance.catalog_rollback_proposed', {
        apiKeyPrefix: req.apiKey?.substring(0, 8),
        details: {
          proposalId: proposal.id,
          targetVersion: parsed.data.targetVersion,
          requiredApprovals: proposal.requiredApprovals,
        },
      });
      res.status(201).json({ success: true, data: proposal });
    } catch (err) {
      sendDomainError(res, err);
    }
  });

  // ── Conflict-of-interest register ──────────────────────────────────────────

  router.get('/coi/disclosures', (req: Request, res: Response) => {
    const status = statusOf(req.query.status, ['active', 'withdrawn', 'expired'] as const);
    res.json({
      success: true,
      data: {
        disclosures: coi.list({
          actor: typeof req.query.actor === 'string' ? req.query.actor : undefined,
          status,
        }),
      },
    });
  });

  router.post('/coi/disclosures', (req: Request, res: Response) => {
    const parsed = coiDisclosureSchema.safeParse(req.body);
    if (!parsed.success) {
      return invalid(res, '/coi/disclosures', parsed.error.issues);
    }
    try {
      const disclosure = coi.declare({ ...parsed.data, actor: actorOf(req) });
      auditLog('governance.coi_disclosed', {
        apiKeyPrefix: req.apiKey?.substring(0, 8),
        details: {
          disclosureId: disclosure.id,
          scope: disclosure.scope,
          relationship: disclosure.relationship,
          expiresAt: disclosure.expiresAt,
        },
      });
      res.status(201).json({ success: true, data: disclosure });
    } catch (err) {
      sendDomainError(res, err);
    }
  });

  router.post('/coi/disclosures/:id/withdraw', (req: Request, res: Response) => {
    try {
      const disclosure = coi.withdraw(req.params.id, actorOf(req));
      auditLog('governance.coi_withdrawn', {
        apiKeyPrefix: req.apiKey?.substring(0, 8),
        details: { disclosureId: disclosure.id },
      });
      res.json({ success: true, data: disclosure });
    } catch (err) {
      sendDomainError(res, err);
    }
  });

  router.post('/coi/attestations', (req: Request, res: Response) => {
    const parsed = coiAttestationSchema.safeParse(req.body);
    if (!parsed.success) {
      return invalid(res, '/coi/attestations', parsed.error.issues);
    }
    try {
      const actor = actorOf(req);
      const attestation = coi.attest(actor, parsed.data.statement);
      auditLog('governance.coi_attested', {
        apiKeyPrefix: req.apiKey?.substring(0, 8),
        details: { actor, expiresAt: attestation.expiresAt },
      });
      res.status(201).json({ success: true, data: attestation });
    } catch (err) {
      sendDomainError(res, err);
    }
  });

  router.get('/coi/eligibility', (req: Request, res: Response) => {
    const actor = typeof req.query.actor === 'string' ? req.query.actor : '';
    if (!actor) {
      return sendErrorResponse(res, 400, 'INVALID_REQUEST', '"actor" query parameter is required', {
        path: '/coi/eligibility',
        method: 'GET',
      });
    }
    const assets = String(req.query.assets ?? '')
      .split(',')
      .map((asset) => asset.trim())
      .filter(Boolean);
    const sources = String(req.query.sources ?? '')
      .split(',')
      .map((source) => source.trim())
      .filter(Boolean);
    res.json({
      success: true,
      data: {
        actor,
        attestation: coi.attestationStatus(actor),
        eligibility: coi.checkEligibility(actor, { assets, sources }),
      },
    });
  });

  // ── Emergency actions ──────────────────────────────────────────────────────

  router.get('/emergency', (req: Request, res: Response) => {
    res.json({
      success: true,
      data: {
        actions: emergency.list({ status: statusOf(req.query.status, EMERGENCY_STATUSES) }),
        overlays: (() => {
          const overlays = emergency.activeOverlays();
          return {
            assets: [...overlays.assets],
            sources: [...overlays.sources],
            halted: overlays.halted,
          };
        })(),
        limits: {
          maxDurationSeconds: 72 * 60 * 60,
          reviewWindowSeconds: 24 * 60 * 60,
          disclosureWindowSeconds: 24 * 60 * 60,
          maxRenewals: 2,
        },
      },
    });
  });

  router.post('/emergency', (req: Request, res: Response) => {
    const parsed = emergencyOpenSchema.safeParse(req.body);
    if (!parsed.success) {
      return invalid(res, '/emergency', parsed.error.issues);
    }
    try {
      const action = emergency.open({
        ...parsed.data,
        actor: actorOf(req),
      });
      auditLog('governance.emergency_opened', {
        apiKeyPrefix: req.apiKey?.substring(0, 8),
        details: {
          actionId: action.id,
          kind: action.kind,
          asset: action.asset,
          source: action.source,
          expiresAt: action.expiresAt,
          policyVersion: action.policyVersionAtCreation,
        },
      });
      res.status(201).json({ success: true, data: action });
    } catch (err) {
      sendDomainError(res, err);
    }
  });

  router.get('/emergency/monitoring', (_req: Request, res: Response) => {
    res.json({
      success: true,
      data: {
        overdueReviews: emergency.overdueReviews(),
        overdueDisclosures: emergency.overdueDisclosures(),
        open: emergency.list({ status: 'Active' }),
      },
    });
  });

  router.get('/emergency/:id', (req: Request, res: Response) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return sendErrorResponse(res, 400, 'INVALID_ID', 'Invalid emergency action id', {
        path: '/emergency/:id',
        method: 'GET',
      });
    }
    try {
      res.json({ success: true, data: emergency.get(id) });
    } catch (err) {
      sendDomainError(res, err);
    }
  });

  router.post('/emergency/:id/review', (req: Request, res: Response) => {
    const parsed = emergencyReviewSchema.safeParse(req.body);
    if (!parsed.success) {
      return invalid(res, '/emergency/:id/review', parsed.error.issues);
    }
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return sendErrorResponse(res, 400, 'INVALID_ID', 'Invalid emergency action id', {
        path: '/emergency/:id/review',
        method: 'POST',
      });
    }
    try {
      const reviewer = actorOf(req);
      const existing = emergency.get(id);
      if (
        !ensureEligible(res, reviewer, {
          assets: existing.asset ? [existing.asset] : [],
          sources: existing.source ? [existing.source] : [],
        })
      ) {
        return;
      }
      const action = emergency.review(id, reviewer, {
        decision: parsed.data.decision,
        attested: parsed.data.attested,
      });
      auditLog('governance.emergency_reviewed', {
        apiKeyPrefix: req.apiKey?.substring(0, 8),
        details: { actionId: id, decision: parsed.data.decision, status: action.status },
      });
      res.json({ success: true, data: action });
    } catch (err) {
      sendDomainError(res, err);
    }
  });

  router.post('/emergency/:id/renew', (req: Request, res: Response) => {
    const parsed = emergencyRenewSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return invalid(res, '/emergency/:id/renew', parsed.error.issues);
    }
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return sendErrorResponse(res, 400, 'INVALID_ID', 'Invalid emergency action id', {
        path: '/emergency/:id/renew',
        method: 'POST',
      });
    }
    try {
      const action = emergency.renew(id, actorOf(req), {
        expiresAt: parsed.data.expiresAt,
        durationSeconds: parsed.data.durationSeconds,
      });
      auditLog('governance.emergency_renewed', {
        apiKeyPrefix: req.apiKey?.substring(0, 8),
        details: { actionId: id, renewals: action.renewals, expiresAt: action.expiresAt },
      });
      res.json({ success: true, data: action });
    } catch (err) {
      sendDomainError(res, err);
    }
  });

  router.post('/emergency/:id/revoke', (req: Request, res: Response) => {
    const parsed = emergencyRevokeSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return invalid(res, '/emergency/:id/revoke', parsed.error.issues);
    }
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return sendErrorResponse(res, 400, 'INVALID_ID', 'Invalid emergency action id', {
        path: '/emergency/:id/revoke',
        method: 'POST',
      });
    }
    try {
      const action = emergency.revoke(id, actorOf(req), parsed.data.reason);
      auditLog('governance.emergency_revoked', {
        apiKeyPrefix: req.apiKey?.substring(0, 8),
        details: { actionId: id, reason: parsed.data.reason },
      });
      res.json({ success: true, data: action });
    } catch (err) {
      sendDomainError(res, err);
    }
  });

  router.post('/emergency/:id/disclosure', (req: Request, res: Response) => {
    const parsed = emergencyDisclosureSchema.safeParse(req.body);
    if (!parsed.success) {
      return invalid(res, '/emergency/:id/disclosure', parsed.error.issues);
    }
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return sendErrorResponse(res, 400, 'INVALID_ID', 'Invalid emergency action id', {
        path: '/emergency/:id/disclosure',
        method: 'POST',
      });
    }
    try {
      const action = emergency.publishDisclosure(id, {
        summary: parsed.data.summary,
        actor: actorOf(req),
      });
      auditLog('governance.emergency_disclosed', {
        apiKeyPrefix: req.apiKey?.substring(0, 8),
        details: { actionId: id, publishedAt: action.disclosure.publishedAt },
      });
      res.status(201).json({ success: true, data: action });
    } catch (err) {
      sendDomainError(res, err);
    }
  });

  return { router, stores: { catalog, coi, emergency } };
}

export default createCatalogGovernanceRouter;
