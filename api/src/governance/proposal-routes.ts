/**
 * Governance & Multi-Sig Proposal API Routes
 *
 * Multi-sig endpoints (signer-based):
 *   GET    /api/v1/governance/multisig/config
 *   GET    /api/v1/governance/multisig/proposals
 *   GET    /api/v1/governance/multisig/proposals/:id
 *   POST   /api/v1/governance/multisig/proposals
 *   POST   /api/v1/governance/multisig/proposals/:id/approve
 *   POST   /api/v1/governance/multisig/proposals/:id/execute
 *
 * Governance endpoints (token-based voting):
 *   GET    /api/v1/governance/config
 *   GET    /api/v1/governance/proposals
 *   GET    /api/v1/governance/proposals/:id
 *   POST   /api/v1/governance/proposals
 *   POST   /api/v1/governance/proposals/:id/vote
 *   POST   /api/v1/governance/proposals/:id/queue
 *   POST   /api/v1/governance/proposals/:id/execute
 *   POST   /api/v1/governance/proposals/:id/cancel
 *   POST   /api/v1/governance/proposals/:id/emergency-execute
 *   GET    /api/v1/governance/proposals/:id/has-voted
 */

import { Router, Request, Response } from 'express';
import { adminAuthMiddleware } from './auth';
import { auditLog } from './audit-logger';
import * as proposalService from './proposal-service';
import type { ProposalAction, ProposalStatus } from './proposal-types';
import { formatAction } from './proposal-types';
import { sendError, sendErrorResponse } from '../infrastructure/error';

const ADMIN_KEY_PREFIX = process.env.ADMIN_KEY_PREFIX || 'admin_';
const router = Router();

// All governance endpoints require admin auth
router.use(adminAuthMiddleware(ADMIN_KEY_PREFIX));

// ── Helpers ──────────────────────────────────────────────────────────────────

const VALID_ACTION_VARIANTS = new Set<string>([
  'AddSource', 'RemoveSource', 'SetTrustedAsset', 'TransferAdmin',
  'SetDeviationThreshold', 'ResetReputation', 'AddSigner', 'RemoveSigner',
  'SetThreshold', 'SetAdmin', 'AddOracleSource', 'RemoveOracleSource',
  'UpdateGovernanceConfig',
]);

function validateAction(action: unknown): action is ProposalAction {
  if (!action || typeof action !== 'object') return false;
  const a = action as Record<string, unknown>;
  if (typeof a.variant !== 'string' || !VALID_ACTION_VARIANTS.has(a.variant)) return false;
  // Basic per-variant field checks
  switch (a.variant) {
    case 'SetTrustedAsset': return typeof a.asset === 'string' && typeof a.trusted === 'number';
    case 'AddSource':
    case 'AddOracleSource': return typeof a.source === 'string' && typeof a.name === 'string';
    case 'RemoveSource':
    case 'RemoveOracleSource':
    case 'ResetReputation': return typeof a.source === 'string';
    case 'SetDeviationThreshold': return typeof a.thresholdBps === 'number';
    case 'TransferAdmin':
    case 'SetAdmin': return typeof a.newAdmin === 'string';
    case 'AddSigner':
    case 'RemoveSigner': return typeof a.signer === 'string';
    case 'SetThreshold': return typeof a.threshold === 'number';
    case 'UpdateGovernanceConfig': return typeof a.config === 'object' && a.config !== null;
    default: return true;
  }
}

const VALID_STATUSES = new Set<ProposalStatus>([
  'Active', 'Queued', 'Ready', 'Executed', 'Defeated', 'Cancelled',
]);

function parseProposalStatus(value: unknown): ProposalStatus | undefined {
  return typeof value === 'string' && VALID_STATUSES.has(value as ProposalStatus)
    ? (value as ProposalStatus)
    : undefined;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'Internal error';
}

const VALID_STATUSES = new Set<ProposalStatus>([
  'Active', 'Queued', 'Ready', 'Executed', 'Defeated', 'Cancelled',
]);

function parseProposalStatus(value: unknown): ProposalStatus | undefined {
  return typeof value === 'string' && VALID_STATUSES.has(value as ProposalStatus)
    ? (value as ProposalStatus)
    : undefined;
}

function callerAddress(req: Request): string {
  // In production, the caller's Stellar address would be derived from their
  // authenticated session or provided explicitly in the request body.
  return (req.body?.caller as string) || req.apiKey?.substring(0, 16) || 'anonymous';
}

