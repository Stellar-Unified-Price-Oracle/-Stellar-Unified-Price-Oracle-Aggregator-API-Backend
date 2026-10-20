import { Router, type Request, type Response } from 'express';
import { z, type ZodType, type ZodTypeDef } from 'zod';
import { sendErrorResponse } from '../../infrastructure/error';
import { logger } from '../../observability/logger';
import {
  governanceSnapshotSchema,
  releaseReviewSnapshotSchema,
  treasurySnapshotSchema,
} from './schema';
import { readArtifact, TransparencyStoreError } from './store';
import { computeGovernanceHealth, DEFAULT_TRAILING_WINDOW } from './governance-health';
import { computeTreasuryReport } from './treasury';
import { computeReleaseReviewReport, RELEASE_REVIEW_POLICY } from './release-review';
import {
  recordGovernanceHealthMetrics,
  recordReleaseReviewMetrics,
  recordTreasuryMetrics,
} from './metrics';

const router = Router();

const CACHE_CONTROL = 'public, max-age=300';

const healthQuerySchema = z.object({
  trailingWindow: z.coerce.number().int().min(1).max(100).optional(),
});

const treasuryQuerySchema = z.object({
  asset: z.preprocess(
    (value) => (typeof value === 'string' ? value.trim().toUpperCase() : value),
    z
      .string()
      .regex(/^[A-Z0-9]{2,12}$/, 'must be a 2-12 character uppercase asset symbol')
      .optional(),
  ),
  since: z
    .string()
    .refine((value) => !Number.isNaN(Date.parse(value)), { message: 'must be an ISO-8601 timestamp' })
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const releaseQuerySchema = z.object({
  status: z.enum(['scheduled', 'open', 'released', 'withdrawn', 'invalid']).optional(),
  id: z.string().min(1).optional(),
});

const rehearsalArtifactSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    network: z.string().min(1),
    contractId: z.string().nullable().optional(),
    startedAt: z.string().optional(),
    finishedAt: z.string().optional(),
    summary: z
      .object({
        scenarios: z.number().int().nonnegative(),
        passed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        verdict: z.enum(['passed', 'failed']),
      })
      .passthrough(),
    scenarios: z.array(z.unknown()),
    followUps: z.array(z.string()),
  })
  .passthrough();

