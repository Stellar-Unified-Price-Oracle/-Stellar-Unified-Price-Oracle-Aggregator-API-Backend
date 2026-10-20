import { z } from 'zod';
import { Router, Request, Response } from 'express';
import { exportUsage, recordUsageEvent } from './store';
import { authMiddleware } from '../../governance/auth';
import { v2Ok, v2Fail } from '../../infrastructure/response';

const router = Router();

// Usage export requires authentication so each consumer can only export
// their own (tenant-scoped) usage — never cross-tenant data.
router.use(authMiddleware);

const UsageExportQuerySchema = z.object({
  from: z.coerce.number().int().positive().optional().describe('Window start, Unix seconds'),
  to: z.coerce.number().int().positive().optional().describe('Window end, Unix seconds'),
  format: z.enum(['json', 'csv']).default('json').describe('Export format'),
});

// GET /consumer/usage/export — privacy-safe usage export (#716)
// Returns only the authenticated caller's usage, keyed by their API key prefix.
router.get('/', async (req: Request, res: Response) => {
  const parsed = UsageExportQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json(v2Fail({ code: 'VALIDATION_ERROR', message: 'Invalid query parameters' }));
  }

  const { from, to, format } = parsed.data;
  const apiKey = req.apiKey;
  if (!apiKey) {
    return res.status(401).json(v2Fail({ code: 'MISSING_API_KEY', message: 'API key required' }));
  }

  const keyPrefix = apiKey.substring(0, 8);
  const exported = exportUsage(keyPrefix, from, to);

  const windowStart = from ?? Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
  const windowEnd = to ?? Math.floor(Date.now() / 1000);

  if (format === 'csv') {
    const lines = ['endpoint,method,asset,status,timestamp'];
    for (const r of exported.records) {
      lines.push([r.endpoint, r.method, r.asset ?? '', r.status, r.timestamp].join(','));
    }
    res.set('Content-Type', 'text/csv');
    res.set('Content-Disposition', `attachment; filename="usage-export-${keyPrefix}.csv"`);
    return res.send(lines.join('\n'));
  }

  return res.json(
    v2Ok({
      keyPrefix,
      windowStart,
      windowEnd,
      totalRequests: exported.totalRequests,
      byEndpoint: exported.byEndpoint,
      byAsset: exported.byAsset,
      byStatus: exported.byStatus,
      records: exported.records,
      generatedAt: Math.floor(Date.now() / 1000),
      privacyNote:
        'This export contains only the authenticated caller\'s usage. ' +
        'No cross-tenant data is included. Stable billing dimensions: endpoint, method, asset, status, timestamp.',
    }),
  );
});

/** Record a usage event for the current request (called by usage-tracking middleware). */
export function recordUsage(req: Request, res: Response, next: () => void): void {
  res.on('finish', () => {
    const apiKey = req.apiKey;
    if (!apiKey) return;
    const asset =
      (req.params && (req.params.asset as string | undefined)) ||
      (typeof req.query.asset === 'string' ? req.query.asset : undefined);
    recordUsageEvent({
      endpoint: req.route ? req.baseUrl + req.route.path : req.path,
      method: req.method,
      apiKeyPrefix: apiKey.substring(0, 8),
      asset: asset ? asset.toUpperCase() : undefined,
      status: res.statusCode,
      timestamp: Date.now(),
    });
  });
  next();
}

export default router;