// ── Multi-sig configuration ──────────────────────────────────────────────────

router.get('/multisig/config', async (_req: Request, res: Response) => {
  try {
    const config = await proposalService.getMultiSigConfig();
    if (!config) {
      return sendErrorResponse(res, 404, 'NOT_INITIALIZED', 'Multi-sig has not been initialized', { path: '/governance/multisig/config' });
    }
    res.json({ success: true, data: config });
  } catch (err: unknown) {
    logger.error('Failed to fetch multi-sig config', err);
    errorResponse(res, 500, 'INTERNAL', messageOf(err) || 'Internal error');
  }
});

// ── Multi-sig proposals ──────────────────────────────────────────────────────

router.post('/multisig/proposals', async (req: Request, res: Response) => {
  try {
    const { action, caller } = req.body;
    if (!action) {
      return sendErrorResponse(res, 400, 'INVALID_REQUEST', '"action" is required', { path: '/governance/multisig/proposals', method: 'POST' });
    }
    if (!validateAction(action)) {
      return sendErrorResponse(res, 400, 'INVALID_ACTION', 'Invalid or unsupported proposal action', { path: '/governance/multisig/proposals', method: 'POST' });
    }

    const proposal = await proposalService.createMultiSigProposal(
      caller || callerAddress(req),
      { action },
    );

    auditLog('multisig.proposal_created', {
      apiKeyPrefix: req.apiKey?.substring(0, 8),
      details: { proposalId: proposal.id, action: formatAction(action) },
    });

    res.status(201).json({ success: true, data: proposal });
  } catch (err: unknown) {
    logger.error('Failed to create multi-sig proposal', err);
    errorResponse(res, 400, messageOf(err), messageOf(err) || 'Failed to create proposal');
  }
});

router.get('/multisig/proposals', async (req: Request, res: Response) => {
  try {
    const result = await proposalService.listMultiSigProposals({
      proposer: req.query.proposer as string | undefined,
      page: parseInt(req.query.page as string, 10) || 1,
      limit: parseInt(req.query.limit as string, 10) || 20,
    });
    res.json({ success: true, data: result });
  } catch (err: unknown) {
    logger.error('Failed to list multi-sig proposals', err);
    errorResponse(res, 500, 'INTERNAL', messageOf(err) || 'Internal error');
  }
});

router.get('/multisig/proposals/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return sendErrorResponse(res, 400, 'INVALID_ID', 'Invalid proposal id', { path: '/governance/multisig/proposals/:id', method: 'GET' });

    const proposal = await proposalService.getMultiSigProposal(id);
    if (!proposal) {
      return sendErrorResponse(res, 404, 'NOT_FOUND', `Proposal ${id} not found`, { path: '/governance/multisig/proposals/:id', method: 'GET' });
    }
    res.json({ success: true, data: proposal });
  } catch (err: unknown) {
    logger.error('Failed to fetch multi-sig proposal', err);
    errorResponse(res, 500, 'INTERNAL', messageOf(err) || 'Internal error');
  }
});

router.post('/multisig/proposals/:id/approve', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return sendErrorResponse(res, 400, 'INVALID_ID', 'Invalid proposal id', { path: '/governance/multisig/proposals/:id/approve', method: 'POST' });

    const proposal = await proposalService.approveProposal(
      req.body.caller || callerAddress(req),
      id,
    );

    auditLog('multisig.proposal_approved', {
      apiKeyPrefix: req.apiKey?.substring(0, 8),
      details: { proposalId: id, approvals: proposal.approvals.length },
    });

    res.json({ success: true, data: proposal });
  } catch (err: unknown) {
    logger.error('Failed to approve multi-sig proposal', err);
    errorResponse(res, 400, messageOf(err), messageOf(err) || 'Failed to approve');
  }
});

router.post('/multisig/proposals/:id/execute', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return sendErrorResponse(res, 400, 'INVALID_ID', 'Invalid proposal id', { path: '/governance/multisig/proposals/:id/execute', method: 'POST' });

    const proposal = await proposalService.executeMultiSigProposal(
      req.body.caller || callerAddress(req),
      id,
    );        auditLog('multisig.proposal_executed', {
      apiKeyPrefix: req.apiKey?.substring(0, 8),
      details: { proposalId: id, action: formatAction(proposal.action) },
    });

    res.json({ success: true, data: proposal });
  } catch (err: unknown) {
    logger.error('Failed to execute multi-sig proposal', err);
    errorResponse(res, 400, messageOf(err), messageOf(err) || 'Failed to execute');
  }
});

