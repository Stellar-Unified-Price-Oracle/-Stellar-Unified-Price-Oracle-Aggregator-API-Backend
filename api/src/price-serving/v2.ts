import { z } from 'zod';
import { Router, Request, Response } from 'express';
import { AssetQuerySchema, HistoryQuerySchema, formatValidationResponse } from './validation';
import { readAssetPrices, readPriceHistory } from './price-store';
import type { ApiPrice } from '@stellar-oracle/types';
import { HybridCache } from './cache';
import { cacheHitTotal, cacheMissTotal, lastPriceTimestamp, priceQueriesTotal } from '../observability/metrics';
import { v2Ok, v2Fail } from '../infrastructure/response';

type PriceConfidence = 'high' | 'medium' | 'low';

type EnrichedPrice = Omit<ApiPrice, 'confidence'> & {
  sourceCount: number;
  confidence: PriceConfidence;
};

function priceConfidence(price: ApiPrice): PriceConfidence {
  const n = Array.isArray(price.sources) ? price.sources.length : 1;
  if (n >= 3) return 'high';
  if (n >= 2) return 'medium';
  return 'low';
}

const router = Router();
let pricesCache: HybridCache<unknown>;

export function initializeCacheV2(cache: HybridCache<unknown>): void {
  pricesCache = cache;
}

const BATCH_MAX_ASSETS = 50;

const BatchQuerySchema = z.object({
  assets: z
    .array(
      z.string().min(1).refine(
        (val) => /^[A-Z0-9]{1,12}$/.test(val) || (val.startsWith('C') && val.length === 56),
        { message: 'Invalid asset symbol' },
      ),
    )
    .min(1, 'At least one asset required')
    .max(BATCH_MAX_ASSETS, `Maximum ${BATCH_MAX_ASSETS} assets per batch request`),
});

// v2 root — lists available endpoints in the new envelope format
router.get('/', (_req: Request, res: Response) => {
  res.json({
    name: 'Stellar Unified Price Oracle & Aggregator API',
    version: '2.0.0',
    endpoints: {
      prices: '/api/v2/prices',
      price: '/api/v2/prices/:asset',
      batchPrices: 'POST /api/v2/prices/batch',
      assets: '/api/v2/assets',
      history: '/api/v2/history/:asset',
      sources: '/api/v2/sources',
      health: '/api/v2/health',
    },
    changes: [
      'Response envelope uses `meta` instead of top-level `success`',
      'Price objects include `confidence` and `sourceCount` fields',
      'Pagination supported on /prices and /history via `cursor`',
      'Batch endpoint accepts up to 50 assets',
      'Asset metadata endpoint with filtering by status',
    ],
  });
});

router.get('/assets', async (req: Request, res: Response) => {
  const status = (req.query.status as string)?.toLowerCase();
  const cacheKey = `v2:assets:${status || 'all'}`;
  const cached = await pricesCache.get(cacheKey);
  if (cached) {
    cacheHitTotal.inc();
    return res.json(v2Ok(cached, true));
  }
  cacheMissTotal.inc();

  const prices = await readAssetPrices();
  const assets = prices.map((p) => ({
    symbol: p.asset,
    decimals: p.decimals || 8,
    sources: Array.isArray(p.sources) ? p.sources : [p.sources],
    sourceCount: Array.isArray(p.sources) ? p.sources.length : 1,
    status: 'active',
    lastUpdate: p.timestamp,
    confidence: Array.isArray(p.sources) ? (p.sources.length >= 3 ? 'high' : p.sources.length >= 2 ? 'medium' : 'low') : 'low',
  }));

  const filtered = status === 'inactive' ? [] : assets;

  const response = {
    timestamp: Math.floor(Date.now() / 1000),
    count: filtered.length,
    status: status || 'all',
    assets: filtered,
  };

  await pricesCache.set(cacheKey, response, 'sources');
  res.json(v2Ok(response));
});

