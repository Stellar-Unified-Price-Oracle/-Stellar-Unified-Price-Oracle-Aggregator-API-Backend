import { z } from 'zod';
import { Router, Request, Response } from 'express';
import {
  recordLatencySample,
  consumerRegion,
  computeFeedStats,
} from './store';
import { v2Ok, v2Fail } from '../../infrastructure/response';
import { logger } from '../../observability/logger';

const router = Router();

const LatencyFreshnessQuerySchema = z.object({
  asset: z.string().trim().min(1).optional().describe('Asset symbol (e.g. XLM)'),
  region: z.string().trim().min(1).optional().describe('Consumer region (e.g. us-east, eu-west)'),
  from: z.coerce.number().int().positive().optional().describe('Window start, Unix seconds'),
  to: z.coerce.number().int().positive().optional().describe('Window end, Unix seconds'),
  window: z
    .enum(['1h', '24h', '7d', '30d'])
    .default('24h')
    .describe('Default sample window when from/to are omitted'),
});

function windowSeconds(window: string): number {
  switch (window) {
    case '1h': return 60 * 60;
    case '7d': return 7 * 24 * 60 * 60;
    case '30d': return 30 * 24 * 60 * 60;
    case '24h':
    default: return 24 * 60 * 60;
  }
}

// GET /consumer/latency-freshness — feed latency & freshness explorer (#715)
// Public (no auth): consumers can inspect delivery quality of any feed.
router.get('/', async (req: Request, res: Response) => {
  const parsed = LatencyFreshnessQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json(v2Fail({ code: 'VALIDATION_ERROR', message: 'Invalid query parameters' }));
  }

  const { asset, region, from, to, window } = parsed.data;
  const regionValue = consumerRegion(region, undefined);

  let windowStart: number | undefined;
  let windowEnd: number | undefined;
  if (from !== undefined && to !== undefined) {
    windowStart = from;
    windowEnd = to;
  } else if (from !== undefined) {
    windowStart = from;
    windowEnd = Math.floor(Date.now() / 1000);
  } else {
    const now = Math.floor(Date.now() / 1000);
    windowStart = now - windowSeconds(window);
    windowEnd = now;
  }

  const stats = computeFeedStats(asset, regionValue, windowStart, windowEnd);

  return res.json(
    v2Ok({
      window: { start: windowStart, end: windowEnd, window },
      feeds: stats,
      sampleNote:
        'Samples are recorded on each price response served by this API. ' +
        'Empty result means no price responses matched the filters in the window.',
    }),
  );
});

/** Middleware factory: record a latency + freshness sample on price responses. */
export function latencyFreshnessMiddleware() {
  return async (req: Request, res: Response, next: () => void): Promise<void> => {
    const originalJson = res.json.bind(res);
    res.json = function (body: unknown) {
      try {
        const asset =
          (req.params && (req.params.asset as string | undefined)) ||
          (typeof req.query.asset === 'string' ? req.query.asset : undefined);
        const region = consumerRegion(req.headers['x-region'] as string | undefined, req.query.region as string | undefined);
        const deliveredAt = Math.floor(Date.now() / 1000);

        if (asset && body && typeof body === 'object' && !Array.isArray(body)) {
          const obj = body as Record<string, unknown>;
          const data = obj.data ?? obj;
          if (data && typeof data === 'object' && 'timestamp' in data) {
            const priceTimestamp = Number(data.timestamp);
            const observedAt =
              data.observedAt !== undefined ? Number(data.observedAt) : priceTimestamp;
            const sources = Array.isArray(data.sources) ? data.sources : undefined;
            const source = sources?.[0];

            recordLatencySample({
              asset: String(asset),
              region,
              observedAt: Number.isFinite(observedAt) ? observedAt : priceTimestamp,
              deliveredAt,
              latencyMs: Math.max(0, deliveredAt * 1000 - observedAt * 1000),
              freshnessMs: Math.max(0, deliveredAt * 1000 - priceTimestamp * 1000),
              source: source as string,
            });
          } else if (Array.isArray(data?.prices)) {
            for (const entry of data.prices) {
              if (entry && typeof entry === 'object' && 'timestamp' in entry) {
                const priceTimestamp = Number((entry as Record<string, unknown>).timestamp);
                const observedAt =
                  (entry as Record<string, unknown>).observedAt !== undefined
                    ? Number((entry as Record<string, unknown>).observedAt)
                    : priceTimestamp;
                recordLatencySample({
                  asset: String(asset),
                  region,
                  observedAt: Number.isFinite(observedAt) ? observedAt : priceTimestamp,
                  deliveredAt,
                  latencyMs: Math.max(0, deliveredAt * 1000 - observedAt * 1000),
                  freshnessMs: Math.max(0, deliveredAt * 1000 - priceTimestamp * 1000),
                });
              }
            }
          }
        }
      } catch (err) {
        logger.debug('Latency sample recording skipped', { message: String(err) });
      }
      return originalJson(body);
    } as unknown as typeof res.json;
    next();
  };
}

export default router;