// ── Governance configuration ─────────────────────────────────────────────────

router.get('/config', async (_req: Request, res: Response) => {
  try {
    const config = await proposalService.getGovernanceConfig();
    if (!config) {
      return sendErrorResponse(res, 404, 'NOT_INITIALIZED', 'Governance has not been initialized', { path: '/governance/config', method: 'GET' });
    }
    res.json({ success: true, data: config });
  } catch (err: unknown) {
    logger.error('Failed to fetch governance config', err);
    errorResponse(res, 500, 'INTERNAL', messageOf(err) || 'Internal error');
  }
});

// ── Governance proposals ─────────────────────────────────────────────────────

router.post('/proposals', async (req: Request, res: Response) => {
  try {
    const { action, description } = req.body;
    if (!action) {
      return sendErrorResponse(res, 400, 'INVALID_REQUEST', '"action" is required', { path: '/governance/proposals', method: 'POST' });
    }
    if (!validateAction(action)) {
      return sendErrorResponse(res, 400, 'INVALID_ACTION', 'Invalid or unsupported proposal action', { path: '/governance/proposals', method: 'POST' });
    }
    if (!description || typeof description !== 'string') {
      return sendErrorResponse(res, 400, 'INVALID_REQUEST', '"description" string is required', { path: '/governance/proposals', method: 'POST' });
    }

    const proposal = await proposalService.createGovernanceProposal(
      req.body.caller || callerAddress(req),
      { action, description },
    );

    auditLog('governance.proposal_created', {
      apiKeyPrefix: req.apiKey?.substring(0, 8),
      details: { proposalId: proposal.id, description: description.substring(0, 80) },
    });

    res.status(201).json({ success: true, data: proposal });
  } catch (err: unknown) {
    logger.error('Failed to create governance proposal', err);
    errorResponse(res, 400, messageOf(err), messageOf(err) || 'Failed to create proposal');
  }
});

router.get('/proposals', async (req: Request, res: Response) => {
  try {
    const result = await proposalService.listGovernanceProposals({
      status: parseProposalStatus(req.query.status),
      proposer: req.query.proposer as string | undefined,
      page: parseInt(req.query.page as string, 10) || 1,
      limit: parseInt(req.query.limit as string, 10) || 20,
    });
    res.json({ success: true, data: result });
  } catch (err: unknown) {
    logger.error('Failed to list governance proposals', err);
    errorResponse(res, 500, 'INTERNAL', messageOf(err) || 'Internal error');
  }
});

router.get('/proposals/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return sendErrorResponse(res, 400, 'INVALID_ID', 'Invalid proposal id', { path: '/governance/proposals/:id', method: 'GET' });

    const proposal = await proposalService.getGovernanceProposal(id);
    if (!proposal) {
      return sendErrorResponse(res, 404, 'NOT_FOUND', `Proposal ${id} not found`, { path: '/governance/proposals/:id', method: 'GET' });
    }
    res.json({ success: true, data: proposal });
  } catch (err: unknown) {
    logger.error('Failed to fetch governance proposal', err);
    errorResponse(res, 500, 'INTERNAL', messageOf(err) || 'Internal error');
  }
});

router.post('/proposals/:id/vote', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return sendErrorResponse(res, 400, 'INVALID_ID', 'Invalid proposal id', { path: '/governance/proposals/:id/vote', method: 'POST' });

    const { support } = req.body;
    if (typeof support !== 'boolean') {
      return sendErrorResponse(res, 400, 'INVALID_REQUEST', '"support" (boolean) is required', { path: '/governance/proposals/:id/vote', method: 'POST' });
    }

    const proposal = await proposalService.castVote(
      req.body.caller || callerAddress(req),
      id,
      support,
    );

    auditLog('governance.vote_cast', {
      apiKeyPrefix: req.apiKey?.substring(0, 8),
      details: { proposalId: id, support, votesFor: proposal.votesFor, votesAgainst: proposal.votesAgainst },
    });

    res.json({ success: true, data: proposal });
  } catch (err: unknown) {
    logger.error('Failed to cast vote', err);
    errorResponse(res, 400, messageOf(err), messageOf(err) || 'Failed to vote');
  }
});