function parseQuery<T>(
  schema: ZodType<T, ZodTypeDef, any>,
  req: Request,
  res: Response,
): T | null {
  const result = schema.safeParse(req.query ?? {});
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'query'}: ${issue.message}`)
      .join('; ');
    sendErrorResponse(res, 400, 'INVALID_REQUEST', message, {
      path: req.path,
      method: req.method,
    });
    return null;
  }
  return result.data;
}

function handleFailure(res: Response, err: unknown, endpoint: string): void {
  if (err instanceof TransparencyStoreError) {
    const status = err.code === 'not_found' ? 404 : err.code === 'invalid' ? 422 : 500;
    const code =
      err.code === 'not_found'
        ? 'GOVERNANCE_DATA_UNAVAILABLE'
        : err.code === 'invalid'
          ? 'GOVERNANCE_DATA_INVALID'
          : 'INTERNAL';
    sendErrorResponse(res, status, code, err.message, { path: endpoint });
    return;
  }
  logger.error(`Governance transparency read failed: ${endpoint}`, err);
  sendErrorResponse(res, 500, 'INTERNAL', 'Failed to build the transparency report', {
    path: endpoint,
  });
}

// ── Governance participation and quorum health (#777) ────────────────────────

router.get('/health', (req: Request, res: Response) => {
  const query = parseQuery(healthQuerySchema, req, res);
  if (!query) return;

  try {
    const { data: snapshot } = readArtifact('governance-snapshot.json', governanceSnapshotSchema);
    const report = computeGovernanceHealth(snapshot, {
      trailingWindow: query.trailingWindow ?? DEFAULT_TRAILING_WINDOW,
    });
    recordGovernanceHealthMetrics(report);
    res.set('Cache-Control', CACHE_CONTROL);
    res.json({ success: true, data: report });
  } catch (err: unknown) {
    handleFailure(res, err, '/governance/health');
  }
});

// ── Treasury transparency and reconciliation (#781) ──────────────────────────

router.get('/treasury', (req: Request, res: Response) => {
  const query = parseQuery(treasuryQuerySchema, req, res);
  if (!query) return;

  try {
    const { data: snapshot } = readArtifact('treasury-snapshot.json', treasurySnapshotSchema);
    const report = computeTreasuryReport(snapshot);

    let data = report;
    if (query.asset) {
      const assets = report.reconciliation.assets.filter((asset) => asset.asset === query.asset);
      if (assets.length === 0) {
        sendErrorResponse(
          res,
          404,
          'TREASURY_ASSET_NOT_FOUND',
          `No treasury position is published for ${query.asset}`,
          { path: '/governance/treasury' },
        );
        return;
      }
      data = {
        ...report,
        reconciliation: { ...report.reconciliation, assets },
        policyAllocation: {
          ...report.policyAllocation,
          byAsset: report.policyAllocation.byAsset.filter((asset) => asset.asset === query.asset),
        },
      };
    }

    const sinceMs = query.since ? Date.parse(query.since) : null;
    data = {
      ...data,
      ledger: data.ledger
        .filter((row) => (sinceMs === null ? true : Date.parse(row.timestamp) >= sinceMs))
        .slice(0, query.limit),
    };

    recordTreasuryMetrics(report);
    res.set('Cache-Control', CACHE_CONTROL);
    res.json({ success: true, data });
  } catch (err: unknown) {
    handleFailure(res, err, '/governance/treasury');
  }
});

// ── Community release review windows (#779) ─────────────────────────────────

router.get('/release-windows', (req: Request, res: Response) => {
  const query = parseQuery(releaseQuerySchema, req, res);
  if (!query) return;

  try {
    const { data: snapshot } = readArtifact('release-review.json', releaseReviewSnapshotSchema);
    const report = computeReleaseReviewReport(snapshot);
    const releases = report.releases.filter((release) => {
      if (query.status && release.status !== query.status) return false;
      if (query.id && release.id !== query.id) return false;
      return true;
    });

    recordReleaseReviewMetrics(report);
    res.set('Cache-Control', CACHE_CONTROL);
    res.json({
      success: true,
      data: {
        ...report,
        feedbackChannels: RELEASE_REVIEW_POLICY.feedbackChannels,
        releases,
      },
    });
  } catch (err: unknown) {
    handleFailure(res, err, '/governance/release-windows');
  }
});

// ── Published governance rehearsal report (#780) ─────────────────────────────

router.get('/rehearsals/latest', (_req: Request, res: Response) => {
  try {
    const { data, modifiedAt } = readArtifact(
      'rehearsal-report.json',
      rehearsalArtifactSchema,
    );
    res.set('Cache-Control', CACHE_CONTROL);
    res.json({
      success: true,
      data: { ...data, source: { artifact: 'rehearsal-report.json', modifiedAt } },
    });
  } catch (err: unknown) {
    handleFailure(res, err, '/governance/rehearsals/latest');
  }
});

// ── Index of published transparency artifacts ───────────────────────────────

router.get('/transparency', (_req: Request, res: Response) => {
  res.set('Cache-Control', CACHE_CONTROL);
  res.json({
    success: true,
    data: {
      generatedAt: new Date().toISOString(),
      artifacts: [
        {
          id: 'governance-health',
          issue: 777,
          owner: 'Governance Working Group',
          cadence: 'daily (24h snapshot, stale after 36h)',
          endpoint: '/api/v1/governance/health',
          documentation: 'docs/governance/GOVERNANCE_HEALTH.md',
        },
        {
          id: 'community-release-review',
          issue: 779,
          owner: 'Release Management with the Governance Working Group',
          cadence: 'per release (window closes 24h before release)',
          endpoint: '/api/v1/governance/release-windows',
          documentation: 'docs/governance/COMMUNITY_RELEASE_REVIEW.md',
        },
        {
          id: 'governance-rehearsal',
          issue: 780,
          owner: 'Governance Working Group',
          cadence: 'quarterly plus before every contract upgrade',
          endpoint: '/api/v1/governance/rehearsals/latest',
          documentation: 'docs/governance/TESTNET_REHEARSAL.md',
        },
        {
          id: 'treasury-transparency',
          issue: 781,
          owner: 'Treasury Committee',
          cadence: 'cadence declared by the published snapshot (default 24h)',
          endpoint: '/api/v1/governance/treasury',
          documentation: 'docs/governance/TREASURY_TRANSPARENCY.md',
        },
      ],
    },
  });
});

export default router;