// v2 prices — enhanced envelope with confidence + source count
router.get('/prices', async (req: Request, res: Response) => {
  const query = AssetQuerySchema.safeParse(req.query);
  if (!query.success) {
    return res.status(400).json(v2Fail(formatValidationResponse(query.error).error));
  }

  const cacheKey = `v2:prices:${query.data.asset || '*'}`;
  const cached = await pricesCache.get(cacheKey);
  if (cached) {
    cacheHitTotal.inc();
    return res.json(v2Ok(cached, true));
  }
  cacheMissTotal.inc();

  const prices = await readAssetPrices();
  const result = query.data.asset
    ? prices.filter((p) => p.asset === query.data.asset?.toUpperCase())
    : prices;

  for (const p of result) {
    priceQueriesTotal.inc({ asset: p.asset });
    lastPriceTimestamp.set({ asset: p.asset }, p.timestamp);
  }

  const enriched = result.map((p) => ({
    ...p,
    sourceCount: Array.isArray(p.sources) ? p.sources.length : 1,
    confidence: Array.isArray(p.sources) ? (p.sources.length >= 3 ? 'high' : p.sources.length >= 2 ? 'medium' : 'low') : 'low',
  }));

  const aggregated = {
    timestamp: Math.floor(Date.now() / 1000),
    count: enriched.length,
    prices: enriched,
  };

  await pricesCache.set(cacheKey, aggregated, 'prices');
  res.json(v2Ok(aggregated));
});

router.get('/prices/:asset', async (req: Request, res: Response) => {
  const asset = req.params.asset.toUpperCase();
  const cacheKey = `v2:price:${asset}`;
  const cached = await pricesCache.get(cacheKey);
  if (cached) {
    cacheHitTotal.inc();
    return res.json(v2Ok(cached, true));
  }
  cacheMissTotal.inc();

  const prices = await readAssetPrices();
  const price = prices.find((p) => p.asset === asset);

  if (!price) {
    return res.status(404).json(
      v2Fail({ code: 'NOT_FOUND', message: `No price data found for asset: ${asset}` }),
    );
  }

  priceQueriesTotal.inc({ asset });
  lastPriceTimestamp.set({ asset }, price.timestamp);

  const enriched = {
    ...price,
    sourceCount: Array.isArray(price.sources) ? price.sources.length : 1,
    confidence: Array.isArray(price.sources) ? (price.sources.length >= 3 ? 'high' : price.sources.length >= 2 ? 'medium' : 'low') : 'low',
  };

  await pricesCache.set(cacheKey, enriched, 'price');
  res.json(v2Ok(enriched));
});

router.get('/prices/batch', async (req: Request, res: Response) => {
  const assetsParam = req.query.assets as string;
  if (!assetsParam) {
    return res.status(400).json(
      v2Fail({
        code: 'INVALID_INPUT',
        message: 'Missing required "assets" query parameter (comma-separated)',
      }),
    );
  }

  const assets = assetsParam.split(',').map((a) => a.trim()).filter((a) => a.length > 0);
  const body = BatchQuerySchema.safeParse({ assets });
  if (!body.success) {
    return res.status(400).json(v2Fail(formatValidationResponse(body.error).error));
  }

  const { assets: validatedAssets } = body.data;
  const upperAssets = validatedAssets.map((a) => a.toUpperCase());
  const cacheKey = `v2:batch:${upperAssets.sort().join(',')}`;

  const cached = await pricesCache.get(cacheKey);
  if (cached) {
    cacheHitTotal.inc();
    return res.json(v2Ok(cached, true));
  }
  cacheMissTotal.inc();

  const allPrices = await readAssetPrices();
  const priceMap = new Map(allPrices.map((p) => [p.asset, p]));

  const results: Array<{ asset: string; price?: EnrichedPrice; error?: string }> = [];
  for (const asset of upperAssets) {
    const price = priceMap.get(asset);
    if (price) {
      priceQueriesTotal.inc({ asset });
      lastPriceTimestamp.set({ asset }, price.timestamp);
      results.push({
        asset,
        price: {
          ...price,
          sourceCount: Array.isArray(price.sources) ? price.sources.length : 1,
          confidence: priceConfidence(price),
        },
      });
    } else {
      results.push({ asset, error: 'NOT_FOUND' });
    }
  }

  const response = {
    timestamp: Math.floor(Date.now() / 1000),
    requested: upperAssets.length,
    found: results.filter((r) => r.price).length,
    results,
  };

  await pricesCache.set(cacheKey, response, 'prices');
  res.json(v2Ok(response));
});