router.post('/proposals/:id/queue', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return sendErrorResponse(res, 400, 'INVALID_ID', 'Invalid proposal id', { path: '/governance/proposals/:id/queue', method: 'POST' });

    const proposal = await proposalService.queueProposal(id);

    res.json({ success: true, data: proposal });
  } catch (err: unknown) {
    logger.error('Failed to queue proposal', err);
    errorResponse(res, 400, messageOf(err), messageOf(err) || 'Failed to queue');
  }
});

router.post('/proposals/:id/execute', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return sendErrorResponse(res, 400, 'INVALID_ID', 'Invalid proposal id', { path: '/governance/proposals/:id/execute', method: 'POST' });

    const proposal = await proposalService.executeGovernanceProposal(id);

    auditLog('governance.proposal_executed', {
      apiKeyPrefix: req.apiKey?.substring(0, 8),
      details: { proposalId: id, action: formatAction(proposal.action) },
    });

    res.json({ success: true, data: proposal });
  } catch (err: unknown) {
    logger.error('Failed to execute governance proposal', err);
    errorResponse(res, 400, messageOf(err), messageOf(err) || 'Failed to execute');
  }
});

router.post('/proposals/:id/cancel', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return sendErrorResponse(res, 400, 'INVALID_ID', 'Invalid proposal id', { path: '/governance/proposals/:id/cancel', method: 'POST' });

    const proposal = await proposalService.cancelProposal(
      req.body.caller || callerAddress(req),
      id,
    );

    auditLog('governance.proposal_cancelled', {
      apiKeyPrefix: req.apiKey?.substring(0, 8),
      details: { proposalId: id },
    });

    res.json({ success: true, data: proposal });
  } catch (err: unknown) {
    logger.error('Failed to cancel proposal', err);
    errorResponse(res, 400, messageOf(err), messageOf(err) || 'Failed to cancel');
  }
});

router.post('/proposals/:id/emergency-execute', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return sendErrorResponse(res, 400, 'INVALID_ID', 'Invalid proposal id', { path: '/governance/proposals/:id/emergency-execute', method: 'POST' });

    const proposal = await proposalService.emergencyExecute(
      req.body.caller || callerAddress(req),
      id,
    );

    auditLog('governance.emergency_execute', {
      apiKeyPrefix: req.apiKey?.substring(0, 8),
      details: { proposalId: id, action: formatAction(proposal.action), emergency: true },
    });

    res.json({ success: true, data: proposal });
  } catch (err: unknown) {
    logger.error('Failed to emergency-execute proposal', err);
    errorResponse(res, 400, messageOf(err), messageOf(err) || 'Failed to emergency-execute');
  }
});

router.get('/proposals/:id/has-voted', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return sendErrorResponse(res, 400, 'INVALID_ID', 'Invalid proposal id', { path: '/governance/proposals/:id/has-voted', method: 'GET' });

    const voter = (req.query.voter as string) || callerAddress(req);
    const voted = await proposalService.hasVoted(id, voter);

    res.json({ success: true, data: { proposalId: id, voter: voter.substring(0, 8), hasVoted: voted } });
  } catch (err: unknown) {
    logger.error('Failed to check vote', err);
    errorResponse(res, 500, 'INTERNAL', messageOf(err) || 'Internal error');
  }
});

// ── Dashboard summary ────────────────────────────────────────────────────────

router.get('/summary', async (_req: Request, res: Response) => {
  try {
    const govConfig = await proposalService.getGovernanceConfig();
    const msigConfig = await proposalService.getMultiSigConfig();
    const govProposals = await proposalService.listGovernanceProposals({ limit: 100 });
    const msigProposals = await proposalService.listMultiSigProposals({ limit: 100 });

    const activeGov = govProposals.proposals.filter((p) => p.status === 'Active').length;
    const executedGov = govProposals.proposals.filter((p) => p.status === 'Executed').length;
    const pendingMsig = msigProposals.proposals.filter((p) => p.executed === 0).length;

    res.json({
      success: true,
      data: {
        governance: {
          initialized: !!govConfig,
          config: govConfig,
          totalProposals: govProposals.pagination.total,
          active: activeGov,
          executed: executedGov,
        },
        multisig: {
          initialized: !!msigConfig,
          config: msigConfig,
          totalProposals: msigProposals.pagination.total,
          pending: pendingMsig,
        },
        timestamp: new Date().toISOString(),
      },
    });
  } catch (err: unknown) {
    logger.error('Failed to generate governance summary', err);
    errorResponse(res, 500, 'INTERNAL', messageOf(err) || 'Internal error');
  }
});

export default router;