router.post('/prices/batch', async (req: Request, res: Response) => {
  const body = BatchQuerySchema.safeParse(req.body);
  if (!body.success) {
    return res.status(400).json(v2Fail(formatValidationResponse(body.error).error));
  }

  const { assets } = body.data;
  const upperAssets = assets.map((a) => a.toUpperCase());
  const cacheKey = `v2:batch:${upperAssets.sort().join(',')}`;

  const cached = await pricesCache.get(cacheKey);
  if (cached) {
    cacheHitTotal.inc();
    return res.json(v2Ok(cached, true));
  }
  cacheMissTotal.inc();

  const allPrices = await readAssetPrices();
  const priceMap = new Map(allPrices.map((p) => [p.asset, p]));

  const results: Array<{ asset: string; price?: EnrichedPrice; error?: string }> = [];
  for (const asset of upperAssets) {
    const price = priceMap.get(asset);
    if (price) {
      priceQueriesTotal.inc({ asset });
      lastPriceTimestamp.set({ asset }, price.timestamp);
      results.push({
        asset,
        price: {
          ...price,
          sourceCount: Array.isArray(price.sources) ? price.sources.length : 1,
          confidence: priceConfidence(price),
        },
      });
    } else {
      results.push({ asset, error: 'NOT_FOUND' });
    }
  }

  const response = {
    timestamp: Math.floor(Date.now() / 1000),
    requested: upperAssets.length,
    found: results.filter((r) => r.price).length,
    results,
  };

  await pricesCache.set(cacheKey, response, 'prices');
  res.json(v2Ok(response));
});

router.get('/history/:asset', async (req: Request, res: Response) => {
  const params = HistoryQuerySchema.safeParse({ ...req.params, ...req.query });
  if (!params.success) {
    return res.status(400).json(v2Fail(formatValidationResponse(params.error).error));
  }

  const { asset, from, to, limit } = params.data;
  const cacheKey = `v2:history:${asset.toUpperCase()}:${from || 0}:${to || 0}:${limit}`;
  const cached = await pricesCache.get(cacheKey);
  if (cached) {
    cacheHitTotal.inc();
    return res.json(v2Ok(cached, true));
  }
  cacheMissTotal.inc();

  const history = await readPriceHistory(asset.toUpperCase(), from, to, limit);
  const response = {
    asset: asset.toUpperCase(),
    from: from || null,
    to: to || null,
    count: history.length,
    prices: history,
  };

  await pricesCache.set(cacheKey, response, 'history');
  res.json(v2Ok(response));
});

router.get('/sources', async (_req: Request, res: Response) => {
  const cacheKey = 'v2:sources:all';
  const cached = await pricesCache.get(cacheKey);
  if (cached) {
    cacheHitTotal.inc();
    return res.json(v2Ok(cached, true));
  }
  cacheMissTotal.inc();

  const data = {
    sources: [
      { name: 'Chainlink', active: true, type: 'off-chain', website: 'https://chain.link' },
      { name: 'Redstone', active: true, type: 'off-chain', website: 'https://redstone.finance' },
      { name: 'Band Protocol', active: true, type: 'off-chain', website: 'https://bandprotocol.com' },
      { name: 'Reflector', active: true, type: 'off-chain', website: 'https://reflector.xyz' },
    ],
  };

  await pricesCache.set(cacheKey, data, 'sources');
  res.json(v2Ok(data));
});

router.get('/health/live', (_req: Request, res: Response) => {
  res.json(v2Ok({ status: 'alive', uptime: process.uptime() }));
});

router.get('/health/ready', async (_req: Request, res: Response) => {
  const prices = await readAssetPrices();
  const ready = prices.length > 0;
  res.status(ready ? 200 : 503).json({
    meta: { version: '2', success: ready },
    data: { status: ready ? 'ready' : 'not_ready', assetsTracked: prices.length },
  });
});

router.get('/health', async (req: Request, res: Response) => {
  const verbose = req.query.verbose === 'true';
  const cacheKey = `v2:health:status:${verbose}`;
  const cached = await pricesCache.get(cacheKey);
  if (cached) {
    cacheHitTotal.inc();
    return res.json({ meta: { version: '2', success: true, cached: true }, data: cached });
  }
  cacheMissTotal.inc();

  const prices = await readAssetPrices();
  const hasStale = prices.some((p) => Date.now() / 1000 - p.timestamp > 120);
  const status = prices.length === 0 ? 'unhealthy' : hasStale ? 'degraded' : 'healthy';

  const data: Record<string, unknown> = {
    service: 'stellar-price-oracle-api',
    version: '2',
    status,
    uptime: process.uptime(),
    timestamp: Math.floor(Date.now() / 1000),
    assetsTracked: prices.length,
    degradedAssets: prices.filter((p) => Date.now() / 1000 - p.timestamp > 120).map((p) => p.asset),
  };

  if (verbose) {
    data.prices = prices.map((p) => ({
      asset: p.asset,
      timestamp: p.timestamp,
      sources: p.sources,
      stale: Date.now() / 1000 - p.timestamp > 120,
    }));
    data.processMemoryMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    data.nodeVersion = process.version;
  }

  await pricesCache.set(cacheKey, data, 'health');
  res.status(status === 'unhealthy' ? 503 : 200).json({ meta: { version: '2', success: status !== 'unhealthy' }, data });
});

export default router;
